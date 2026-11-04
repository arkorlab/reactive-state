import {
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { metadataCallee } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { writtenOf } from './throw-shapes.ts';

/** The largest array length, independent of whether its elements are allocated. */
const MAX_LENGTH = 0xff_ff_ff_ff;

/** A simple write to a literal array's length still executes ArraySetLength validation. */
export function arrayLengthThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken) {
    return false;
  }
  const target = unwrapped(node.left);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) {
    return false;
  }
  const key = isPropertyAccessExpression(target)
    ? target.name.text
    : constantValue(target.argumentExpression, resolve);
  const receiver = metadataCallee(writtenOf(target.expression, resolve));
  if (key !== 'length' || receiver === undefined || !isArrayLiteralExpression(receiver)) {
    return false;
  }
  return arrayLengthValueThrows(node.right, resolve);
}

/** Whether a written array length value fails the native unsigned 32-bit length conversion. */
export function arrayLengthValueThrows(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  const constant = constantValue(value, resolve);
  if (constant !== undefined) {
    const number = Number(constant);
    return !Number.isSafeInteger(number) || number < 0 || number > MAX_LENGTH;
  }
  return isVoidExpression(value) || globalCalleePath(value, resolve)?.join('.') === 'undefined';
}
