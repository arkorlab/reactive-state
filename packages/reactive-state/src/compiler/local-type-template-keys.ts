import {
  isBigIntLiteral,
  isExpressionWithTypeArguments,
  isLiteralTypeNode,
  isPrefixUnaryExpression,
  isTemplateLiteralTypeNode,
  SyntaxKind,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { literalKey } from './local-type-utility-readings.ts';

/** Finite written template index keys retain each interpolation's original argument environment. */

type Operands = (reading: TypeReading) => readonly TypeReading[];
type WordMapping = (
  reading: TypeReading,
  words: (argument: TypeReading) => readonly string[] | undefined,
) => readonly string[] | undefined;

/** Literal property keys and finite template combinations; nonfinite or unresolved spans stay opaque. */
export function finiteIndexKeys(
  at: TypeReading,
  operands: Operands,
  mapping?: WordMapping,
): readonly string[] | undefined {
  const keys = new Set<string>();
  for (const reading of operands(at)) {
    if (isExpressionWithTypeArguments(reading.type)) return undefined;
    const key = literalKey(reading.type);
    if (key !== undefined) {
      keys.add(key);
      continue;
    }
    if (reading.type.kind === SyntaxKind.NeverKeyword) continue;
    const words = computedWords(reading, operands, mapping);
    if (words === undefined) return undefined;
    for (const word of words) keys.add(word);
  }
  return [...keys];
}

/** Optional native mappings compose with templates without changing the existing literal projection. */
function computedWords(
  at: TypeReading,
  operands: Operands,
  mapping?: WordMapping,
): readonly string[] | undefined {
  return (
    mapping?.(at, (argument) => interpolationWords(argument, operands, mapping)) ??
    templateWords(at, operands, mapping)
  );
}

/** Each known interpolation contributes its finite alternatives before the next literal suffix. */
function templateWords(
  at: TypeReading,
  operands: Operands,
  mapping?: WordMapping,
): readonly string[] | undefined {
  const { type } = at;
  if (!isTemplateLiteralTypeNode(type)) return undefined;
  let prefixes: readonly string[] = [type.head.text];
  for (const span of type.templateSpans) {
    const words = interpolationWords({ ...at, type: span.type }, operands, mapping);
    if (words === undefined) return undefined;
    prefixes = prefixes.flatMap((prefix) =>
      words.map((word) => `${prefix}${word}${span.literal.text}`),
    );
  }
  return prefixes;
}

/** Aliases, actual arguments and finite primitive literals supply only source-written text. */
function interpolationWords(
  at: TypeReading,
  operands: Operands,
  mapping?: WordMapping,
): readonly string[] | undefined {
  const words = new Set<string>();
  for (const reading of operands(at)) {
    if (reading.type.kind === SyntaxKind.NeverKeyword) continue;
    if (reading.type.kind === SyntaxKind.BooleanKeyword) {
      words.add('true');
      words.add('false');
      continue;
    }
    const word = interpolationLiteral(reading.type);
    if (word !== undefined) {
      words.add(word);
      continue;
    }
    const nested = computedWords(reading, operands, mapping);
    if (nested === undefined) return undefined;
    for (const value of nested) words.add(value);
  }
  return [...words];
}

/** Template primitive literals use JavaScript's text spelling without evaluating application code. */
function interpolationLiteral(type: TypeReading['type']): string | undefined {
  if (isExpressionWithTypeArguments(type)) return undefined;
  if (type.kind === SyntaxKind.UndefinedKeyword) return 'undefined';
  const key = literalKey(type);
  if (key !== undefined) return key;
  if (!isLiteralTypeNode(type)) return undefined;
  const { literal } = type;
  if (literal.kind === SyntaxKind.TrueKeyword) return 'true';
  if (literal.kind === SyntaxKind.FalseKeyword) return 'false';
  if (literal.kind === SyntaxKind.NullKeyword) return 'null';
  if (isBigIntLiteral(literal)) return bigintText(literal.text);
  return isPrefixUnaryExpression(literal) &&
    literal.operator === SyntaxKind.MinusToken &&
    isBigIntLiteral(literal.operand)
    ? String(-BigInt(bigintText(literal.operand.text)))
    : undefined;
}

/** A written bigint literal's decimal text excludes separators and the syntax-only suffix. */
function bigintText(text: string): string {
  return String(BigInt(text.replaceAll('_', '').slice(0, -1)));
}
