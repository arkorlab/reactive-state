import {
  type BindingName,
  type Block,
  type Expression,
  type ForInitializer,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isComputedPropertyName,
  isExpressionStatement,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  type ObjectLiteralElementLike,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, parametersOf } from './answers.ts';
import { readsOf } from './local-module-reads.ts';
import { arrayChangedBefore } from './proxy-arrays.ts';
import {
  bindsHoistedName,
  hoistedParameterOrigins,
  nodeAssignedOrigins,
} from './proxy-parameter-patterns.ts';
import {
  heldConstant,
  type Origin,
  peeled,
  propertyKey,
  type ProxyReading,
  writtenBefore,
} from './proxy-values.ts';
import { isBlockScoped, isTypeOnly, withinFunction } from './scope.ts';

export { bindsHoistedName } from './proxy-parameter-patterns.ts';

interface ParameterTarget {
  readonly isRead: (node: Node) => node is Identifier;
  readonly reading: ProxyReading;
  readonly text: string;
}

/** Assignment operators whose right-hand expression can become the target binding's value. */
const VALUE_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Memoized superset of identifier names targeted by `var`, assignments, or loop heads in a subtree. */
const WRITTEN_NAMES = new WeakMap<Node, ReadonlySet<string>>();

/** Memoized `readsOf(declared, fn)` predicates keyed by parameter declaration identifier. */
const PARAMETER_READS = new WeakMap<Identifier, (node: Node) => node is Identifier>();

/** Whether `declared` is unconditionally reassigned on every path before `name` executes. */
export function definitelyReassignedBefore(
  fn: Answering,
  declared: Identifier,
  name: Identifier,
  reading: ProxyReading,
): boolean {
  if (
    fn.body === undefined ||
    !isBlock(fn.body) ||
    !writtenNamesIn(fn.body).has(declared.text) ||
    withinFunction(name, fn)
  ) {
    return false;
  }
  const target: ParameterTarget = {
    isRead: cachedParameterReads(declared, fn),
    reading,
    text: declared.text,
  };
  for (let child: Node = name; child !== fn; child = child.parent) {
    const { parent } = child;
    if (isBlock(parent) && blockReassignsBefore(parent, child, target)) {
      return true;
    }
    if (
      isForStatement(parent) &&
      (parent.initializer?.pos !== child.pos || parent.initializer.end !== child.end) &&
      forInitializerReassigns(parent.initializer, target)
    ) {
      return true;
    }
    if (
      (isForOfStatement(parent) || isForInStatement(parent)) &&
      child === parent.statement &&
      loopHeadBinds(parent.initializer, target)
    ) {
      return true;
    }
  }
  return false;
}

/** Origin contexts and lazy bypassed-initializer check for `assignedParameterOrigins`. */
export interface ParameterWriteScan {
  readonly bodyAt: Origin;
  readonly defaultAt: Origin;
  readonly isBypassed?: ((index: number) => boolean) | undefined;
}

/** Collects candidate origins written into `declared` across parameter defaults, `var`s, and body. */
export function assignedParameterOrigins(
  fn: Answering,
  declared: Identifier,
  scan: ParameterWriteScan,
): readonly Origin[] {
  if (!writtenNamesIn(fn).has(declared.text)) {
    return [];
  }
  const isRead = cachedParameterReads(declared, fn);
  const found: Origin[] =
    fn.body === undefined ? [] : [...hoistedParameterOrigins(fn.body, declared.text, scan.bodyAt)];
  const visitWith = (origin: Origin) => {
    const visit = (node: Node): void => {
      if (isTypeOnly(node) || !writtenNamesIn(node).has(declared.text)) {
        return;
      }
      found.push(...nodeAssignedOrigins(node, isRead, origin));
      node.forEachChild(visit);
    };
    return visit;
  };
  const visitDefault = visitWith(scan.defaultAt);
  for (const [index, parameter] of parametersOf(fn).entries()) {
    visitDefault(parameter.name);
    if (
      parameter.initializer !== undefined &&
      writtenNamesIn(parameter.initializer).has(declared.text) &&
      scan.isBypassed?.(index) !== true
    ) {
      visitDefault(parameter.initializer);
    }
  }
  if (fn.body !== undefined) {
    visitWith(scan.bodyAt)(fn.body);
  }
  return found;
}

/** Returns a memoized `readsOf(declared, fn)` predicate for parameter `declared`. */
export function cachedParameterReads(
  declared: Identifier,
  fn: Answering,
): (node: Node) => node is Identifier {
  let predicate = PARAMETER_READS.get(declared);
  if (predicate === undefined) {
    predicate = readsOf(declared, fn);
    PARAMETER_READS.set(declared, predicate);
  }
  return predicate;
}

/** Computes and memoizes all identifier texts written by `var`, assignments, or loop heads in `node`. */
function writtenNamesIn(node: Node): ReadonlySet<string> {
  const cached = WRITTEN_NAMES.get(node);
  if (cached !== undefined) {
    return cached;
  }
  if (isTypeOnly(node)) {
    const empty = new Set<string>();
    WRITTEN_NAMES.set(node, empty);
    return empty;
  }
  const names = new Set<string>();
  addDirectWrittenNames(node, names);
  node.forEachChild((child) => {
    for (const text of writtenNamesIn(child)) {
      names.add(text);
    }
  });
  WRITTEN_NAMES.set(node, names);
  return names;
}

/** Adds identifier names directly bound or assigned at `node` (without recursing into children). */
function addDirectWrittenNames(node: Node, out: Set<string>): void {
  if (isVariableDeclarationList(node) && !isBlockScoped(node)) {
    for (const declaration of node.declarations) {
      collectBindingNameTexts(declaration.name, out);
    }
    return;
  }
  if (isBinaryExpression(node) && VALUE_ASSIGNMENTS.has(node.operatorToken.kind)) {
    collectTargetTexts(node.left, out);
    return;
  }
  if ((isForOfStatement(node) || isForInStatement(node)) && isExpression(node.initializer)) {
    collectTargetTexts(node.initializer, out);
  }
}

/** Collects all identifier texts declared inside `name`. */
function collectBindingNameTexts(name: BindingName | undefined, out: Set<string>): void {
  if (name === undefined) {
    return;
  }
  if (isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  if (isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (!isOmittedExpression(element)) {
        collectBindingNameTexts(element.name, out);
      }
    }
    return;
  }
  for (const element of name.elements) {
    collectBindingNameTexts(element.name, out);
  }
}

/** Collects identifier texts in destructuring or simple assignment target positions of `target`. */
function collectTargetTexts(target: Expression, out: Set<string>): void {
  const pending: Expression[] = [target];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = peeled(next);
    if (isIdentifier(current)) {
      out.add(current.text);
    } else if (
      isBinaryExpression(current) &&
      current.operatorToken.kind === SyntaxKind.EqualsToken
    ) {
      pending.push(current.left);
    } else if (isArrayLiteralExpression(current)) {
      pushArrayTargetElements(current.elements, pending);
    } else if (isObjectLiteralExpression(current)) {
      pushObjectTargetProperties(current.properties, out, pending);
    }
  }
}

/** Queues non-omitted array destructuring target elements onto `pending`. */
function pushArrayTargetElements(elements: readonly Expression[], pending: Expression[]): void {
  for (const element of elements) {
    if (!isOmittedExpression(element)) {
      pending.push(isSpreadElement(element) ? element.expression : element);
    }
  }
}

/** Records shorthand target names and queues nested object destructuring targets onto `pending`. */
function pushObjectTargetProperties(
  properties: readonly ObjectLiteralElementLike[],
  out: Set<string>,
  pending: Expression[],
): void {
  for (const property of properties) {
    if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      out.add(property.name.text);
    } else if (isPropertyAssignment(property)) {
      pending.push(property.initializer);
    } else if (isSpreadAssignment(property)) {
      pending.push(property.expression);
    }
  }
}

/** Checks earlier statements in `block` before `stop` for an unconditional write to `target`. */
function blockReassignsBefore(block: Block, stop: Node, target: ParameterTarget): boolean {
  for (const statement of block.statements) {
    if (statement === stop || statement.end > stop.pos) {
      break;
    }
    if (statementReassigns(statement, target)) {
      return true;
    }
  }
  return false;
}

/** Checks whether completing `statement` normally guarantees an assignment to `target`. */
function statementReassigns(statement: Statement, target: ParameterTarget): boolean {
  if (isVariableStatement(statement)) {
    return (
      !isBlockScoped(statement.declarationList) &&
      statement.declarationList.declarations.some(
        (each) => each.initializer !== undefined && bindsHoistedName(each.name, target.text),
      )
    );
  }
  if (isExpressionStatement(statement)) {
    return expressionReassigns(statement.expression, target.isRead);
  }
  if (isForStatement(statement)) {
    return forInitializerReassigns(statement.initializer, target);
  }
  if (isForOfStatement(statement)) {
    return (
      statement.awaitModifier === undefined &&
      loopHeadBinds(statement.initializer, target) &&
      isNonEmptyIterable(statement.expression, target.reading)
    );
  }
  return (
    isForInStatement(statement) &&
    loopHeadBinds(statement.initializer, target) &&
    hasEnumerableOwnKey(statement.expression, target.reading)
  );
}

/** Checks whether a C-style `for` initializer unconditionally assigns `target`. */
function forInitializerReassigns(
  initializer: ForInitializer | undefined,
  target: ParameterTarget,
): boolean {
  if (initializer === undefined) {
    return false;
  }
  if (isVariableDeclarationList(initializer)) {
    return (
      !isBlockScoped(initializer) &&
      initializer.declarations.some(
        (each) => each.initializer !== undefined && bindsHoistedName(each.name, target.text),
      )
    );
  }
  return isExpression(initializer) && expressionReassigns(initializer, target.isRead);
}

/** Checks whether a `for..of` or `for..in` loop header assigns `target` on each iteration. */
function loopHeadBinds(initializer: ForInitializer, target: ParameterTarget): boolean {
  if (isVariableDeclarationList(initializer)) {
    return (
      !isBlockScoped(initializer) &&
      initializer.declarations.some((each) => bindsHoistedName(each.name, target.text))
    );
  }
  return isExpression(initializer) && unconditionallyBindsPattern(initializer, target.isRead);
}

/** Checks whether `expr` unconditionally assigns `isRead` through `=` or comma operands. */
function expressionReassigns(
  expr: Expression,
  isRead: (node: Node) => node is Identifier,
): boolean {
  const pending: Expression[] = [expr];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = peeled(next);
    if (!isBinaryExpression(current)) {
      continue;
    }
    if (current.operatorToken.kind === SyntaxKind.CommaToken) {
      pending.push(current.left, current.right);
      continue;
    }
    if (
      current.operatorToken.kind === SyntaxKind.EqualsToken &&
      unconditionallyBindsPattern(current.left, isRead)
    ) {
      return true;
    }
  }
  return false;
}

/** Checks whether an assignment target or destructuring pattern unconditionally binds `isRead`. */
function unconditionallyBindsPattern(
  pattern: Expression,
  isRead: (node: Node) => node is Identifier,
): boolean {
  let current = peeled(pattern);
  while (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    current = peeled(current.left);
  }
  if (isIdentifier(current)) {
    return isRead(current);
  }
  if (isArrayLiteralExpression(current)) {
    return current.elements.some((element) => {
      return (
        !isOmittedExpression(element) &&
        unconditionallyBindsPattern(isSpreadElement(element) ? element.expression : element, isRead)
      );
    });
  }
  return (
    isObjectLiteralExpression(current) &&
    current.properties.some((property) => objectPropertyBinds(property, isRead))
  );
}

/** Checks whether one object-destructuring property unconditionally binds `isRead`. */
function objectPropertyBinds(
  property: ObjectLiteralElementLike,
  isRead: (node: Node) => node is Identifier,
): boolean {
  if (isShorthandPropertyAssignment(property)) {
    return isRead(property.name);
  }
  if (isPropertyAssignment(property)) {
    return unconditionallyBindsPattern(property.initializer, isRead);
  }
  return isSpreadAssignment(property) && unconditionallyBindsPattern(property.expression, isRead);
}

/** Checks whether `expr` is statically proven to yield at least one `for..of` iteration. */
function isNonEmptyIterable(expr: Expression, reading: ProxyReading): boolean {
  const direct = peeled(expr);
  if (isArrayLiteralExpression(direct)) {
    return direct.elements.some((element) => !isSpreadElement(element));
  }
  if (isStringLiteral(direct) || isNoSubstitutionTemplateLiteral(direct)) {
    return direct.text.length > 0;
  }
  if (!isIdentifier(direct) || arrayChangedBefore(direct, reading)) {
    return false;
  }
  const held = heldConstant(direct, reading);
  const resolved = held === undefined ? undefined : peeled(held);
  return (
    resolved !== undefined &&
    isArrayLiteralExpression(resolved) &&
    resolved.elements.some((element) => !isSpreadElement(element))
  );
}

/** Checks whether `expr` is an unmutated object literal with at least one enumerable own key. */
function hasEnumerableOwnKey(expr: Expression, reading: ProxyReading): boolean {
  const direct = peeled(expr);
  const literal =
    isIdentifier(direct) && !writtenBefore(direct, reading)
      ? heldConstant(direct, reading)
      : direct;
  const resolved = literal === undefined ? undefined : peeled(literal);
  if (resolved === undefined || !isObjectLiteralExpression(resolved)) {
    return false;
  }
  return resolved.properties.some((property) => {
    if (isSpreadAssignment(property) || isSetAccessorDeclaration(property)) {
      return false;
    }
    const key = propertyKey(property.name, reading);
    return key !== undefined && (isComputedPropertyName(property.name) || key !== '__proto__');
  });
}
