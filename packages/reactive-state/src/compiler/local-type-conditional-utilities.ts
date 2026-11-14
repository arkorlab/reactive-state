import {
  factory,
  isBigIntLiteral,
  isNumericLiteral,
  isLiteralTypeNode,
  isPrefixUnaryExpression,
  isStringLiteral,
  type LiteralTypeNode,
  isIdentifier,
  isTypeReferenceNode,
  isTypeLiteralNode,
  isUnionTypeNode,
  SyntaxKind,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { booleanReadings, wholeUnknown } from './local-type-distribution.ts';
import type { TypeReading } from './local-type-environment.ts';
import { literalKind } from './local-type-utility-readings.ts';

/** Native conditional utilities reuse syntax-known relations and each original argument reading. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;
type Compare = (source: TypeReading, target: TypeReading) => boolean | undefined;
const NEVER = factory.createKeywordTypeNode(SyntaxKind.NeverKeyword);
const OBJECT = factory.createKeywordTypeNode(SyntaxKind.ObjectKeyword);
const NON_NULL_PRIMITIVES = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
]);
const NOT_EMPTY_OBJECT = new Set([
  SyntaxKind.NullKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.UnknownKeyword,
  SyntaxKind.VoidKeyword,
]);

/**
 * Distribute only the checked operand; uncertain relations retain the possible original source.
 * Unless a settled relation retains a source, the result may also be empty: `never` stays one of
 * its alternatives, so no uncertain source stands for the whole result of a conditional check.
 */
export function conditionalUtilityReadings(
  at: TypeReading,
  resolve: Resolve,
  compare: Compare,
): readonly TypeReading[] | undefined {
  const { type } = at;
  if (!isTypeReferenceNode(type)) return undefined;
  const name = nativeName(at);
  if (name !== 'Exclude' && name !== 'Extract') return undefined;
  if (type.typeArguments?.length !== 2) return [];
  const [checked, extended] = type.typeArguments;
  if (checked === undefined || extended === undefined) return [];
  const sources = constituents({ ...at, type: checked }, resolve);
  if (sources === undefined) return undefined;
  const targets = constituents({ ...at, type: extended }, resolve);
  const results: TypeReading[] = [];
  let settled = false;
  for (const source of sources) {
    if (source.type.kind === SyntaxKind.NeverKeyword) continue;
    const selected = matchingSources(source, targets, name === 'Extract', compare);
    results.push(...selected.readings);
    settled ||= selected.settled;
  }
  return settled ? results : [...results, { ...at, type: NEVER }];
}

/** Resolve aliases and actual generic arguments without flattening structural intersections. */
function constituents(at: TypeReading, resolve: Resolve): readonly TypeReading[] | undefined {
  const result: TypeReading[] = [];
  const pending = [at];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const resolved = resolve(next);
    if (resolved === undefined) return undefined;
    const reading = wholeUnknown(resolved, resolve) ?? resolved;
    if (isUnionTypeNode(reading.type))
      pending.push(...reading.type.types.map((type) => ({ ...reading, type })));
    else result.push(reading);
  }
  return result;
}

/** Selected boolean literals retain the original whole domain when both remain possible. */
function matchingSources(
  source: TypeReading,
  targets: readonly TypeReading[] | undefined,
  extract: boolean,
  compare: Compare,
): { readonly readings: readonly TypeReading[]; readonly settled: boolean } {
  const branches = booleanReadings(source) ?? [source];
  const readings: TypeReading[] = [];
  let settled = false;
  for (const branch of branches) {
    const matches = targetRelation(branch, targets, compare);
    if (matches !== undefined && matches !== extract) continue;
    readings.push(branch);
    settled ||= matches !== undefined;
  }
  return { readings: readings.length === branches.length ? [source] : readings, settled };
}

/** A target union accepts a source if any branch is known to accept the whole source. */
function targetRelation(
  source: TypeReading,
  targets: readonly TypeReading[] | undefined,
  compare: Compare,
): boolean | undefined {
  if (targets === undefined) return undefined;
  let unknown = false;
  for (const target of targets) {
    const matches = emptyObjectRelation(source, target, compare) ?? compare(source, target);
    if (matches === true) return true;
    if (matches === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}
/** A native conditional utility name, after lexical type binding resolution. */
function nativeName(at: TypeReading): string | undefined {
  if (!isTypeReferenceNode(at.type)) return undefined;
  const { typeName } = at.type;
  if (!isIdentifier(typeName)) return qualifiedBuiltinName(typeName);
  return localTypeBinding(typeName) === undefined ? typeName.text : undefined;
}

/** A literal's value, so quoting, escapes and numeric spelling do not change a comparison. */
export function literalValue(type: LiteralTypeNode): string | undefined {
  const literal = type.literal;
  if (isStringLiteral(literal)) return `string:${literal.text}`;
  if (isNumericLiteral(literal)) return `number:${String(Number(literal.text))}`;
  if (isBigIntLiteral(literal))
    return `bigint:${String(BigInt(literal.text.replaceAll('_', '').slice(0, -1)))}`;
  if (literal.kind === SyntaxKind.TrueKeyword) return 'boolean:true';
  if (literal.kind === SyntaxKind.FalseKeyword) return 'boolean:false';
  if (literal.kind === SyntaxKind.NullKeyword) return 'null';
  if (isPrefixUnaryExpression(literal) && isNumericLiteral(literal.operand)) {
    const value = Number(literal.operand.text);
    return `number:${String(literal.operator === SyntaxKind.MinusToken ? -value : value)}`;
  }
  return undefined;
}

/** An explicitly empty object constraint accepts known non-nullish primitive and object sources. */
function emptyObjectRelation(
  source: TypeReading,
  target: TypeReading,
  compare: Compare,
): boolean | undefined {
  if (!isTypeLiteralNode(target.type) || target.type.members.length > 0) return undefined;
  const kind = isLiteralTypeNode(source.type) ? literalKind(source.type) : source.type.kind;
  if (NOT_EMPTY_OBJECT.has(kind)) return false;
  if (NON_NULL_PRIMITIVES.has(kind)) return true;
  return compare(source, { ...target, type: OBJECT }) === true ? true : undefined;
}
