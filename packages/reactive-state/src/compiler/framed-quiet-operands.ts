/**
 * An input read past what wraps it and past a comma's earlier operands that run no code, as a
 * collection's reader reads what it is given.
 */

import {
  type Expression,
  isArrowFunction,
  isBinaryExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isTypeOfExpression,
  isVoidExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';

/** Literal syntax, whose evaluation runs no code. */
const LITERALS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.ThisKeyword,
  SyntaxKind.TrueKeyword,
]);

/**
 * A value past what wraps it and past a comma's earlier operands that run no code: `(void 0,
 * entries)` gives `entries`. A comma whose earlier operand may run code stays as it is, and so does
 * one that ends in a member read, whose receiver it drops: `(0, items.at)()` calls with none.
 */
export function framedQuietOperand(node: Expression): Expression {
  let value = unwrapped(node);
  while (
    isBinaryExpression(value) &&
    value.operatorToken.kind === SyntaxKind.CommaToken &&
    framedRunsNoCode(value.left) &&
    !memberRead(unwrapped(value.right))
  )
    value = unwrapped(value.right);
  return value;
}

/** A property or element read, which a call of it would make its receiver. */
function memberRead(node: Expression): boolean {
  return isPropertyAccessExpression(node) || isElementAccessExpression(node);
}

/**
 * An operand that runs no code: a literal, a read of a name the file binds or of `undefined`, a
 * function or an arrow, `void`, `typeof` or `!` of such an operand, or a comma of them.
 */
export function framedRunsNoCode(node: Expression): boolean {
  let value = unwrapped(node);
  for (;;) {
    if (isVoidExpression(value) || isTypeOfExpression(value)) value = unwrapped(value.expression);
    else if (isPrefixUnaryExpression(value) && value.operator === SyntaxKind.ExclamationToken)
      value = unwrapped(value.operand);
    else break;
  }
  if (LITERALS.has(value.kind) || isArrowFunction(value) || isFunctionExpression(value))
    return true;
  if (isIdentifier(value))
    return value.text === 'undefined' || frameDeclarationOf(value) !== undefined;
  return (
    isBinaryExpression(value) &&
    value.operatorToken.kind === SyntaxKind.CommaToken &&
    framedRunsNoCode(value.left) &&
    framedRunsNoCode(value.right)
  );
}
