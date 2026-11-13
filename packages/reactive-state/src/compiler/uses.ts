import {
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

/** Where a node stands: what it is used as, and what is taken apart by a pattern. */

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
