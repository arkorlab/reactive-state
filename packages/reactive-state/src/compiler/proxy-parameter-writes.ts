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

import type { Answering } from './answers.ts';
import { unwrapped } from './bounded.ts';
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
      child !== parent.initializer &&
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

/** Collects all candidate origins written into `declared` across assignments, `var`s, and loops. */
export function assignedParameterOrigins(
  fn: Answering,
  declared: Identifier,
  at: Origin,
): readonly Origin[] {
  if (fn.body === undefined || !writtenNamesIn(fn.body).has(declared.text)) {
    return [];
  }
  const isRead = cachedParameterReads(declared, fn);
  const found: Origin[] = [...hoistedParameterOrigins(fn.body, declared.text, at)];
  const visit = (node: Node): void => {
    if (isTypeOnly(node) || !writtenNamesIn(node).has(declared.text)) {
      return;
    }
    found.push(...nodeAssignedOrigins(node, isRead, at));
    node.forEachChild(visit);
  };
  visit(fn.body);
  return found;
}

/** Returns a memoized `readsOf(declared, fn)` predicate for parameter `declared`. */
function cachedParameterReads(
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
  if (
    (isForOfStatement(node) || isForInStatement(node)) &&
    !isVariableDeclarationList(node.initializer)
  ) {
    collectTargetTexts(node.initializer, out);
  }
}

/** Collects all identifier texts declared inside `name`. */
function collectBindingNameTexts(name: BindingName, out: Set<string>): void {
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
  const current = unwrapped(target);
  if (isIdentifier(current)) {
    out.add(current.text);
    return;
  }
  if (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    collectTargetTexts(current.left, out);
    return;
  }
  if (isArrayLiteralExpression(current)) {
    for (const element of current.elements) {
      if (!isOmittedExpression(element)) {
        collectTargetTexts(isSpreadElement(element) ? element.expression : element, out);
      }
    }
    return;
  }
  if (!isObjectLiteralExpression(current)) {
    return;
  }
  for (const property of current.properties) {
    if (isShorthandPropertyAssignment(property)) {
      out.add(property.name.text);
    } else if (isPropertyAssignment(property)) {
      collectTargetTexts(property.initializer, out);
    } else if (isSpreadAssignment(property)) {
      collectTargetTexts(property.expression, out);
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
  return expressionReassigns(initializer, target.isRead);
}

/** Checks whether a `for..of` or `for..in` loop header assigns `target` on each iteration. */
function loopHeadBinds(initializer: ForInitializer, target: ParameterTarget): boolean {
  if (isVariableDeclarationList(initializer)) {
    return (
      !isBlockScoped(initializer) &&
      initializer.declarations.some((each) => bindsHoistedName(each.name, target.text))
    );
  }
  return unconditionallyBindsPattern(initializer, target.isRead);
}

/** Checks whether `expr` unconditionally assigns `isRead` through `=` or comma operands. */
function expressionReassigns(
  expr: Expression,
  isRead: (node: Node) => node is Identifier,
): boolean {
  const current = unwrapped(expr);
  if (!isBinaryExpression(current)) {
    return false;
  }
  if (current.operatorToken.kind === SyntaxKind.CommaToken) {
    return expressionReassigns(current.left, isRead) || expressionReassigns(current.right, isRead);
  }
  return (
    current.operatorToken.kind === SyntaxKind.EqualsToken &&
    unconditionallyBindsPattern(current.left, isRead)
  );
}

/** Checks whether an assignment target or destructuring pattern unconditionally binds `isRead`. */
function unconditionallyBindsPattern(
  pattern: Expression,
  isRead: (node: Node) => node is Identifier,
): boolean {
  const current = unwrapped(pattern);
  if (isIdentifier(current)) {
    return isRead(current);
  }
  if (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    return unconditionallyBindsPattern(current.left, isRead);
  }
  if (isArrayLiteralExpression(current)) {
    return current.elements.some(
      (element) =>
        !isOmittedExpression(element) &&
        unconditionallyBindsPattern(
          isSpreadElement(element) ? element.expression : element,
          isRead,
        ),
    );
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
  const direct = unwrapped(expr);
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
  const resolved = held === undefined ? undefined : unwrapped(held);
  return (
    resolved !== undefined &&
    isArrayLiteralExpression(resolved) &&
    resolved.elements.some((element) => !isSpreadElement(element))
  );
}

/** Checks whether `expr` is an unmutated object literal with at least one enumerable own key. */
function hasEnumerableOwnKey(expr: Expression, reading: ProxyReading): boolean {
  const direct = unwrapped(expr);
  const literal =
    isIdentifier(direct) && !writtenBefore(direct, reading)
      ? heldConstant(direct, reading)
      : direct;
  const resolved = literal === undefined ? undefined : unwrapped(literal);
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
