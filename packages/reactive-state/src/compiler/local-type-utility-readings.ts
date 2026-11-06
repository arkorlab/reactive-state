import {
  factory,
  isArrayTypeNode,
  isCallSignatureDeclaration,
  isConstructSignatureDeclaration,
  isConstructorTypeNode,
  isFunctionTypeNode,
  isGetAccessorDeclaration,
  isSetAccessorDeclaration,
  type TypeLiteralNode,
  isPropertySignatureDeclaration,
  isIdentifier,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  type LiteralTypeNode,
  isStringLiteral,
  isTupleTypeNode,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { typeReadingKey, type TypeReading } from './local-type-environment.ts';
import { omittedNumericKey } from './local-type-omit-keys.ts';
import { memberName, optionalMember } from './local-type-weak-objects.ts';

/** Native utility selections retain their original argument scopes rather than synthetic types. */

const NON_THENABLE_ERRORS = new Set([
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

const ACTIVE_AWAITED = new Set<string>();

/** Keyword types no `then` member can make thenable, which Awaited leaves as they are. */
const SETTLED_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.VoidKeyword,
]);

/** What an awaited constituent the compile cannot settle reads as: anything. */
const UNSETTLED = factory.createKeywordTypeNode(SyntaxKind.AnyKeyword);

/**
 * Awaited follows known native Promise wrappers to what they settle: a non-thenable Error, and
 * plain data — a primitive, a literal, an array, a written object of no `then` member — as they
 * are; a constituent it cannot settle, an open parameter or another thenable, reads as `any`, so
 * neither an Error-only projection nor one known part stands for the whole operand.
 */
export function awaitedReadings(
  at: TypeReading,
  resolve: (reading: TypeReading) => readonly TypeReading[],
): readonly TypeReading[] | undefined {
  if (nativeName(at) !== 'Awaited') return undefined;
  const argument =
    isTypeReferenceNode(at.type) && at.type.typeArguments?.length === 1
      ? at.type.typeArguments[0]
      : undefined;
  if (argument === undefined) return [];
  const key = typeReadingKey(at);
  if (ACTIVE_AWAITED.has(key)) return [];
  ACTIVE_AWAITED.add(key);
  try {
    return awaitedArgumentReadings({ ...at, type: argument }, resolve);
  } finally {
    ACTIVE_AWAITED.delete(key);
  }
}

/** Known native awaitable results, cutting repeated source syntax during nested utility selection. */
function awaitedArgumentReadings(
  at: TypeReading,
  resolve: (reading: TypeReading) => readonly TypeReading[],
): readonly TypeReading[] {
  const result: TypeReading[] = [];
  const pending: TypeReading[] = [at];
  const seen = new Set<string>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const reading of resolve(next)) {
      const key = typeReadingKey(reading);
      if (seen.has(key)) continue;
      seen.add(key);
      if (isUnionTypeNode(reading.type)) {
        pending.push(...reading.type.types.map((type) => ({ ...reading, type })));
        continue;
      }
      const wrapped = promiseReading(reading);
      if (wrapped !== undefined) pending.push(wrapped);
      else if (reading.type.kind === SyntaxKind.NeverKeyword) continue;
      else if (NON_THENABLE_ERRORS.has(nativeName(reading) ?? '') || settled(reading, resolve))
        result.push(reading);
      else if (result.every((each) => each.type !== UNSETTLED))
        result.push({ ...reading, type: UNSETTLED });
    }
  }
  return result;
}

/** Plain data Awaited leaves as it is: no member of it can be a `then` the compile does not see. */
function settled(
  reading: TypeReading,
  resolve: (reading: TypeReading) => readonly TypeReading[],
): boolean {
  const { type } = reading;
  if (SETTLED_KEYWORDS.has(type.kind) || isLiteralTypeNode(type)) return true;
  if (isArrayTypeNode(type) || isTupleTypeNode(type)) return true;
  if (!isTypeLiteralNode(type)) return false;
  if (
    type.members.some((member) => {
      const named = memberName(member) !== undefined;
      return (
        !named && !isCallSignatureDeclaration(member) && !isConstructSignatureDeclaration(member)
      );
    })
  )
    return false;
  const value = thenFieldType(type);
  if (value === null) return true;
  if (value === undefined) return false;
  const values = resolve({ ...reading, type: value });
  const results = values.map((operand) => noncallableThen(operand));
  return (
    results.length > 0 && results.every((result) => result !== undefined) && results.includes(true)
  );
}

/** A getter's read type precedes a paired setter; optional or absent then leaves the object intact. */
function thenFieldType(type: TypeLiteralNode): TypeNode | null | undefined {
  const selected = type.members.filter((member) => memberName(member) === 'then');
  if (selected.length === 0) return null;
  const getters = selected.filter((member) => isGetAccessorDeclaration(member));
  if (getters.length > 0) return getters.length === 1 ? getters[0]?.type : undefined;
  const [member] = selected;
  if (member === undefined || selected.length !== 1) return undefined;
  if (optionalMember(member)) return null;
  if (isPropertySignatureDeclaration(member)) return member.type;
  return isSetAccessorDeclaration(member) ? member.parameters[0]?.type : undefined;
}

/** A required then field is noncallable only through its closed written value domain. */
function noncallableThen(reading: TypeReading): boolean | undefined {
  const { type } = reading;
  if (
    SETTLED_KEYWORDS.has(type.kind) ||
    isLiteralTypeNode(type) ||
    type.kind === SyntaxKind.UnknownKeyword ||
    type.kind === SyntaxKind.ObjectKeyword
  )
    return true;
  if (isFunctionTypeNode(type)) return false;
  if (isConstructorTypeNode(type) || isArrayTypeNode(type) || isTupleTypeNode(type)) return true;
  const name = nativeName(reading);
  if (
    name === 'Date' ||
    name === 'RegExp' ||
    name === 'Promise' ||
    name === 'PromiseLike' ||
    NON_THENABLE_ERRORS.has(name ?? '')
  )
    return true;
  if (isTypeLiteralNode(type)) {
    if (type.members.some((member) => isCallSignatureDeclaration(member))) return false;
    return type.members.every((member) => memberName(member) !== undefined) ? true : undefined;
  }
  return undefined;
}

/** Native promise wrappers retain the same lexical bindings and expanded-alias path. */
function promiseReading(reading: TypeReading): TypeReading | undefined {
  const name = nativeName(reading);
  const { type } = reading;
  if (
    (name !== 'Promise' && name !== 'PromiseLike') ||
    !isTypeReferenceNode(type) ||
    type.typeArguments?.length !== 1
  )
    return undefined;
  const value = type.typeArguments[0];
  return value === undefined ? undefined : { ...reading, type: value };
}

interface Selection {
  readonly operands: (reading: TypeReading) => readonly TypeReading[];
  readonly select: (reading: TypeReading, key: string) => readonly TypeReading[];
}

/** A requested property survives Pick or Omit according to its original key argument. */
export function projectedMemberReadings(
  at: TypeReading,
  key: string,
  selection: Selection,
): readonly TypeReading[] | undefined {
  const name = nativeName(at);
  if (name !== 'Pick' && name !== 'Omit' && name !== 'Record') return undefined;
  if (!isTypeReferenceNode(at.type) || at.type.typeArguments?.length !== 2) return [];
  const [object, keys] = at.type.typeArguments;
  if (object === undefined || keys === undefined) return [];
  if (name === 'Record') {
    return keyIncluded(key, selection.operands({ ...at, type: object })) === false
      ? []
      : [{ ...at, type: keys }];
  }
  const excluded = selection.operands({ ...at, type: keys });
  const matches = keyIncluded(key, excluded);
  if (name === 'Pick' && matches === false) return [];
  if (name === 'Omit' && matches === true) {
    const numeric = key !== '' && String(Number(key)) === key;
    if (!numeric || omittedNumericKey({ ...at, type: object }, key, excluded, selection.operands))
      return [];
  }
  return selection.select({ ...at, type: object }, key);
}

/** Finite indexed selections reuse the same projection and each original argument environment. */
export function projectedIndexReadings(
  at: TypeReading,
  index: TypeReading,
  selection: Selection,
): readonly TypeReading[] | undefined {
  const name = nativeName(at);
  if (name !== 'Pick' && name !== 'Omit' && name !== 'Record') return undefined;
  const keys: string[] = [];
  for (const reading of selection.operands(index)) {
    if (!isLiteralTypeNode(reading.type)) return undefined;
    const key = literalKey(reading.type);
    if (key === undefined) return undefined;
    keys.push(key);
  }
  return keys.flatMap((key) => projectedMemberReadings(at, key, selection) ?? []);
}

/** A native utility or Error-family name, with local type and namespace shadows retained. */
function nativeName(reading: TypeReading): string | undefined {
  const { type } = reading;
  if (!isTypeReferenceNode(type)) return undefined;
  if (isIdentifier(type.typeName))
    return localTypeBinding(type.typeName) === undefined ? type.typeName.text : undefined;
  return qualifiedBuiltinName(type.typeName);
}

/** Known key alternatives denote a set; unresolved alternatives keep either projection possible. */
function keyIncluded(key: string, readings: readonly TypeReading[]): boolean | undefined {
  let unknown = false;
  for (const { type } of readings) {
    if (type.kind === SyntaxKind.NeverKeyword) continue;
    if (type.kind === SyntaxKind.StringKeyword) return true;
    if (key !== '' && type.kind === SyntaxKind.NumberKeyword && String(Number(key)) === key)
      return true;
    const selected = isLiteralTypeNode(type) ? literalKey(type) : undefined;
    if (selected === key) return true;
    if (selected === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

/** Literal string and numeric property names; arbitrary key computations stay opaque. */
export function literalKey(type: TypeNode): string | undefined {
  if (!isLiteralTypeNode(type)) return undefined;
  const value = type.literal;
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (isNumericLiteral(value)) return String(Number(value.text));
  if (isPrefixUnaryExpression(value) && isNumericLiteral(value.operand)) {
    const number = Number(value.operand.text);
    return String(value.operator === SyntaxKind.MinusToken ? -number : number);
  }
  return undefined;
}

/** The primitive category of a literal type. */
export function literalKind(type: LiteralTypeNode): SyntaxKind {
  const node = isPrefixUnaryExpression(type.literal) ? type.literal.operand : type.literal;
  const literal = node.kind;
  if (literal === SyntaxKind.StringLiteral) return SyntaxKind.StringKeyword;
  if (literal === SyntaxKind.NumericLiteral) return SyntaxKind.NumberKeyword;
  if (literal === SyntaxKind.BigIntLiteral) return SyntaxKind.BigIntKeyword;
  return literal === SyntaxKind.TrueKeyword || literal === SyntaxKind.FalseKeyword
    ? SyntaxKind.BooleanKeyword
    : literal;
}

/** These standard error interfaces add no instance members to Error's structural type. */
export const STANDARD_ERRORS = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
