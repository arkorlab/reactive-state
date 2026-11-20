import {
  type BinaryExpression,
  isBinaryExpression,
  isConditionalExpression,
  isForStatement,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isSourceFile,
  isStringLiteral,
  isVoidExpression,
  isWhileStatement,
  type Expression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf } from './bounded.ts';
import type { Resolve } from './numbers.ts';
import { writtenOf } from './throw-shapes.ts';

/** An operand or branch skipped by source-proven literal control flow. */
export function skipsEvaluation(node: Node, resolve: Resolve | undefined): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const parent = each.parent;
    if (isBinaryExpression(parent) && parent.right === each && skipsRight(parent, resolve)) {
      return true;
    }
    if (skipsBranch(each, parent, resolve)) {
      return true;
    }
  }
  return false;
}

/** A conditional arm or loop work which its first literal condition prevents from running. */
function skipsBranch(node: Node, parent: Node, resolve: Resolve | undefined): boolean {
  if (isConditionalExpression(parent)) {
    const condition = literalCondition(parent.condition, resolve);
    return (
      condition !== undefined && node === (condition.truth ? parent.whenFalse : parent.whenTrue)
    );
  }
  if (isWhileStatement(parent)) {
    return (
      parent.statement === node && literalCondition(parent.expression, resolve)?.truth === false
    );
  }
  return (
    isForStatement(parent) &&
    parent.condition !== undefined &&
    ([parent.statement, parent.incrementor] as readonly (Node | undefined)[]).includes(node) &&
    literalCondition(parent.condition, resolve)?.truth === false
  );
}

/** Logical selection without evaluating application calls, conversions or engine-dependent text. */
function skipsRight(node: BinaryExpression, resolve: Resolve | undefined): boolean {
  const condition = literalCondition(node.left, resolve);
  if (condition === undefined) {
    return false;
  }
  const operator = node.operatorToken.kind;
  if (operator === SyntaxKind.AmpersandAmpersandToken) {
    return !condition.truth;
  }
  if (operator === SyntaxKind.BarBarToken) {
    return condition.truth;
  }
  return operator === SyntaxKind.QuestionQuestionToken && !condition.nullish;
}

/** The truth and absence of literals and their unary signs, without application evaluation. */
function literalCondition(
  node: Expression,
  resolve: Resolve | undefined,
): { readonly truth: boolean; readonly nullish: boolean } | undefined {
  const signs: SyntaxKind[] = [];
  const seen = new Set<Expression>();
  let value = writtenOf(node, resolve);
  while (isPrefixUnaryExpression(value)) {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    signs.push(value.operator);
    value = writtenOf(value.operand, resolve);
  }
  let literal = literalValue(value);
  for (const sign of signs.toReversed()) {
    literal = literal === undefined ? undefined : signedLiteral(literal.value, sign);
  }
  return literal === undefined
    ? undefined
    : {
        truth: Boolean(literal.value),
        nullish: literal.value === null || literal.value === undefined,
      };
}

interface Literal {
  readonly value: string | number | boolean | null | undefined;
}

/** A primitive whose value is written directly in the source. */
function literalValue(value: Expression): Literal | undefined {
  if (
    value.kind === SyntaxKind.NullKeyword ||
    isVoidExpression(value) ||
    (isIdentifier(value) && globalOf(value) === 'undefined')
  ) {
    return { value: undefined };
  }
  if (value.kind === SyntaxKind.TrueKeyword || value.kind === SyntaxKind.FalseKeyword) {
    return { value: value.kind === SyntaxKind.TrueKeyword };
  }
  if (isNumericLiteral(value)) {
    return { value: Number(value.text) };
  }
  return isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)
    ? { value: value.text }
    : undefined;
}

/** Logical negation of a literal, or a sign on a literal number; no object or text conversion. */
function signedLiteral(value: Literal['value'], sign: SyntaxKind): Literal | undefined {
  if (sign === SyntaxKind.ExclamationToken) {
    const truth = Boolean(value);
    return { value: !truth };
  }
  if (typeof value !== 'number') {
    return undefined;
  }
  if (sign === SyntaxKind.MinusToken || sign === SyntaxKind.PlusToken) {
    return { value: sign === SyntaxKind.MinusToken ? -value : value };
  }
  return undefined;
}
