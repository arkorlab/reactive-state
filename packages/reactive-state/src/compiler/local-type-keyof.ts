import {
  isExpressionWithTypeArguments,
  isIdentifier,
  isTypeReferenceNode,
  isTypeParameterDeclaration,
  isIndexSignatureDeclaration,
  isLiteralTypeNode,
  isTypeLiteralNode,
  isUnionTypeNode,
  isTypeOperatorNode,
  SyntaxKind,
  type TypeNode,
  type TypeLiteralNode,
} from 'typescript/ast';

import { localTypeBinding, type LocalTypeBinding } from './local-type-aliases.ts';
import type { TypeReading } from './local-type-environment.ts';
import { indexSignatureDomains } from './local-type-index-domains.ts';
import { interfaceShapeReadings } from './local-type-interface-members.ts';
import {
  indexedMemberTypes,
  memberName,
  selectedMemberTypes,
  unreadableMemberTypes,
} from './local-type-members.ts';

/** Literal indices and keyof a written object, retaining the index operand's lexical environment. */
const INDEX_DOMAINS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
]);

const KEYLESS_KEYOF: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ConstructorType,
  SyntaxKind.FunctionType,
  SyntaxKind.ObjectKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.UnknownKeyword,
  SyntaxKind.VoidKeyword,
]);

type KeyofResolve = (
  reading: TypeReading,
  preserve?: ReadonlySet<LocalTypeBinding>,
) => TypeReading | undefined;

type KeyofKind = (reading: TypeReading) => SyntaxKind | undefined;

const NON_ANY_KEYOF: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.ObjectKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.UnknownKeyword,
  SyntaxKind.VoidKeyword,
]);

/** A complete empty keyof result satisfies never; incomplete key shapes retain their boundary. */
export function keyofNeverTruth(
  at: TypeReading,
  resolve: KeyofResolve,
  kindOf: KeyofKind,
): boolean | undefined {
  const { type } = at;
  if (!isTypeOperatorNode(type) || type.operator !== SyntaxKind.KeyOfKeyword) return undefined;
  const argument = { ...at, type: type.type };
  const generic = genericUnionKeys(argument, resolve, kindOf);
  if (generic !== undefined) return generic;
  const operand = resolve(argument);
  if (operand === undefined) return undefined;
  return emptyUnionKeys(operand, resolve, kindOf) ?? finiteKeyofNeverTruth(operand, resolve);
}

/** An original generic keyof union keeps its declaration-time common keys before actual erasure. */
function genericUnionKeys(
  at: TypeReading,
  resolve: KeyofResolve,
  kindOf: KeyofKind,
): boolean | undefined {
  if (at.bindings.size === 0) return undefined;
  const preserve = new Set<LocalTypeBinding>(at.bindings.keys());
  const written = resolve(at, preserve);
  if (written === undefined || !isUnionTypeNode(written.type)) return undefined;
  return emptyUnionKeys(
    written,
    (reading) => resolve(reading, preserve),
    (reading) => declarationKind(reading, preserve, kindOf),
  );
}

/** An original parameter is not an explicit any while its written union's common keys are formed. */
function declarationKind(
  at: TypeReading,
  preserve: ReadonlySet<LocalTypeBinding>,
  kindOf: KeyofKind,
): SyntaxKind | undefined {
  const { type } = at;
  if (
    isTypeReferenceNode(type) &&
    isIdentifier(type.typeName) &&
    preserve.has(localTypeBinding(type.typeName))
  )
    return SyntaxKind.UnknownKeyword;
  return kindOf(at);
}

/** An unbound written parameter is not explicit any when declaration-time common keys are formed. */
function unboundParameterKind(at: TypeReading): SyntaxKind | undefined {
  const { type } = at;
  if (!isTypeReferenceNode(type) || !isIdentifier(type.typeName)) return undefined;
  const binding = localTypeBinding(type.typeName);
  return binding !== undefined &&
    binding !== null &&
    isTypeParameterDeclaration(binding) &&
    !at.bindings.has(binding)
    ? SyntaxKind.UnknownKeyword
    : undefined;
}

/** A keyless constituent empties common keys only when no other constituent can be opaque any. */
function emptyUnionKeys(
  at: TypeReading,
  resolve: (reading: TypeReading) => TypeReading | undefined,
  kindOf: KeyofKind,
): boolean | undefined {
  const pending = [at];
  let empty = false;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const source = resolve(next);
    if (source === undefined) return undefined;
    if (isUnionTypeNode(source.type)) {
      pending.push(...source.type.types.map((type) => ({ ...source, type })));
      continue;
    }
    const kind = kindOf(source) ?? unboundParameterKind(source);
    if (kind === SyntaxKind.AnyKeyword) return false;
    if (kind === SyntaxKind.NeverKeyword) continue;
    const truth = finiteKeyofNeverTruth(source, resolve);
    if (truth === undefined && (kind === undefined || !NON_ANY_KEYOF.has(kind))) return undefined;
    empty ||= truth === true;
  }
  return empty ? true : undefined;
}

/** Keyless syntax and complete finite written key sets retain their existing empty-key proof. */
function finiteKeyofNeverTruth(
  operand: TypeReading,
  resolve: (reading: TypeReading) => TypeReading | undefined,
): boolean | undefined {
  if (
    KEYLESS_KEYOF.has(operand.type.kind) ||
    (isLiteralTypeNode(operand.type) && operand.type.literal.kind === SyntaxKind.NullKeyword)
  )
    return true;
  const shapes = keyofShapes(operand, resolve);
  if (shapes === undefined) return undefined;
  const keys = commonKeys(operand, resolve);
  if (keys === undefined) return undefined;
  if (keys.length > 0) return false;
  return shapes.some((sources) => unreadNames(sources)) ? undefined : true;
}

export function keyedMemberTypes(
  object: TypeNode,
  index: TypeReading,
  resolve: (reading: TypeReading) => TypeReading | undefined,
): readonly TypeNode[] | undefined {
  const { type } = index;
  if (isExpressionWithTypeArguments(type)) return undefined;
  if (!isTypeOperatorNode(type) || type.operator !== SyntaxKind.KeyOfKeyword)
    return indexedMemberTypes(object, type);
  const keys = commonKeys({ ...index, type: type.type }, resolve);
  return keys === undefined ? undefined : selectedMemberTypes(object, keys);
}

/** Finite source-written keyof members project through the original object's environment. */
export function writtenKeyofKeys(
  at: TypeReading,
  resolve: (reading: TypeReading) => TypeReading | undefined,
): readonly string[] | undefined {
  const { type } = at;
  return isTypeOperatorNode(type) && type.operator === SyntaxKind.KeyOfKeyword
    ? commonKeys({ ...at, type: type.type }, resolve)
    : undefined;
}

/**
 * A written member name the compiler cannot read exactly leaves the key set incomplete: that key
 * may select any value of the indexed object's written shape, while an unknown shape keeps its
 * existing boundary.
 */
export function unreadableKeyofReadings(
  object: TypeReading,
  index: TypeReading,
  resolve: (reading: TypeReading) => TypeReading | undefined,
): readonly TypeReading[] {
  const { type } = index;
  if (!isTypeOperatorNode(type) || type.operator !== SyntaxKind.KeyOfKeyword) return [];
  const keyed = keyofShapes({ ...index, type: type.type }, resolve) ?? [];
  const shapes = keyed.some((sources) => unreadNames(sources))
    ? shapeSources(object, resolve)
    : undefined;
  return (shapes === undefined ? undefined : indexedShapeValues(shapes)) ?? [];
}

/** Whether a constituent's written bodies declare a member whose name is not read exactly. */
function unreadNames(sources: readonly TypeReading[]): boolean {
  for (const source of sources) {
    if (isTypeLiteralNode(source.type) && unreadableMemberTypes(source.type) !== undefined)
      return true;
  }
  return false;
}

/** A union has only the written keys shared by each resolved literal constituent. */
function commonKeys(
  at: TypeReading,
  resolve: (reading: TypeReading) => TypeReading | undefined,
): readonly string[] | undefined {
  const shapes = keyofShapes(at, resolve);
  if (shapes === undefined) return undefined;
  let common: Set<string> | undefined;
  const covering: (readonly TypeReading[])[] = [];
  for (const sources of shapes) {
    const keys = shapeKeys(sources);
    if (keys === undefined) covering.push(sources);
    else common = intersectKeys(common, keys);
  }
  if (common === undefined) return undefined;
  return coveredKeys(common, covering);
}

/** Each resolved union constituent's written shapes; an unknown constituent hides them all. */
function keyofShapes(
  at: TypeReading,
  resolve: (reading: TypeReading) => TypeReading | undefined,
): readonly (readonly TypeReading[])[] | undefined {
  const shapes: (readonly TypeReading[])[] = [];
  const pending = [at];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const source = resolve(next);
    if (source === undefined) return undefined;
    if (isUnionTypeNode(source.type)) {
      pending.push(...source.type.types.map((type) => ({ ...source, type })));
      continue;
    }
    if (source.type.kind === SyntaxKind.NeverKeyword) continue;
    const sources = shapeSources(source, resolve);
    if (sources === undefined) return undefined;
    shapes.push(sources);
  }
  return shapes;
}

/** Finite union keys remain selected when every index-bearing constituent covers that same key. */
function coveredKeys(
  common: ReadonlySet<string>,
  covering: readonly (readonly TypeReading[])[],
): readonly string[] {
  return [...common].filter((key) => {
    return covering.every((sources) => {
      return sources.some((source) => {
        return (
          isTypeLiteralNode(source.type) &&
          (selectedMemberTypes(source.type, [key])?.length ?? 0) > 0
        );
      });
    });
  });
}

/** Known literal bodies and merged/inherited interface sources retain their original environments. */
function shapeSources(
  at: TypeReading,
  resolve: (reading: TypeReading) => TypeReading | undefined,
): readonly TypeReading[] | undefined {
  if (isTypeLiteralNode(at.type)) return [at];
  const shapes = interfaceShapeReadings(at, (reading) => {
    const resolved = resolve(reading);
    return resolved === undefined ? [] : [resolved];
  });
  return shapes === undefined || shapes.unknown ? undefined : shapes.sources;
}

/** Index-bearing bodies are not a finite key list; finite interface bodies contribute all named keys. */
function shapeKeys(sources: readonly TypeReading[]): Set<string> | undefined {
  const keys = new Set<string>();
  for (const source of sources) {
    if (!isTypeLiteralNode(source.type)) return undefined;
    const known = literalKeys(source.type);
    if (known === undefined) return undefined;
    for (const key of known) keys.add(key);
  }
  return keys;
}

/** A self-key selection with explicit index signatures retains selected original value readings. */
export function indexedKeyofReadings(
  object: TypeReading,
  index: TypeReading,
  resolve: (reading: TypeReading) => TypeReading | undefined,
): readonly TypeReading[] | undefined {
  const { type } = index;
  if (!isTypeOperatorNode(type) || type.operator !== SyntaxKind.KeyOfKeyword) return undefined;
  const keyed = resolve({ ...index, type: type.type });
  if (keyed === undefined || isUnionTypeNode(keyed.type)) return undefined;
  const source = shapeSources(object, resolve);
  if (source === undefined) return undefined;
  const keys = shapeSources(keyed, resolve);
  if (keys === undefined) return undefined;
  if (source.length !== keys.length) return undefined;
  const bodies = new Set(keys.map((each) => each.type));
  if (source.some((each) => !bodies.has(each.type)) || shapeKeys(source) !== undefined)
    return undefined;
  return indexedShapeValues(source);
}

/**
 * Nearest explicit domains shadow inherited signatures; finite fields and members with unread names
 * retain their original readings.
 */
function indexedShapeValues(sources: readonly TypeReading[]): readonly TypeReading[] | undefined {
  const values: TypeReading[] = [];
  const domains = new Set<SyntaxKind>();
  const fields = new Set<string>();
  for (const source of sources) {
    if (!isTypeLiteralNode(source.type)) return undefined;
    const signatures = indexedSignatures(source, domains);
    if (signatures === undefined) return undefined;
    values.push(...signatures.values);
    for (const domain of signatures.covered) domains.add(domain);
    const named = unseenFieldNames(source.type, fields);
    const types = [
      ...(selectedMemberTypes(source.type, named) ?? []),
      ...(unreadableMemberTypes(source.type) ?? []),
    ];
    for (const type of types) values.push({ ...source, type });
  }
  return values;
}

/** Only written string, number and symbol domains participate in this bounded self-key selection. */
function indexedSignatures(
  source: TypeReading,
  domains: ReadonlySet<SyntaxKind>,
):
  | { readonly values: readonly TypeReading[]; readonly covered: ReadonlySet<SyntaxKind> }
  | undefined {
  if (!isTypeLiteralNode(source.type)) return undefined;
  const values: TypeReading[] = [];
  const covered = new Set<SyntaxKind>();
  for (const member of source.type.members) {
    if (!isIndexSignatureDeclaration(member)) continue;
    const declared = indexSignatureDomains(member.parameters[0]?.type);
    if (declared.size === 0) return undefined;
    let uncovered = false;
    for (const domain of declared) {
      if (!INDEX_DOMAINS.has(domain)) return undefined;
      covered.add(domain);
      uncovered ||= !domains.has(domain);
    }
    if (uncovered) values.push({ ...source, type: member.type });
  }
  return { covered, values };
}

/** A nearer declaration contributes each finite field before the same field in a base shape. */
function unseenFieldNames(type: TypeLiteralNode, fields: Set<string>): readonly string[] {
  const names: string[] = [];
  for (const key of declaredLiteralKeys(type)) {
    if (fields.has(key)) continue;
    fields.add(key);
    names.push(key);
  }
  return names;
}

/** An explicit index domain makes the key set nonfinite rather than empty. */
function literalKeys(type: TypeLiteralNode): Set<string> | undefined {
  return type.members.some((member) => isIndexSignatureDeclaration(member))
    ? undefined
    : declaredLiteralKeys(type);
}

/** Explicitly named members contribute known keys; unread names are kept apart as incomplete. */
function declaredLiteralKeys(type: TypeLiteralNode): Set<string> {
  const keys = new Set<string>();
  for (const member of type.members) {
    const key = memberName(member);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/** Keys retained by every constituent seen so far. */
function intersectKeys(common: Set<string> | undefined, keys: Set<string>): Set<string> {
  if (common === undefined) return keys;
  for (const key of common) if (!keys.has(key)) common.delete(key);
  return common;
}
