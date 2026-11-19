import {
  type Expression,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isNonNullExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { writtenBy } from './written.ts';

/** Upward destructuring-target and unwrapped write-target helpers for middleware array guards. */

const UPDATE_OPERATORS = new Set([SyntaxKind.MinusMinusToken, SyntaxKind.PlusPlusToken]);

/** Detects direct, compound, update, delete, destructuring, and `for...of` / `for...in` writes to `expression`. */
export function middlewareExpressionReplaced(expression: Expression): boolean {
  if (directMutationTarget(expression)) return true;
  let current: Node = expression;
  for (;;) {
    const { at, parent } = useOf(current);
    if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.EqualsToken)
      return parent.left === at;
    if (
      (isForOfStatement(parent) || isForInStatement(parent)) &&
      !isVariableDeclarationList(parent.initializer)
    )
      return parent.initializer === at;
    if (!isDestructuringWrapper(parent, at)) return false;
    current = parent;
  }
}

/** Expands assignment and destructuring targets while stripping parentheses and type casts at every level. */
export function middlewareWriteTargets(node: Node): readonly Expression[] {
  const targets: Expression[] = [];
  const pending: Node[] = [node];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const value = stripTargetWrappers(current);
    if (isArrayLiteralExpression(value)) pushArrayPatternElements(value.elements, pending);
    else if (isObjectLiteralExpression(value))
      pushObjectPatternProperties(value.properties, pending);
    else if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.EqualsToken)
      pending.push(value.left);
    else if (isExpression(value)) targets.push(value);
  }
  return targets;
}

/** Checks direct delete, increment/decrement, compound-assignment, and mutating-call writes on `expression`. */
function directMutationTarget(expression: Expression): boolean {
  const { at, parent } = useOf(expression);
  if (isDeleteExpression(parent)) return parent.expression === at;
  if (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    UPDATE_OPERATORS.has(parent.operator)
  )
    return parent.operand === at;
  if (isBinaryExpression(parent) && isCompoundAssignment(parent.operatorToken.kind))
    return parent.left === at;
  if (!isCallExpression(parent)) return false;
  const write = writtenBy(parent);
  return (
    write !== undefined &&
    isExpression(write) &&
    stripTargetWrappers(write) === stripTargetWrappers(expression)
  );
}

/** Recognizes compound and logical assignment operators excluding plain `=`. */
function isCompoundAssignment(kind: SyntaxKind): boolean {
  return (
    kind !== SyntaxKind.EqualsToken &&
    kind >= SyntaxKind.FirstAssignment &&
    kind <= SyntaxKind.LastAssignment
  );
}

/** Matches AST nodes that wrap a target slot inside an array or object destructuring assignment pattern. */
function isDestructuringWrapper(parent: Node, at: Node): boolean {
  if (isArrayLiteralExpression(parent) || isObjectLiteralExpression(parent)) return true;
  if (isPropertyAssignment(parent)) return parent.initializer === at;
  if (isShorthandPropertyAssignment(parent)) return parent.name === at;
  if (isSpreadElement(parent) || isSpreadAssignment(parent)) return parent.expression === at;
  return false;
}

/** Strips parentheses, type casts, `satisfies`, and non-null assertions around a write target node. */
function stripTargetWrappers(node: Node): Node {
  let current = isExpression(node) ? unwrapped(node) : node;
  while (
    isParenthesizedExpression(current) ||
    isAsExpression(current) ||
    isSatisfiesExpression(current) ||
    isNonNullExpression(current) ||
    isTypeAssertion(current)
  ) {
    current = isExpression(current.expression) ? unwrapped(current.expression) : current.expression;
  }
  return current;
}

/** Queues non-omitted array destructuring pattern slots, unwrapping rest spread elements. */
function pushArrayPatternElements(elements: readonly Expression[], pending: Node[]): void {
  for (const element of elements) {
    if (isOmittedExpression(element)) continue;
    pending.push(isSpreadElement(element) ? element.expression : element);
  }
}

/** Queues object destructuring pattern value slots, shorthand bindings, and rest spread targets. */
function pushObjectPatternProperties(
  properties: readonly ObjectLiteralElementLike[],
  pending: Node[],
): void {
  for (const property of properties) {
    if (isPropertyAssignment(property)) pending.push(property.initializer);
    else if (isShorthandPropertyAssignment(property)) pending.push(property.name);
    else if (isSpreadAssignment(property)) pending.push(property.expression);
  }
}
