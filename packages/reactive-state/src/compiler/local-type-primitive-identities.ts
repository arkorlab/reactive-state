import {
  type ExpressionWithTypeArguments,
  isComputedPropertyName,
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isPropertySignatureDeclaration,
  isTypeLiteralNode,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  type TypeNode,
  type TypeReferenceNode,
  SyntaxKind,
} from 'typescript/ast';

import type { LocalTypeBinding } from './local-type-aliases.ts';
import { literalValue } from './local-type-conditional-utilities.ts';
import { initialTypeReading, type TypeReading } from './local-type-environment.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { memberName, optionalMember } from './local-type-weak-objects.ts';

/** Written primitive alternatives retain possible SameValueZero keys beside native Error identities. */

export type Reference = TypeReferenceNode | ExpressionWithTypeArguments;

interface IdentityResolver {
  readonly resolve: (at: TypeReading, utilities?: boolean) => TypeReading | undefined;
  readonly members: (
    type: TypeReading['type'],
    at: TypeReading,
    names: ReadonlySet<string>,
  ) => readonly TypeReading[] | undefined;
  readonly reference: (
    type: TypeReading['type'],
  ) => { readonly binding: LocalTypeBinding; readonly builtin: string | undefined } | undefined;
  readonly referred: (
    binding: LocalTypeBinding,
    reference: Reference,
    at: TypeReading,
  ) => readonly TypeReading[];
  readonly names: (readings: readonly TypeReading[]) => boolean;
}

/** The original conditional comparison keyword set, moved unchanged to keep its reader bounded. */
export const COMPARISON_PRIMITIVES = new Set([
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

const IDENTITY_PRIMITIVES: ReadonlyMap<SyntaxKind, readonly string[]> = new Map([
  [SyntaxKind.AnyKeyword, ['*']],
  [SyntaxKind.ArrayType, []],
  [SyntaxKind.BooleanKeyword, ['primitive:true', 'primitive:false']],
  [SyntaxKind.ConstructorType, []],
  [SyntaxKind.FunctionType, []],
  [SyntaxKind.NullKeyword, ['primitive:null']],
  [SyntaxKind.NumberKeyword, ['primitive:number:*']],
  [SyntaxKind.ObjectKeyword, []],
  [SyntaxKind.StringKeyword, ['primitive:text:*']],
  [SyntaxKind.TupleType, []],
  [SyntaxKind.UndefinedKeyword, ['primitive:undefined']],
  [SyntaxKind.UnknownKeyword, ['*']],
  [SyntaxKind.VoidKeyword, ['*']],
]);
const ERROR_WORDS = new Set(['message', 'name', 'stack']);
const CLOSED = new Set([
  SyntaxKind.ArrayType,
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.ConstructorType,
  SyntaxKind.FunctionType,
  SyntaxKind.LiteralType,
  SyntaxKind.NeverKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.ObjectKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.TupleType,
  SyntaxKind.TypeLiteral,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.UnknownKeyword,
]);

/** The original type reader supplies alias bodies, actual arguments and union alternatives. */
export function primitiveKeysReader(
  tools: IdentityResolver,
): (type: TypeNode | undefined) => readonly string[] {
  return (type) => {
    if (type === undefined) return ['*'];
    const pending = [initialTypeReading(type)];
    const seen = new Set<TypeReading>();
    const keys = new Set<string>();
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (seen.has(at)) continue;
      seen.add(at);
      const next = identityOperands(at, tools);
      if (next === undefined) for (const key of primitiveKeys(at)) keys.add(key);
      else pending.push(...next);
    }
    return [...keys];
  };
}

/** Unresolved non-Error alternatives cannot prove separation from every primitive value. */
function identityOperands(
  at: TypeReading,
  tools: IdentityResolver,
): readonly TypeReading[] | undefined {
  if (isIntersectionTypeNode(at.type)) {
    return nativeIntersection(at, tools) ? [] : undefined;
  }
  const members = tools.members(at.type, at, STANDARD_ERRORS);
  if (members !== undefined) return members;
  const referred = tools.reference(at.type);
  if (
    referred?.binding !== undefined &&
    referred.binding !== null &&
    (isTypeAliasDeclaration(referred.binding) || isTypeParameterDeclaration(referred.binding))
  ) {
    const next = tools.referred(referred.binding, at.type as Reference, at);
    return next.length === 0 ? undefined : next;
  }
  return tools.names([at]) || closedErrorData(at) ? [] : undefined;
}

/** Required source-owned Error word fields exclude native primitive identities without comparing values. */
function closedErrorData(at: TypeReading): boolean {
  const { type } = at;
  return (
    isTypeLiteralNode(type) &&
    type.pos >= 0 &&
    type.members.every((member) => {
      return (
        isPropertySignatureDeclaration(member) &&
        member.pos >= 0 &&
        !isComputedPropertyName(member.name) &&
        memberName(member) !== undefined
      );
    }) &&
    type.members.some(
      (member) => !optionalMember(member) && ERROR_WORDS.has(memberName(member) ?? ''),
    )
  );
}

/** A native Error conjunct beside closed source types still excludes primitive identities. */
function nativeIntersection(at: TypeReading, tools: IdentityResolver): boolean {
  if (!isIntersectionTypeNode(at.type)) return false;
  const operands = at.type.types.map((type) => tools.resolve({ ...at, type }, true));
  const native = (reading: TypeReading | undefined) => {
    const reference = reading === undefined ? undefined : tools.reference(reading.type);
    return reference?.binding === undefined && STANDARD_ERRORS.has(reference?.builtin ?? '');
  };
  return (
    operands.some((reading) => native(reading)) &&
    operands.every(
      (reading) => reading !== undefined && (native(reading) || CLOSED.has(reading.type.kind)),
    )
  );
}

/** Literal values remain exact; opaque shapes retain possible primitive equality. */
function primitiveKeys(at: TypeReading): readonly string[] {
  const { type } = at;
  if (type.kind === SyntaxKind.NeverKeyword) return [];
  if (!isLiteralTypeNode(type)) return IDENTITY_PRIMITIVES.get(type.kind) ?? ['*'];
  const value = literalValue(type);
  if (value === undefined) return ['*'];
  return [`primitive:${value.replace(/^string:/u, 'text:').replace(/^boolean:/u, '')}`];
}
