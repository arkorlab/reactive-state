import {
  factory,
  isArrayTypeNode,
  isBlock,
  isConstructorTypeNode,
  isClassDeclaration,
  isClassExpression,
  isInterfaceDeclaration,
  isEnumDeclaration,
  isExpression,
  isFunctionTypeNode,
  isIdentifier,
  isLiteralTypeNode,
  isModuleBlock,
  isMethodSignatureDeclaration,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isQualifiedName,
  isSourceFile,
  isStringLiteral,
  isTupleTypeNode,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  isTypeQueryNode,
  isUnionTypeNode,
  SyntaxKind,
  TokenFlags,
  type EnumDeclaration,
  type Expression,
  type Identifier,
  type TypeElement,
  type TypeLiteralNode,
  type LiteralTypeNode,
} from 'typescript/ast';

import { frameBindingOf } from './framed-bindings.ts';
import { localTypeBinding } from './local-type-aliases.ts';
import { selectedMethodType } from './local-type-callable-members.ts';
import type { TypeReading } from './local-type-environment.ts';
import { memberValue, sourceMember } from './local-type-inference-work.ts';
import { inferredCandidates } from './local-type-inferred-candidates.ts';
import { qualifiedLocalTypeBinding } from './local-type-namespaces.ts';
import { memberName, optionalMember, propertyMember } from './local-type-weak-objects.ts';

/** Closed written discriminants distinguish whole-object never from a merely never-valued field. */
type Resolve = (reading: TypeReading) => TypeReading | undefined;
interface Source {
  readonly sources: readonly (TypeReading & { readonly type: TypeLiteralNode })[];
  readonly unknown: boolean;
}
interface Field {
  readonly member: TypeElement;
  readonly reading: TypeReading;
}
interface EnumInitializer {
  readonly identity: string | number;
  readonly literal: LiteralTypeNode['literal'];
}
interface EnumValue {
  /** None of a plain literal, which no enum member's type shares, however equal their values. */
  readonly declaration: EnumDeclaration | undefined;
  readonly value: string | number;
}
interface Domain {
  readonly readings: readonly TypeReading[];
  readonly discriminant: boolean;
  readonly never: boolean;
  readonly unknown: boolean;
  readonly enums: readonly EnumValue[];
  readonly symbolSets: readonly ReadonlySet<TypeReading['type']>[];
}
const EMPTY: Domain = {
  readings: [],
  discriminant: false,
  never: false,
  unknown: false,
  enums: [],
  symbolSets: [],
};
const OBJECT_NAMES = new Set([
  'AggregateError',
  'Array',
  'BigInt',
  'Boolean',
  'Date',
  'DOMException',
  'Error',
  'EvalError',
  'Function',
  'Map',
  'Number',
  'Object',
  'Promise',
  'PromiseLike',
  'RangeError',
  'ReadonlyArray',
  'ReadonlyMap',
  'ReadonlySet',
  'ReferenceError',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

const PRIMITIVES = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.ObjectKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.VoidKeyword,
]);
const UNDEFINED = factory.createKeywordTypeNode(SyntaxKind.UndefinedKeyword);

/** A required contradictory finite discriminant reduces the intersection before member rejection. */
export function emptyObjectIntersection(source: Source, resolve: Resolve): boolean | undefined {
  if (source.unknown) return undefined;
  const fields = writtenFields(source);
  if (fields === undefined) return undefined;
  let unknown = false;
  for (const group of fields.values()) {
    const empty = emptyField(group, resolve);
    if (empty === true) return true;
    if (empty === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

/** Readable named suppliers retain their own type argument environments. */
function writtenFields(source: Source): ReadonlyMap<string, readonly Field[]> | undefined {
  const fields = new Map<string, Field[]>();
  for (const reading of source.sources) {
    for (const member of reading.type.members) {
      const name = memberName(member);
      if (name === undefined) {
        if (propertyMember(member)) return undefined;
        continue;
      }
      if (sourceMember(reading.type, name) !== member) continue;
      const list = fields.get(name) ?? [];
      list.push({ member, reading });
      fields.set(name, list);
    }
  }
  return fields;
}

/** Optional-only conflicts allow absence; an explicitly never-valued field alone is not bottom. */
function emptyField(fields: readonly Field[], resolve: Resolve): boolean | undefined {
  if (fields.length < 2 || fields.every(({ member }) => optionalMember(member))) return false;
  const domain = fieldDomain(fields, resolve);
  if (domain.never || !domain.discriminant) return false;
  if (domain.unknown || conflictingEnums(domain)) return undefined;
  const candidates = domain.readings.map((reading) => ({ reading, contravariant: true }));
  if (candidates.length < 2) return false;
  const combined = inferredCandidates(candidates, resolve);
  if (combined.length !== 1) return undefined;
  const type = combined[0]?.type;
  return (
    type?.kind === SyntaxKind.NeverKeyword ||
    (type !== undefined && onlySymbol(type) && disjointSymbols(domain.symbolSets))
  );
}

/**
 * Original scopes survive each explicit property's finite primitive domain. A field discriminates
 * only where some supplier's whole domain is units, as TypeScript's literal part must be: a literal
 * arm beside a wide type, as in `'a' | string`, does not.
 */
function fieldDomain(fields: readonly Field[], resolve: Resolve): Domain {
  const readings: TypeReading[] = [];
  const enums: EnumValue[] = [];
  const symbolSets: Domain['symbolSets'][number][] = [];
  let discriminant = false;
  let never = false;
  let unknown = false;
  for (const field of fields) {
    const reading = fieldReading(field);
    const domain =
      reading === undefined
        ? { ...EMPTY, unknown: true, discriminant: true }
        : primitiveDomain(reading, resolve, optionalMember(field.member));
    readings.push(...domain.readings);
    enums.push(...domain.enums);
    symbolSets.push(...domain.symbolSets);
    discriminant ||= domain.discriminant;
    never ||= domain.never;
    unknown ||= domain.unknown;
  }
  return { readings, enums, symbolSets, discriminant, never, unknown };
}

/**
 * Union alternatives stay covariant inside a property before distinct suppliers intersect. An
 * optional property's domain holds `undefined` beside its written type, as TypeScript reads it.
 */
function primitiveDomain(at: TypeReading, resolve: Resolve, optional: boolean): Domain {
  const pending: {
    readonly reading: TypeReading;
    readonly ancestors: ReadonlySet<TypeReading['type']>;
  }[] = [{ reading: at, ancestors: new Set() }];
  if (optional) pending.push({ reading: { ...at, type: UNDEFINED }, ancestors: new Set() });
  const readings: TypeReading[] = [];
  const enums: EnumValue[] = [];
  const symbolSets: Domain['symbolSets'][number][] = [];
  let broadSymbol = false;
  let discriminant = true;
  let unknown = false;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const reading = resolve(next.reading);
    if (reading === undefined || next.ancestors.has(reading.type))
      return { ...EMPTY, unknown: true, discriminant: true };
    const selected = uniqueSymbolReading(reading, resolve) ?? reading;
    const { type } = selected;
    if (type.kind === SyntaxKind.AnyKeyword || type.kind === SyntaxKind.UnknownKeyword)
      return EMPTY;
    if (type.kind === SyntaxKind.NeverKeyword) continue;
    if (isUnionTypeNode(type)) {
      const ancestors = new Set([...next.ancestors, type]);
      pending.push(
        ...type.types.map((part) => ({ reading: { ...reading, type: part }, ancestors })),
      );
      continue;
    }
    broadSymbol ||= type.kind === SyntaxKind.SymbolKeyword;
    const domain = leafDomain(selected);
    readings.push(...domain.readings);
    enums.push(...domain.enums);
    symbolSets.push(...domain.symbolSets);
    discriminant &&= domain.discriminant;
    unknown ||= domain.unknown;
  }
  const combined = inferredCandidates(
    readings.map((reading) => ({ reading, contravariant: false })),
    resolve,
  );
  return {
    readings: combined,
    enums,
    symbolSets: symbolUnion(symbolSets, broadSymbol),
    discriminant,
    never: readings.length === 0,
    unknown,
  };
}

/** Literal and boolean domains are discriminants; opaque references retain possible empty branches. */
function leafDomain(reading: TypeReading): Domain {
  const enumValue = enumDomain(reading);
  if (enumValue !== undefined) return enumValue;
  const { type } = reading;
  if (
    isTypeOperatorNode(type) &&
    type.operator === SyntaxKind.UniqueKeyword &&
    type.type.kind === SyntaxKind.SymbolKeyword
  )
    return {
      ...EMPTY,
      readings: [{ ...reading, type: factory.createKeywordTypeNode(SyntaxKind.SymbolKeyword) }],
      discriminant: true,
      symbolSets: [new Set([type])],
    };
  const discriminant =
    isLiteralTypeNode(type) ||
    type.kind === SyntaxKind.BooleanKeyword ||
    type.kind === SyntaxKind.UndefinedKeyword;
  const closed =
    PRIMITIVES.has(type.kind) ||
    isLiteralTypeNode(type) ||
    isTypeLiteralNode(type) ||
    isArrayTypeNode(type) ||
    isTupleTypeNode(type) ||
    isFunctionTypeNode(type) ||
    isConstructorTypeNode(type) ||
    objectReference(type);
  const plain =
    isLiteralTypeNode(type) && isExpression(type.literal) ? enumLiteral(type.literal) : undefined;
  return {
    readings: [reading],
    enums: plain === undefined ? [] : [{ declaration: undefined, value: plain.identity }],
    symbolSets: [],
    never: false,
    discriminant: discriminant || !closed,
    unknown: !closed,
  };
}

/**
 * Equal-valued members from distinct enum declarations, and a member beside a plain literal of its
 * value, retain their nominal relation as opaque: TypeScript keeps each enum member's type apart.
 */
function conflictingEnums(domain: Domain): boolean {
  return domain.enums.some((left) => {
    return domain.enums.some((right) => {
      const distinct = left.declaration !== right.declaration;
      return distinct && left.value === right.value;
    });
  });
}

/** Local literal enum members retain the declaration that gives their discriminant its identity. */
function enumDomain(reading: TypeReading): Domain | undefined {
  const { type } = reading;
  if (
    !isTypeReferenceNode(type) ||
    !isQualifiedName(type.typeName) ||
    !isIdentifier(type.typeName.left)
  )
    return undefined;
  const declaration = enumDeclaration(type.typeName.left);
  const name = type.typeName.right.text;
  const value = declaration === undefined ? undefined : enumMemberValue(declaration, name);
  if (declaration === undefined || value === undefined) return undefined;
  return {
    readings: [{ ...reading, type: factory.createLiteralTypeNode(value.literal) }],
    discriminant: true,
    never: false,
    unknown: false,
    enums: [{ declaration, value: value.identity }],
    symbolSets: [],
  };
}

/** A nearer lexical enum owns its literal members; imports and other type bindings remain opaque. */
function enumDeclaration(name: Identifier): EnumDeclaration | undefined {
  if (localTypeBinding(name) !== null) return undefined;
  for (let node = name.parent; ; node = node.parent) {
    if (isBlock(node) || isSourceFile(node) || isModuleBlock(node)) {
      const declared = node.statements.find(
        (statement) => isEnumDeclaration(statement) && statement.name.text === name.text,
      );
      if (declared !== undefined && isEnumDeclaration(declared)) return declared;
    }
    if (isSourceFile(node)) return undefined;
  }
}

/** Explicit literal values and native numeric auto-increments retain source member order. */
function enumMemberValue(declaration: EnumDeclaration, name: string): EnumInitializer | undefined {
  let previous: number | undefined = -1;
  for (const member of declaration.members) {
    const value: EnumInitializer | undefined =
      member.initializer === undefined
        ? automaticEnumValue(previous)
        : enumLiteral(member.initializer);
    if ((isIdentifier(member.name) || isStringLiteral(member.name)) && member.name.text === name)
      return value;
    previous = typeof value?.identity === 'number' ? value.identity : undefined;
  }
  return undefined;
}

/** An omitted numeric initializer follows the preceding known numeric member. */
function automaticEnumValue(previous: number | undefined): EnumInitializer | undefined {
  if (previous === undefined) return undefined;
  const identity = previous + 1;
  return { identity, literal: factory.createNumericLiteral(String(identity), TokenFlags.None) };
}

/** Only explicitly written string and signed numeric enum initializers establish a literal value. */
function enumLiteral(value: Expression): EnumInitializer | undefined {
  if (isStringLiteral(value))
    return {
      identity: value.text,
      literal: factory.createStringLiteral(value.text, TokenFlags.None),
    };
  if (isNumericLiteral(value))
    return {
      identity: Number(value.text),
      literal: factory.createNumericLiteral(value.text, TokenFlags.None),
    };
  if (!isPrefixUnaryExpression(value) || !isNumericLiteral(value.operand)) return undefined;
  if (value.operator !== SyntaxKind.MinusToken && value.operator !== SyntaxKind.PlusToken)
    return undefined;
  const identity =
    value.operator === SyntaxKind.MinusToken
      ? -Number(value.operand.text)
      : Number(value.operand.text);
  return {
    identity,
    literal: factory.createPrefixUnaryExpression(
      value.operator,
      factory.createNumericLiteral(value.operand.text, TokenFlags.None),
    ),
  };
}

/** A broad symbol arm covers every source-written unique symbol in that property union. */
function symbolUnion(sets: Domain['symbolSets'], broad: boolean): Domain['symbolSets'] {
  if (broad) return [];
  const joined = new Set(sets.flatMap((set) => [...set]));
  return joined.size === 0 ? [] : [joined];
}

/** Distinct declared unique symbols have no shared symbol member across required suppliers. */
function disjointSymbols(sets: Domain['symbolSets']): boolean {
  const [first] = sets;
  if (first === undefined) return false;
  const shared = new Set(first);
  for (const other of sets.slice(1)) {
    for (const symbol of shared) if (!other.has(symbol)) shared.delete(symbol);
  }
  return shared.size === 0;
}

/** Other primitive alternatives keep a nonempty property even if its unique symbols are disjoint. */
function onlySymbol(type: TypeReading['type']): boolean {
  if (type.kind === SyntaxKind.SymbolKeyword) return true;
  return (
    isUnionTypeNode(type) && type.types.every((part) => part.kind === SyntaxKind.SymbolKeyword)
  );
}

/** Classes and interfaces remain object-valued even if their own fields are incompatible. */
function objectReference(type: TypeReading['type']): boolean {
  if (!isTypeReferenceNode(type)) return false;
  const binding = isIdentifier(type.typeName)
    ? localTypeBinding(type.typeName)
    : qualifiedLocalTypeBinding(type.typeName);
  if (binding === undefined)
    return isIdentifier(type.typeName) && OBJECT_NAMES.has(type.typeName.text);
  return (
    binding !== null &&
    (isClassDeclaration(binding) || isClassExpression(binding) || isInterfaceDeclaration(binding))
  );
}

/** Only a closed declared unique-symbol annotation supplies identity; value aliases prove none. */
function uniqueSymbolReading(at: TypeReading, resolve: Resolve): TypeReading | undefined {
  let reading = at;
  const seen = new Set<TypeReading['type']>();
  while (!seen.has(reading.type)) {
    seen.add(reading.type);
    const { type } = reading;
    if (
      isTypeOperatorNode(type) &&
      type.operator === SyntaxKind.UniqueKeyword &&
      type.type.kind === SyntaxKind.SymbolKeyword
    )
      return reading;
    if (!isTypeQueryNode(type) || !isIdentifier(type.exprName)) return undefined;
    const selected = frameBindingOf(type.exprName);
    if (selected === undefined || selected.keys.length > 0 || selected.binding.type === undefined)
      return undefined;
    const next = { ...reading, type: selected.binding.type };
    reading = resolve(next) ?? next;
  }
  return undefined;
}

/** Method values are callable object types, rather than an opaque missing property annotation. */
function fieldReading(field: Field): TypeReading | undefined {
  const value = memberValue(field.member);
  if (value !== undefined) return { ...field.reading, type: value };
  return isMethodSignatureDeclaration(field.member)
    ? { ...field.reading, type: selectedMethodType([field.member]) }
    : undefined;
}
