import {
  type BinaryExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isPrefixUnaryExpression,
  isSpreadElement,
  type PrefixUnaryExpression,
  SyntaxKind,
} from 'typescript/ast';

import { constantValue, type Resolve, writtenTime } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { writtenOf } from './throw-shapes.ts';

/** Numeric conversions of written Date times, without applying Date's string default for addition. */

interface Scalar {
  readonly value: number;
  readonly date: boolean;
}

interface Reading {
  readonly resolve: Resolve | undefined;
  readonly seen: ReadonlySet<Expression>;
}

/** These binary operations request numeric primitives; addition requests Date's string default. */
const OPERATIONS: ReadonlyMap<SyntaxKind, (left: number, right: number) => number> = new Map([
  [SyntaxKind.AsteriskAsteriskToken, (left, right) => left ** right],
  [SyntaxKind.AsteriskToken, (left, right) => left * right],
  [SyntaxKind.MinusToken, (left, right) => left - right],
  [SyntaxKind.PercentToken, (left, right) => left % right],
  [SyntaxKind.SlashToken, (left, right) => left / right],
]);

/** The numeric result of a written Date conversion, including NaN; unknown conversions stay unknown. */
export function coercedDateNumber(
  node: Expression,
  resolve: Resolve | undefined,
): number | undefined {
  const result = coercionOf(node, { resolve, seen: new Set() });
  return result?.date === true ? result.value : undefined;
}

/** The operand a logical selector takes from a known numeric Date result, including falsey NaN. */
export function selectedDateOperand(
  node: BinaryExpression,
  resolve: Resolve | undefined,
): Expression | undefined {
  const value = coercedDateNumber(node.left, resolve);
  if (value === undefined) {
    return undefined;
  }
  if (node.operatorToken.kind === SyntaxKind.BarBarToken) {
    return value ? node.left : node.right;
  }
  if (node.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken) {
    return value ? node.right : node.left;
  }
  return node.operatorToken.kind === SyntaxKind.QuestionQuestionToken ? node.left : undefined;
}

/** A numeric coercion or arithmetic tree, with each alias or expression visited once on its path. */
function coercionOf(node: Expression, reading: Reading): Scalar | undefined {
  const value = writtenOf(node, reading.resolve);
  if (reading.seen.has(value)) {
    return undefined;
  }
  const at: Reading = { ...reading, seen: new Set([...reading.seen, value]) };
  if (
    isPrefixUnaryExpression(value) &&
    (value.operator === SyntaxKind.PlusToken || value.operator === SyntaxKind.MinusToken)
  ) {
    return signedOperand(value, at);
  }
  if (isBinaryExpression(value)) {
    const operation = OPERATIONS.get(value.operatorToken.kind);
    const left = operation === undefined ? undefined : operandOf(value.left, at);
    const right = left === undefined ? undefined : operandOf(value.right, at);
    return operation === undefined || left === undefined || right === undefined
      ? undefined
      : { date: left.date || right.date, value: operation(left.value, right.value) };
  }
  if (
    !isCallExpression(value) ||
    globalCalleePath(value.expression, reading.resolve)?.join('.') !== 'Number' ||
    value.arguments.length !== 1
  ) {
    return undefined;
  }
  const [argument] = value.arguments;
  return argument === undefined || isSpreadElement(argument) ? undefined : operandOf(argument, at);
}

/** Unary plus and minus request the numeric primitive rather than Date's default string. */
function signedOperand(node: PrefixUnaryExpression, reading: Reading): Scalar | undefined {
  const operand = operandOf(node.operand, reading);
  return operand === undefined
    ? undefined
    : {
        date: operand.date,
        value: node.operator === SyntaxKind.MinusToken ? -operand.value : operand.value,
      };
}

/** Only unchanged native Date constructions supply a time; other operands must be written scalars. */
function operandOf(node: Expression, reading: Reading): Scalar | undefined {
  const value = writtenOf(node, reading.resolve);
  const time = writtenTime(value, reading.resolve);
  if (time !== undefined) {
    return { date: true, value: time };
  }
  const scalar = constantValue(value, reading.resolve);
  return scalar === undefined ? coercionOf(value, reading) : { date: false, value: Number(scalar) };
}
