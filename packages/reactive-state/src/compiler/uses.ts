import {
  type Expression,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isForInStatement,
  isForOfStatement,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/** Where a node stands and what a value is: what it is used as, what a pattern takes apart, what it comes to past its wrappers. */

/**
 * Where `node` is used: past what wraps it alike — parentheses, a cast, `!` — what it stands in
 * (`parent`), as `at`.
 */
export function useOf(node: Node): { readonly at: Node; readonly parent: Node } {
  let at = node;
  while (
    isParenthesizedExpression(at.parent) ||
    isAsExpression(at.parent) ||
    isSatisfiesExpression(at.parent) ||
    isNonNullExpression(at.parent) ||
    isTypeAssertion(at.parent)
  ) {
    at = at.parent;
  }
  return { at, parent: at.parent };
}

/**
 * Whether `literal`, an object written, is a pattern: what an assignment takes apart, `({ eval:
 * run } = globalThis)` — within another, a default's target too — or a loop.
 */
export function isTakenApart(literal: Node): boolean {
  let at = literal;
  for (;;) {
    const { parent } = at;
    if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.EqualsToken) {
      return parent.left === at;
    }
    if (isForOfStatement(parent) || isForInStatement(parent)) {
      return parent.initializer === at;
    }
    if (!holdsPart(parent)) {
      return false;
    }
    at = parent;
  }
}

/** Whether `node` may hold a part of a pattern: parentheses, an array or an object, an entry, a spread. */
function holdsPart(node: Node): boolean {
  return (
    isParenthesizedExpression(node) ||
    isArrayLiteralExpression(node) ||
    isObjectLiteralExpression(node) ||
    isPropertyAssignment(node) ||
    isShorthandPropertyAssignment(node) ||
    isSpreadElement(node) ||
    isSpreadAssignment(node)
  );
}

/**
 * What `expression` evaluates to, past what hands its value on as it is: the parentheses, the casts
 * — in angle brackets too, which `unwrapped` leaves — the `!`, and a comma's first operands.
 */
export function peeled(expression: Expression): Expression {
  let each = unwrapped(expression);
  for (;;) {
    if (isBinaryExpression(each) && each.operatorToken.kind === SyntaxKind.CommaToken) {
      each = unwrapped(each.right);
    } else if (isTypeAssertion(each)) {
      each = unwrapped(each.expression);
    } else {
      return each;
    }
  }
}
