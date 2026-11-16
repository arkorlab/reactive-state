import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyAssignment,
  type PropertyName,
  type SpreadAssignment,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { assignmentPatternDefault, iteratedFrameSources } from './framed-assignment-patterns.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly } from './scope.ts';

/** Projected destructuring reassignments and held member-path unfolding for multipart checks. */

export interface PatternReassignmentScan {
  readonly ambiguous: boolean;
  readonly extraSources: readonly Held[];
}

export interface HeldResolution {
  readonly expressions: readonly Expression[];
  readonly typedFormData: boolean;
}

export interface ProjectionCallbacks {
  readonly bindingDefaults: (
    name: Identifier,
    root: ParameterDeclaration['name'],
  ) => readonly Expression[];
  readonly readParameter: (
    name: Identifier,
    parameter: ParameterDeclaration,
  ) => {
    readonly ambiguous?: boolean;
    readonly replaced: boolean;
    readonly sources: readonly Held[];
  };
  readonly isTypedFormData: (
    raw: Expression,
    value: Expression,
    keys: readonly string[],
  ) => boolean;
  readonly selectValues: (value: Expression) => readonly Expression[] | undefined;
}

interface TargetParameter {
  readonly name: Identifier;
  readonly parameter: ParameterDeclaration;
  readonly reaches: (change: Node) => boolean;
}

interface PatternStep {
  readonly sources: readonly Held[];
  readonly target: Expression;
}

interface ScanAccumulator {
  readonly extraSources: Held[];
  matched: boolean;
  readonly pending: PatternStep[];
}

const BODY_KEY = 'body';
const NO_REASSIGNMENT: PatternReassignmentScan = { ambiguous: false, extraSources: [] };

const DIRECT_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

const UPDATE_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.MinusMinusToken,
  SyntaxKind.PlusPlusToken,
]);

/** Scans reachable pattern, loop, and update writes targeting `parameter` for ambiguity and rest/computed sources. */
export function patternParameterReassignments(
  name: Identifier,
  parameter: ParameterDeclaration,
  reaches: (change: Node) => boolean,
): PatternReassignmentScan {
  const target: TargetParameter = { name, parameter, reaches };
  const extraSources: Held[] = [];
  let ambiguous = false;
  const pending: Node[] = [name.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    const site = scanReassignmentSite(node, target);
    if (site.ambiguous) {
      ambiguous = true;
    }
    extraSources.push(...site.extraSources);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return { ambiguous, extraSources };
}

/** Evaluates one AST write site against `target` when it is not a plain identifier assignment. */
function scanReassignmentSite(node: Node, target: TargetParameter): PatternReassignmentScan {
  if (
    isBinaryExpression(node) &&
    DIRECT_WRITES.has(node.operatorToken.kind) &&
    !assignmentPatternDefault(node)
  ) {
    if (isIdentifier(unwrapped(node.left)) || !target.reaches(node)) {
      return NO_REASSIGNMENT;
    }
    return scanDestructuringTarget(node.left, [{ keys: [], value: node.right }], target);
  }
  if ((isForOfStatement(node) || isForInStatement(node)) && isExpression(node.initializer)) {
    return scanLoopWrite(node, node.initializer, target);
  }
  if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    UPDATE_OPERATORS.has(node.operator) &&
    target.reaches(node)
  ) {
    return { ambiguous: targetsParameter(node.operand, target), extraSources: [] };
  }
  return NO_REASSIGNMENT;
}

/** Evaluates `for-of` and `for-in` assignment targets against `target`. */
function scanLoopWrite(
  loop: Node,
  initializer: Expression,
  target: TargetParameter,
): PatternReassignmentScan {
  if (!target.reaches(loop)) {
    return NO_REASSIGNMENT;
  }
  if (isForOfStatement(loop) && !isIdentifier(unwrapped(initializer))) {
    return scanDestructuringTarget(initializer, iteratedFrameSources(loop.expression), target);
  }
  return { ambiguous: targetsParameter(initializer, target), extraSources: [] };
}

/** Walks a destructuring LHS pattern to detect writes to `target` and collect rest/computed RHS sources. */
function scanDestructuringTarget(
  rootTarget: Expression,
  rootSources: readonly Held[],
  target: TargetParameter,
): PatternReassignmentScan {
  const acc: ScanAccumulator = {
    extraSources: [],
    matched: false,
    pending: [{ sources: rootSources, target: rootTarget }],
  };
  for (let step = acc.pending.pop(); step !== undefined; step = acc.pending.pop()) {
    const current = unwrapped(step.target);
    if (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
      acc.pending.push({
        sources: [...step.sources, { keys: [], value: current.right }],
        target: current.left,
      });
    } else if (isIdentifier(current)) {
      if (matchesParameter(current, target)) {
        acc.matched = true;
      }
    } else if (isObjectLiteralExpression(current)) {
      stepObjectTarget(current, step.sources, target, acc);
    } else if (isArrayLiteralExpression(current)) {
      stepArrayTarget(current, step.sources, target, acc);
    }
  }
  return { ambiguous: acc.matched, extraSources: acc.extraSources };
}

/** Steps object destructuring properties, recording rest copies unless `body` is statically excluded. */
function stepObjectTarget(
  object: ObjectLiteralExpression,
  sources: readonly Held[],
  target: TargetParameter,
  acc: ScanAccumulator,
): void {
  const excludedKeys = new Set<string>();
  const context = { excludedKeys, sources };
  for (const property of object.properties) {
    if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      excludedKeys.add(property.name.text);
      if (matchesParameter(property.name, target)) {
        acc.matched = true;
      }
    } else if (isPropertyAssignment(property)) {
      stepObjectPropertyTarget(property, context, target, acc);
    } else if (isSpreadAssignment(property)) {
      stepObjectSpreadTarget(property, context, target, acc);
    }
  }
}

/** Handles an object rest assignment target (`...options`). */
function stepObjectSpreadTarget(
  property: SpreadAssignment,
  context: { readonly excludedKeys: ReadonlySet<string>; readonly sources: readonly Held[] },
  target: TargetParameter,
  acc: ScanAccumulator,
): void {
  const restTarget = unwrapped(property.expression);
  if (isIdentifier(restTarget) && matchesParameter(restTarget, target)) {
    acc.matched = true;
    if (!context.excludedKeys.has(BODY_KEY)) {
      acc.extraSources.push(...context.sources);
    }
    return;
  }
  acc.pending.push({ sources: [], target: restTarget });
}

/** Handles one keyed or computed object destructuring property assignment. */
function stepObjectPropertyTarget(
  property: PropertyAssignment,
  context: { readonly excludedKeys: Set<string>; readonly sources: readonly Held[] },
  target: TargetParameter,
  acc: ScanAccumulator,
): void {
  const subTarget = property.initializer;
  const key = staticPropertyName(property.name);
  if (key !== undefined) {
    context.excludedKeys.add(key);
    acc.pending.push({
      sources: context.sources.map((each) => ({ keys: [...each.keys, key], value: each.value })),
      target: subTarget,
    });
    return;
  }
  if (!targetsParameter(subTarget, target)) {
    return;
  }
  acc.matched = true;
  const dynamicValues = dynamicObjectValues(context.sources);
  const leaf = stripDefaultTarget(subTarget);
  if (isIdentifier(leaf) && matchesParameter(leaf, target)) {
    acc.extraSources.push(...dynamicValues);
  }
  acc.pending.push({ sources: dynamicValues, target: subTarget });
}

/** Steps array destructuring elements and leading array rest targets. */
function stepArrayTarget(
  array: ArrayLiteralExpression,
  sources: readonly Held[],
  target: TargetParameter,
  acc: ScanAccumulator,
): void {
  for (const [index, element] of array.elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (isSpreadElement(element)) {
      const restTarget = unwrapped(element.expression);
      if (isIdentifier(restTarget) && matchesParameter(restTarget, target)) {
        acc.matched = true;
        if (index === 0) {
          acc.extraSources.push(...sources);
        }
      } else {
        acc.pending.push({ sources: [], target: restTarget });
      }
    } else {
      acc.pending.push({
        sources: sources.map((each) => {
          return {
            keys: [...each.keys, String(index)],
            value: each.value,
          };
        }),
        target: element,
      });
    }
  }
}

/** Own property value expressions on literal object sources when a computed destructuring key is dynamic. */
function dynamicObjectValues(sources: readonly Held[]): readonly Held[] {
  const values: Held[] = [];
  for (const source of sources) {
    if (source.keys.length > 0) {
      continue;
    }
    const object = unwrapped(source.value);
    if (!isObjectLiteralExpression(object)) {
      continue;
    }
    for (const property of object.properties) {
      if (isPropertyAssignment(property) && staticPropertyName(property.name) !== '__proto__') {
        values.push({ keys: [], value: property.initializer });
      } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
        values.push({ keys: [], value: property.name });
      }
    }
  }
  return values;
}

/** Unwraps `target = defaultValue` wrappers inside an assignment pattern. */
function stripDefaultTarget(node: Expression): Expression {
  let current = unwrapped(node);
  while (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    current = unwrapped(current.left);
  }
  return current;
}

/** Whether any assignment target identifier inside `pattern` resolves to `target.parameter`. */
function targetsParameter(pattern: Expression, target: TargetParameter): boolean {
  const pending: Expression[] = [pattern];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const current = unwrapped(at);
    if (isIdentifier(current) && matchesParameter(current, target)) {
      return true;
    }
    pending.push(...patternChildTargets(current));
  }
  return false;
}

/** Direct child target expressions of one unwrapped assignment pattern node. */
function patternChildTargets(current: Expression): readonly Expression[] {
  if (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    return [current.left];
  }
  if (isObjectLiteralExpression(current)) {
    return objectPatternChildTargets(current);
  }
  if (!isArrayLiteralExpression(current)) {
    return [];
  }
  const children: Expression[] = [];
  for (const element of current.elements) {
    if (isSpreadElement(element)) {
      children.push(element.expression);
    } else if (!isOmittedExpression(element)) {
      children.push(element);
    }
  }
  return children;
}

/** Child target expressions inside an object destructuring assignment literal. */
function objectPatternChildTargets(object: ObjectLiteralExpression): readonly Expression[] {
  const children: Expression[] = [];
  for (const property of object.properties) {
    if (isPropertyAssignment(property)) {
      children.push(property.initializer);
    } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      children.push(property.name);
    } else if (isSpreadAssignment(property)) {
      children.push(property.expression);
    }
  }
  return children;
}

/** Checks whether `id` references `target.parameter`. */
function matchesParameter(id: Identifier, target: TargetParameter): boolean {
  return id.text === target.name.text && frameDeclarationOf(id) === target.parameter;
}

/** Resolves a static property key name on an object assignment pattern property. */
function staticPropertyName(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  if (isComputedPropertyName(name)) {
    const constant = constantValue(name.expression);
    return typeof constant === 'string' || typeof constant === 'number'
      ? String(constant)
      : undefined;
  }
  return undefined;
}

/** Unfolds a `Held` member path through aliases, literals, arrays, and parameter sources. */
export function inspectHeldPath(
  entry: Held,
  point: Node,
  callbacks: ProjectionCallbacks,
): HeldResolution {
  const expressions: Expression[] = [];
  let typedFormData = false;
  const seen = new Map<Expression, Set<string>>();
  const pending: Held[] = [entry];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at.value);
    const serialized = JSON.stringify(at.keys);
    const visited = seen.get(value) ?? new Set<string>();
    if (visited.has(serialized)) {
      continue;
    }
    visited.add(serialized);
    seen.set(value, visited);
    if (at.keys.length === 0) {
      expressions.push(at.value);
      continue;
    }
    if (callbacks.isTypedFormData(at.value, value, at.keys)) {
      typedFormData = true;
    }
    pending.push(...expandHeldStep(at, value, point, callbacks));
  }
  return { expressions, typedFormData };
}

/** Expands one non-empty `Held` member path step into successor `Held` candidates. */
function expandHeldStep(
  at: Held,
  value: Expression,
  point: Node,
  callbacks: ProjectionCallbacks,
): readonly Held[] {
  const alternatives = callbacks.selectValues(value);
  if (alternatives !== undefined) {
    return alternatives.map((each) => ({ keys: at.keys, value: each }));
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const memberKey = frameMemberName(value);
    return memberKey === undefined
      ? []
      : [{ keys: [memberKey, ...at.keys], value: value.expression }];
  }
  if (isArrayLiteralExpression(value)) {
    const [firstKey, ...restKeys] = at.keys;
    return firstKey === undefined ? [] : arrayPathEntries(value, firstKey, restKeys);
  }
  if (isIdentifier(value)) {
    return expandIdentifierStep(value, at.keys, point, callbacks);
  }
  const objectSources = framedObjectSources(value, at.keys);
  if (objectSources === undefined) {
    return [];
  }
  return objectSources.filter(
    (each) => unwrapped(each.value) !== value || each.keys.length !== at.keys.length,
  );
}

/** Expands a variable or parameter identifier along `keys`. */
function expandIdentifierStep(
  id: Identifier,
  keys: readonly string[],
  point: Node,
  callbacks: ProjectionCallbacks,
): readonly Held[] {
  const selected = frameBindingOf(id);
  if (selected === undefined) {
    return [];
  }
  const defaults =
    selected.keys.length === 0
      ? []
      : callbacks.bindingDefaults(id, selected.binding.name).map((value) => ({ keys, value }));
  if (isVariableDeclaration(selected.binding)) {
    const held = framedHeldValues(id, keys, point);
    if (held === undefined) {
      return defaults;
    }
    return [...(held.initial === undefined ? [] : [held.initial]), ...held.held, ...defaults];
  }
  if (!isParameterDeclaration(selected.binding)) {
    return [];
  }
  const resolved = callbacks.readParameter(id, selected.binding);
  const fullKeys = [...selected.keys, ...keys];
  const fromSources = resolved.sources.map((each) => {
    return {
      keys: [...each.keys, ...fullKeys],
      value: each.value,
    };
  });
  if (resolved.replaced && resolved.ambiguous !== true) {
    return fromSources;
  }
  const paramDefault =
    selected.binding.initializer === undefined
      ? []
      : [{ keys: fullKeys, value: selected.binding.initializer }];
  return [...fromSources, ...paramDefault, ...defaults];
}

/** Selects matching element candidates from an `ArrayLiteralExpression` for `firstKey`. */
function arrayPathEntries(
  array: ArrayLiteralExpression,
  firstKey: string,
  restKeys: readonly string[],
): readonly Held[] {
  const entries: Held[] = [];
  let spreadSeen = false;
  for (const [index, element] of array.elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (isSpreadElement(element)) {
      spreadSeen = true;
      entries.push({ keys: ['0', ...restKeys], value: element.expression });
    } else if (spreadSeen || String(index) === firstKey) {
      entries.push({ keys: restKeys, value: element });
    }
  }
  return entries;
}
