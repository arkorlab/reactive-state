import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { declarationOf } from './framed.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { writtenBy } from './written.ts';

const SCALARS = { bigint: 0n } as const;

/** Strict primitive [[Set]] receivers cannot gain a property through their temporary boxes. */
export function primitiveWriteThrows(node: Node, outer: Resolve | undefined): boolean {
  if (
    (!isBinaryExpression(node) &&
      !isPrefixUnaryExpression(node) &&
      !isPostfixUnaryExpression(node)) ||
    earlierExpressionEffect(node) ||
    priorEffect(node) ||
    (isBinaryExpression(node) && callbackCreationEffect(node.right))
  ) {
    return false;
  }
  const target = writtenBy(node);
  const member = target === undefined ? undefined : unwrapped(target as Expression);
  if (
    member === undefined ||
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member))
  ) {
    return false;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? primitiveConstant(name);
  const key = isPropertyAccessExpression(member)
    ? member.name.text
    : constantValue(member.argumentExpression, resolve);
  const value = writtenOf(member.expression, resolve);
  if (
    key === undefined ||
    key === '__proto__' ||
    (isElementAccessExpression(member) && callbackCreationEffect(member.argumentExpression)) ||
    !quietPrimitive(value, resolve)
  ) {
    return false;
  }
  return selectsPrimitiveWrite(node, value, String(key), resolve);
}

/** A native symbol or bigint maker may produce the primitive without a source conversion effect. */
function quietPrimitive(value: Expression, resolve: Resolve): boolean {
  const maker = isSymbolWritten(value, resolve) || isBigIntWritten(value, resolve);
  return (
    (maker || primitiveOf(value, resolve) !== undefined) &&
    (maker && isCallExpression(value)
      ? value.arguments.every((argument) => {
          return (
            primitiveOf(writtenOf(argument, resolve), resolve) !== undefined &&
            !callbackCreationEffect(argument)
          );
        })
      : !callbackCreationEffect(value))
  );
}

/** Logical assignments only write when their statically stored previous member selects the RHS. */
function selectsPrimitiveWrite(
  node: Node,
  receiver: Expression,
  key: string,
  resolve: Resolve,
): boolean {
  if (!isBinaryExpression(node)) {
    return true;
  }
  const operator = node.operatorToken.kind;
  if (
    operator !== SyntaxKind.AmpersandAmpersandEqualsToken &&
    operator !== SyntaxKind.BarBarEqualsToken &&
    operator !== SyntaxKind.QuestionQuestionEqualsToken
  ) {
    return true;
  }
  const previous = primitiveMember(receiver, key, resolve);
  if (previous === undefined) {
    return false;
  }
  if (operator === SyntaxKind.QuestionQuestionEqualsToken) {
    return previous.value === null || previous.value === undefined;
  }
  const truthy = Boolean(previous.value);
  return operator === SyntaxKind.AmpersandAmpersandEqualsToken ? truthy : !truthy;
}

/** Only data descriptors of sanitized native boxes are read; a native accessor remains unknown. */
function primitiveMember(
  receiver: Expression,
  key: string,
  resolve: Resolve,
): { readonly value: unknown } | undefined {
  const scalar = constantValue(receiver, resolve);
  const primitive =
    scalar ??
    (isSymbolWritten(receiver, resolve) ? Symbol.iterator : undefined) ??
    (isBigIntWritten(receiver, resolve) ? SCALARS.bigint : false);
  let boxed: unknown = new Object(primitive);
  while (typeof boxed === 'object' && boxed !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(boxed, key);
    if (descriptor !== undefined) {
      return 'value' in descriptor ? { value: descriptor.value } : undefined;
    }
    boxed = Object.getPrototypeOf(boxed);
  }
  return { value: undefined };
}

/** Earlier work can install a primitive prototype setter before its temporary box is used. */
function priorEffect(node: Node): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const status = { effect: false };
    each.parent.forEachChild((part) => {
      if (part.end <= each.pos && callbackCreationEffect(part)) {
        status.effect = true;
      }
    });
    if (status.effect) {
      return true;
    }
  }
  return false;
}

/** Mutable locals are not replaced by their initializer when the caller cannot follow them. */
function primitiveConstant(name: Identifier): Expression | undefined {
  const declared = declarationOf(name);
  return declared !== undefined &&
    isVariableDeclaration(declared) &&
    isIdentifier(declared.name) &&
    /^const\s/u.test(declared.parent.getText())
    ? declared.initializer
    : undefined;
}
