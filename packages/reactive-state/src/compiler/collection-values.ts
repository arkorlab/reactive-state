import {
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isConditionalExpression,
  isObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/** The operators that answer one of their operands, the one that decides. */
const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * Whether `expression` may make an object or an array where it is evaluated: one written out, or a
 * conditional or a logical operation of which one branch or one operand may — `cond ? { … } : { … }`,
 * `params.items ?? []`. Each part that evaluates it makes a collection of its own.
 */
export function mayMakeCollection(expression: Expression): boolean {
  const value = unwrapped(expression);
  if (isObjectLiteralExpression(value) || isArrayLiteralExpression(value)) {
    return true;
  }
  if (isConditionalExpression(value)) {
    return mayMakeCollection(value.whenTrue) || mayMakeCollection(value.whenFalse);
  }
  return (
    isBinaryExpression(value) &&
    LOGICAL.has(value.operatorToken.kind) &&
    (mayMakeCollection(value.left) || mayMakeCollection(value.right))
  );
}
