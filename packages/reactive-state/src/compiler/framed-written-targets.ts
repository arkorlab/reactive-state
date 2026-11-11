import {
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
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
    return kind === SyntaxKind.EqualsToken ? patternTargets(node.left) : [node.left];
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
    const value = unwrapped(next);
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
