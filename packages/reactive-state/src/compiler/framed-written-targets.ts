import {
  type Expression,
  isArrayLiteralExpression,
  isAssertionExpression,
  isBinaryExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNonNullExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/** The targets an assignment or a loop head writes, through destructuring patterns and defaults. */
export function framedWrittenTargets(node: Node): readonly Expression[] {
  if (isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (kind < SyntaxKind.FirstAssignment || kind > SyntaxKind.LastAssignment) return [];
    return kind === SyntaxKind.EqualsToken ? patternTargets(node.left) : [peeled(node.left)];
  }
  return (isForOfStatement(node) || isForInStatement(node)) && isExpression(node.initializer)
    ? patternTargets(node.initializer)
    : [];
}

/** Each element, entry value, rest and default target of an assignment pattern, at any depth. */
function patternTargets(target: Expression): readonly Expression[] {
  const found: Expression[] = [];
  const pending = [target];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = peeled(next);
    if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.EqualsToken)
      pending.push(value.left);
    else if (isArrayLiteralExpression(value)) pending.push(...elementTargets(value.elements));
    else if (isObjectLiteralExpression(value)) pending.push(...entryTargets(value.properties));
    else found.push(value);
  }
  return found;
}

/** Object pattern entry values, shorthand names and a rest entry's target, whatever their keys. */
function entryTargets(properties: ObjectLiteralExpression['properties']): readonly Expression[] {
  const found: Expression[] = [];
  for (const property of properties) {
    if (isPropertyAssignment(property)) found.push(property.initializer);
    else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
      found.push(property.name);
    else if (isSpreadAssignment(property)) found.push(property.expression);
  }
  return found;
}

/** Array pattern slots, a rest element's target included and holes left out. */
function elementTargets(elements: readonly Expression[]): readonly Expression[] {
  const found: Expression[] = [];
  for (const element of elements) {
    if (isSpreadElement(element)) found.push(element.expression);
    else if (!isOmittedExpression(element)) found.push(element);
  }
  return found;
}

/** Whether a node only wraps another: parentheses, a cast of any kind, a non-null assertion, `satisfies`. */
export function isWrapper(node: Node): boolean {
  return (
    isParenthesizedExpression(node) ||
    isAssertionExpression(node) ||
    isNonNullExpression(node) ||
    isSatisfiesExpression(node)
  );
}

/**
 * The expression a node stands for past what wraps it: parentheses, a cast of any kind (`<T>x` too),
 * a non-null assertion, `satisfies`.
 */
export function peeled(expression: Expression): Expression {
  let each = unwrapped(expression);
  while (isTypeAssertion(each)) each = unwrapped(each.expression);
  return each;
}

/** The node that stands for the same value as `node` past what wraps it, outward. */
export function outermost(node: Node): Node {
  let at = node;
  while (isWrapper(at.parent)) at = at.parent;
  return at;
}
