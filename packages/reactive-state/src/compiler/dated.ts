import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVoidExpression,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { initializerOf, parameterOf } from './framed.ts';
import { constantValue } from './numbers.ts';

/** What a single Date input shows of an instant, without interpreting text in the host's zone. */
const ISO_DATE = /^(?:\d{4}|[+-]\d{6})(?:-\d{2}(?:-\d{2})?)?$/u;
const ISO_DAY = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}$/u;
const ISO_CLOCK = /^\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Whether a one-argument Date uses no local time: a number, a primitive of no text, another date,
 * or ISO date-only text or a date-time with an explicit offset; constants followed in turn.
 */
export function fixedDateInput(node: Expression, seen = new Set<Expression>()): boolean {
  const value = unwrapped(node);
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  const constant = constantValue(value, initializerOf);
  if (typeof constant === 'number') {
    return true;
  }
  if (typeof constant === 'string') {
    return fixedText(constant);
  }
  if (fixedPrimitive(value)) {
    return true;
  }
  if (isIdentifier(value)) {
    const declared = initializerOf(value);
    return declared === undefined
      ? fixedType(parameterOf(value)?.type)
      : fixedDateInput(declared, seen);
  }
  if (isNewExpression(value)) {
    return globalPathOf(unwrapped(value.expression))?.join('.') === 'Date';
  }
  if (isCallExpression(value)) {
    const path = globalPathOf(unwrapped(value.expression))?.join('.');
    return path === 'Number' || path === 'Date.UTC';
  }
  return false;
}

/** Whether Date.parse receives ISO text that needs no host time zone or legacy date parser. */
export function fixedDateText(node: Expression): boolean {
  const value = constantValue(node, initializerOf);
  return typeof value === 'string' && fixedText(value);
}

/** Whether ISO text names a date or a zoned instant, excluding the forbidden negative-zero year. */
function fixedText(text: string): boolean {
  if (text.startsWith('-000000')) {
    return false;
  }
  const at = text.indexOf('T');
  return (
    ISO_DATE.test(text) ||
    (at !== -1 && ISO_DAY.test(text.slice(0, at)) && ISO_CLOCK.test(text.slice(at + 1)))
  );
}

/** Whether an expression writes a primitive that Date converts without interpreting text. */
function fixedPrimitive(value: Expression): boolean {
  return (
    isVoidExpression(value) ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    globalPathOf(value)?.join('.') === 'undefined'
  );
}

/** Whether a written parameter type can supply no text for the Date constructor to interpret. */
function fixedType(type: TypeNode | undefined): boolean {
  if (type === undefined) {
    return false;
  }
  if (isUnionTypeNode(type)) {
    return type.types.every((each) => fixedType(each));
  }
  return (
    type.kind === SyntaxKind.NumberKeyword ||
    type.kind === SyntaxKind.BooleanKeyword ||
    type.kind === SyntaxKind.UndefinedKeyword ||
    (isTypeReferenceNode(type) && globalOf(type.typeName) === 'Date')
  );
}
