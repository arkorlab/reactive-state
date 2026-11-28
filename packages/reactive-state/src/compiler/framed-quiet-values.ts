/**
 * Values and callees whose evaluation runs no code, so that nothing a call evaluates before an
 * argument spread can change the array the spread expands.
 */

import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTypeOfExpression,
  isVoidExpression,
  type NewExpression,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
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

/** Primitive literal syntax, which a platform constructor converts without calling any code. */
const PRIMITIVES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

/** Platform collections that keep what a written array gives them, converting none of it. */
const COLLECTIONS: ReadonlySet<string> = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

/** Of those, the ones that read each element given as an entry pair. */
const KEYED: ReadonlySet<string> = new Set(['Map', 'WeakMap']);

/**
 * Whether evaluating a value runs no code: a literal, a read of a name the file binds, of
 * `undefined` or of a global's path (`globalRead`), a function or an arrow, `void`, `typeof` or `!`
 * of such a value, a comma of them, an array or object literal written whole of them — no spread,
 * computed key or initializer that may run code — or a construction that calls none
 * (`quietConstruction`).
 */
export function framedQuietValue(node: Expression): boolean {
  let value = unwrapped(node);
  for (;;) {
    if (isVoidExpression(value) || isTypeOfExpression(value)) value = unwrapped(value.expression);
    else if (isPrefixUnaryExpression(value) && value.operator === SyntaxKind.ExclamationToken)
      value = unwrapped(value.operand);
    else break;
  }
  if (LITERALS.has(value.kind) || isArrowFunction(value) || isFunctionExpression(value))
    return true;
  if (
    isIdentifier(value) &&
    (value.text === 'undefined' || frameDeclarationOf(value) !== undefined)
  )
    return true;
  if (globalRead(value)) return true;
  if (isArrayLiteralExpression(value))
    return value.elements.every(
      (each) => isOmittedExpression(each) || (!isSpreadElement(each) && framedQuietValue(each)),
    );
  if (isObjectLiteralExpression(value)) return value.properties.every((each) => quietMember(each));
  if (isNewExpression(value)) return quietConstruction(value);
  return (
    isBinaryExpression(value) &&
    value.operatorToken.kind === SyntaxKind.CommaToken &&
    framedQuietValue(value.left) &&
    framedQuietValue(value.right)
  );
}

/** Whether an object literal's member runs no code as the literal is made. */
function quietMember(member: ObjectLiteralElementLike): boolean {
  if (isShorthandPropertyAssignment(member))
    return (
      member.objectAssignmentInitializer === undefined &&
      isIdentifier(member.name) &&
      framedQuietValue(member.name)
    );
  if (isSpreadAssignment(member) || isComputedPropertyName(member.name)) return false;
  return !isPropertyAssignment(member) || framedQuietValue(member.initializer);
}

/**
 * Whether a construction calls no code: the platform's constructor, a global's name, given
 * primitive literals alone (`new Date(0)`), or a platform collection given an array literal written
 * whole of quiet values, entry pairs written in place for a keyed one
 * (`new Map([['key', value]])`).
 */
function quietConstruction(node: NewExpression): boolean {
  const name = globalOf(unwrapped(node.expression));
  if (name === undefined) return false;
  const args = node.arguments ?? [];
  if (args.every((each) => PRIMITIVES.has(unwrapped(each).kind))) return true;
  const [items] = args;
  if (items === undefined || args.length > 1 || !COLLECTIONS.has(name)) return false;
  const array = unwrapped(items);
  return (
    isArrayLiteralExpression(array) &&
    array.elements.every((each) => {
      return KEYED.has(name)
        ? isArrayLiteralExpression(unwrapped(each)) && framedQuietValue(each)
        : isOmittedExpression(each) || (!isSpreadElement(each) && framedQuietValue(each));
    })
  );
}

/**
 * Whether evaluating a callee runs no code before the call's arguments: a name or `super`; a
 * member, by its name or by literal text, of a quiet value (`framedQuietValue`); or a comma of
 * quiet values that ends in such a callee. What a member's read itself runs is left to the reader
 * that resolves the callee.
 */
export function framedQuietCallee(node: Expression): boolean {
  const value = unwrapped(node);
  if (isIdentifier(value) || value.kind === SyntaxKind.SuperKeyword) return true;
  if (isPropertyAccessExpression(value)) return framedQuietValue(value.expression);
  if (isElementAccessExpression(value))
    return literalKey(value.argumentExpression) && framedQuietValue(value.expression);
  if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken)
    return framedQuietValue(value.left) && framedQuietCallee(value.right);
  return framedQuietValue(value);
}

/**
 * Whether a value reads a global, or a global's member by its name or by literal text
 * (`Array.prototype.map`), which the compile reads as the platform's own: a name no declaration in
 * the file gives.
 */
function globalRead(node: Expression): boolean {
  let value = node;
  while (
    isPropertyAccessExpression(value) ||
    (isElementAccessExpression(value) && literalKey(value.argumentExpression))
  )
    value = unwrapped(value.expression);
  return globalOf(value) !== undefined;
}

/** A key written as literal text or a number, whose conversion to a key runs no code. */
function literalKey(node: Expression): boolean {
  const key = unwrapped(node);
  return isStringLiteral(key) || isNumericLiteral(key) || isNoSubstitutionTemplateLiteral(key);
}
