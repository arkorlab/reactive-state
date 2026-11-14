import {
  factory,
  isCallSignatureDeclaration,
  isConstructSignatureDeclaration,
  isConstructorTypeNode,
  isFunctionTypeNode,
  isLiteralTypeNode,
  isTypeLiteralNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeLiteralNode,
  type TypeNode,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import type { Compare, Resolve } from './local-type-inference-types.ts';

/** Implicit native Function fields and the written shapes that carry them. */

const CALLABLE_FIELDS = new Set(['apply', 'bind', 'call', 'caller']);
const PRIMITIVES = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.VoidKeyword,
]);
const FIELDS = new Set([
  'apply',
  'arguments',
  'bind',
  'call',
  'caller',
  'length',
  'name',
  'prototype',
]);
const SCALARS: ReadonlyMap<string, TypeNode> = new Map<string, TypeNode>([
  ['length', factory.createKeywordTypeNode(SyntaxKind.NumberKeyword)],
  ['name', factory.createKeywordTypeNode(SyntaxKind.StringKeyword)],
]);
// The existing weak-target check sees a call signature, with no invented written property.
const WEAK_CALLABLE = factory.createTypeLiteralNode([
  factory.createCallSignatureDeclaration(
    undefined,
    [],
    factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword),
  ),
]);

/** A literal's own shape, or a callable's empty written-property shape for weak-target comparison. */
export function callableObjectShape(type: TypeReading['type']): TypeLiteralNode | undefined {
  if (isTypeLiteralNode(type)) return type;
  return isFunctionTypeNode(type) || isConstructorTypeNode(type) ? WEAK_CALLABLE : undefined;
}

/** Known scalar fields keep their native type; other Function fields remain possible and opaque. */
export function implicitFunctionField(
  sources: readonly TypeReading[],
  name: string,
): TypeReading | null | undefined {
  const source = sources.find((reading) => callable(reading.type));
  if (source === undefined || !FIELDS.has(name)) return null;
  const type = SCALARS.get(name);
  return type === undefined ? undefined : { ...source, type };
}

/** A written call or construct signature supplies Function metadata without instantiating generics. */
function callable(type: TypeReading['type']): boolean {
  if (isFunctionTypeNode(type) || isConstructorTypeNode(type)) return true;
  return (
    isTypeLiteralNode(type) &&
    type.members.some(
      (member) => isCallSignatureDeclaration(member) || isConstructSignatureDeclaration(member),
    )
  );
}

/** Known Function methods cannot satisfy primitive fields; no native field is assignable to never. */
export function implicitFunctionPrimitiveMismatch(
  name: string,
  expected: TypeReading | undefined,
  resolve: Resolve,
): false | undefined {
  if (expected === undefined) return undefined;
  if (expected.type.kind === SyntaxKind.NeverKeyword) return false;
  if (!CALLABLE_FIELDS.has(name)) return undefined;
  const pending = [expected];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const reading = resolve(each);
    if (reading === undefined) return undefined;
    const { type } = reading;
    if (isUnionTypeNode(type))
      pending.push(...type.types.map((part) => ({ ...reading, type: part })));
    else if (
      !isLiteralTypeNode(type) &&
      !PRIMITIVES.has(type.kind) &&
      type.kind !== SyntaxKind.NeverKeyword
    )
      return undefined;
  }
  return false;
}

/** Native metadata does not override a written field when every callable rejects the whole target. */
export function callableSourcesRefused(
  sources: readonly TypeReading[],
  pattern: TypeReading,
  compare: Compare,
): boolean {
  return sources.every((source) => {
    if (!callable(source.type)) return true;
    return compare(source, pattern) === false;
  });
}
