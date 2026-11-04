import {
  type Expression,
  type Identifier,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isNewExpression,
  isPrefixUnaryExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { interveningEvaluation } from './written-evaluation.ts';

/** Primitive bigints the source writes, and numeric operations whose written operands must throw. */

/** The language's calls whose successful result is always a primitive bigint. */
const BIGINT_MAKERS: ReadonlySet<string> = new Set(['BigInt', 'BigInt.asIntN', 'BigInt.asUintN']);

/** The bigint bounds needed to recognize zero divisors, negative powers and complement prefixes. */
const INTEGER = { one: 1n, zero: 0n } as const;

/** Numeric operators, including their compound assignments, by the operation they perform. */
const NUMERIC: ReadonlyMap<SyntaxKind, SyntaxKind> = new Map([
  [SyntaxKind.AmpersandEqualsToken, SyntaxKind.AmpersandToken],
  [SyntaxKind.AmpersandToken, SyntaxKind.AmpersandToken],
  [SyntaxKind.AsteriskAsteriskEqualsToken, SyntaxKind.AsteriskAsteriskToken],
  [SyntaxKind.AsteriskAsteriskToken, SyntaxKind.AsteriskAsteriskToken],
  [SyntaxKind.AsteriskEqualsToken, SyntaxKind.AsteriskToken],
  [SyntaxKind.AsteriskToken, SyntaxKind.AsteriskToken],
  [SyntaxKind.BarEqualsToken, SyntaxKind.BarToken],
  [SyntaxKind.BarToken, SyntaxKind.BarToken],
  [SyntaxKind.CaretEqualsToken, SyntaxKind.CaretToken],
  [SyntaxKind.CaretToken, SyntaxKind.CaretToken],
  [SyntaxKind.GreaterThanGreaterThanEqualsToken, SyntaxKind.GreaterThanGreaterThanToken],
  [
    SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ],
  [
    SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
    SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ],
  [SyntaxKind.GreaterThanGreaterThanToken, SyntaxKind.GreaterThanGreaterThanToken],
  [SyntaxKind.LessThanLessThanEqualsToken, SyntaxKind.LessThanLessThanToken],
  [SyntaxKind.LessThanLessThanToken, SyntaxKind.LessThanLessThanToken],
  [SyntaxKind.MinusEqualsToken, SyntaxKind.MinusToken],
  [SyntaxKind.MinusToken, SyntaxKind.MinusToken],
  [SyntaxKind.PercentEqualsToken, SyntaxKind.PercentToken],
  [SyntaxKind.PercentToken, SyntaxKind.PercentToken],
  [SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken],
  [SyntaxKind.PlusToken, SyntaxKind.PlusToken],
  [SyntaxKind.SlashEqualsToken, SyntaxKind.SlashToken],
  [SyntaxKind.SlashToken, SyntaxKind.SlashToken],
]);

/** Whether a value is written as a primitive bigint, including the language's makers and aliases. */
export function isBigIntWritten(node: Expression, resolve: Resolve | undefined): boolean {
  const value = pastBigIntPrefixes(node, resolve).value;
  if (value === undefined) {
    return false;
  }
  const path = isCallExpression(value)
    ? globalCalleePath(value.expression, resolve)?.join('.')
    : undefined;
  return isBigIntLiteral(value) || BIGINT_MAKERS.has(path ?? '');
}

/** Whether a numeric operation mixes bigint with another known primitive, or cannot accept its bigint inputs. */
export function binaryBigIntThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (!isBinaryExpression(node)) {
    return false;
  }
  const operator = NUMERIC.get(node.operatorToken.kind);
  if (operator === undefined) {
    return false;
  }
  const left = isBigIntWritten(node.left, resolve);
  const right = isBigIntWritten(node.right, resolve);
  if (!left && !right) {
    return false;
  }
  if (left !== right) {
    const other = writtenOf(left ? node.right : node.left, resolve);
    const kind = primitiveOf(other, resolve);
    // Numeric hints make any native Date a number; addition uses its string default.
    const numericDate = operator !== SyntaxKind.PlusToken && nativeDate(other, resolve);
    return (
      numericDate ||
      (kind !== undefined &&
        (operator !== SyntaxKind.PlusToken || (kind !== 'empty' && kind !== 'text')))
    );
  }
  if (operator === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
    return true;
  }
  const divisor = constantBigInt(node.right, resolve);
  if (operator === SyntaxKind.SlashToken || operator === SyntaxKind.PercentToken) {
    return divisor === INTEGER.zero;
  }
  return (
    operator === SyntaxKind.AsteriskAsteriskToken && divisor !== undefined && divisor < INTEGER.zero
  );
}

/** An unchanged native Date has a numeric primitive regardless of its constructor arguments. */
function nativeDate(node: Expression, resolve: Resolve | undefined): boolean {
  const constructor: Resolve = (name) => resolve?.(name) ?? constructorAlias(name);
  return (
    isNewExpression(node) && globalCalleePath(node.expression, constructor)?.join('.') === 'Date'
  );
}

/** A local constant constructor reference, before any code may have changed its prototype. */
function constructorAlias(name: Identifier): Expression | undefined {
  const value = metadataInitializer(name);
  return value === undefined || interveningEvaluation(value, name) ? undefined : value;
}

/** A chain of bigint-preserving prefixes, stopping when an alias cycles. */
function pastBigIntPrefixes(
  node: Expression,
  resolve: Resolve | undefined,
): { readonly value: Expression | undefined; readonly operators: readonly SyntaxKind[] } {
  const operators: SyntaxKind[] = [];
  const seen = new Set<Expression>();
  let value = writtenOf(node, resolve);
  while (
    isPrefixUnaryExpression(value) &&
    [SyntaxKind.MinusToken, SyntaxKind.TildeToken].includes(value.operator)
  ) {
    if (seen.has(value)) {
      return { operators, value: undefined };
    }
    seen.add(value);
    operators.push(value.operator);
    value = writtenOf(value.operand, resolve);
  }
  return { operators, value };
}

/** A literal bigint or a scalar explicitly converted by BigInt, without executing source calls. */
function constantBigInt(node: Expression, resolve: Resolve | undefined): bigint | undefined {
  const { operators, value } = pastBigIntPrefixes(node, resolve);
  if (value === undefined) {
    return undefined;
  }
  let result = scalarBigInt(value, resolve);
  if (result === undefined) {
    return undefined;
  }
  for (const operator of operators.toReversed()) {
    result = operator === SyntaxKind.MinusToken ? -result : -result - INTEGER.one;
  }
  return result;
}

/** The written scalar of a bigint literal or BigInt's first argument, if conversion succeeds. */
function scalarBigInt(value: Expression, resolve: Resolve | undefined): bigint | undefined {
  if (isBigIntLiteral(value)) {
    return BigInt(value.text.replaceAll('_', '').replace(/n$/u, ''));
  }
  if (
    !isCallExpression(value) ||
    globalCalleePath(value.expression, resolve)?.join('.') !== 'BigInt' ||
    value.arguments[0] === undefined
  ) {
    return undefined;
  }
  const argument = constantValue(value.arguments[0], resolve);
  if (argument === undefined) {
    return undefined;
  }
  try {
    return BigInt(argument);
  } catch {
    return undefined;
  }
}
