import {
  type BinaryExpression,
  type ConditionalExpression,
  type Expression,
  isBigIntLiteral,
  isPrefixUnaryExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { callbackCreationEffect } from './callback-evaluation.ts';
import { selectedDateOperand } from './date-numbers.ts';
import { followedOf, type JsonReading, reached } from './json-reading.ts';
import { constantNumber } from './numbers.ts';
import { skipsEvaluation } from './skipped-evaluation.ts';

/** Only conditional arms selected by source-proven control flow can supply a JSON value. */
export function conditionalNonJson(
  value: ConditionalExpression,
  reading: JsonReading,
  check: (arm: Expression, reading: JsonReading) => Node | undefined,
): Node | undefined {
  for (const arm of [value.whenTrue, value.whenFalse]) {
    if (!skipsEvaluation(arm, followedOf(reading))) {
      const found = check(arm, reading);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/** A logical selector respects numeric Date truthiness, otherwise retaining its existing boundaries. */
export function logicalNonJson(
  value: BinaryExpression,
  reading: JsonReading,
  check: (arm: Expression, reading: JsonReading) => Node | undefined,
): Node | undefined {
  const selected = selectedDateOperand(value, followedOf(reading));
  if (selected !== undefined) {
    return check(selected, reading);
  }
  // `??` and `||` answer their right operand in place of undefined on their left.
  const replaces = value.operatorToken.kind !== SyntaxKind.AmpersandAmpersandToken;
  const left = replaces ? { ...reading, entry: true } : reading;
  return (
    (discardsFalsyLeft(value, reading) ? undefined : check(value.left, left)) ??
    (skipsEvaluation(value.right, followedOf(reading)) ? undefined : check(value.right, reading))
  );
}

/** A quiet written falsy value is evaluated, but is not the result of a logical disjunction. */
function discardsFalsyLeft(node: BinaryExpression, reading: JsonReading): boolean {
  if (node.operatorToken.kind !== SyntaxKind.BarBarToken) {
    return false;
  }
  let value = reached(node.left, reading).value;
  if (callbackCreationEffect(value)) {
    return false;
  }
  const number = constantNumber(value, followedOf(reading));
  if (number !== undefined) {
    return !number;
  }
  const seen = new Set<Expression>();
  while (isPrefixUnaryExpression(value) && value.operator === SyntaxKind.MinusToken) {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    value = reached(value.operand, reading).value;
  }
  return isBigIntLiteral(value) && /^0(?:[box]0+)?n$/iu.test(value.text.replaceAll('_', ''));
}
