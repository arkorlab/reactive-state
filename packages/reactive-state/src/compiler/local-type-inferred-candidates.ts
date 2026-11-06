import {
  factory,
  isCallSignatureDeclaration,
  isConstructorTypeNode,
  isConstructSignatureDeclaration,
  isFunctionTypeNode,
  isLiteralTypeNode,
  isMethodSignatureDeclaration,
  isParameterDeclaration,
  isPropertySignatureDeclaration,
  isSourceFile,
  isTypeReferenceNode,
  isTypeNode,
  isTypeLiteralNode,
  isUnionTypeNode,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
  type TypeNode,
  type TypeParameterDeclaration,
} from 'typescript/ast';

import { capturedIntersection } from './local-type-captured-sequences.ts';
import { literalValue } from './local-type-conditional-utilities.ts';
import type { TypeReading } from './local-type-environment.ts';
import { literalKind } from './local-type-utility-readings.ts';
import { memberName } from './local-type-weak-objects.ts';

/** Written primitive and disjoint structural infer candidates retain their joint variance result. */

export interface InferredCandidate {
  readonly reading: TypeReading;
  readonly contravariant: boolean | undefined;
}
interface Primitive {
  readonly kind: SyntaxKind;
  readonly literal: string | undefined;
  readonly type: TypeNode;
}
type Resolve = (reading: TypeReading) => TypeReading | undefined;
const PRIMITIVES = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.UndefinedKeyword,
]);
const NEVER = factory.createKeywordTypeNode(SyntaxKind.NeverKeyword);

/** Written function parameter positions reverse variance; methods retain their existing bivariance. */
export function inferredContravariance(
  parameter: TypeParameterDeclaration,
  owner: Node | undefined,
): boolean | undefined {
  let contravariant = false;
  let bivariant = false;
  for (let node: Node = parameter; node !== owner && !isSourceFile(node); node = node.parent) {
    if (isTypeReferenceNode(node)) return undefined;
    const parent = parameterPosition(node);
    if (parent === undefined) continue;
    const variance = parameterVariance(parent.parent);
    if (variance === undefined) return undefined;
    if (variance) contravariant = !contravariant;
    else bivariant = true;
  }
  return !bivariant && contravariant;
}

/** Only the written value type of a parameter reverses an enclosing function position. */
function parameterPosition(node: Node): ParameterDeclaration | undefined {
  const { parent } = node;
  return isTypeNode(node) && isParameterDeclaration(parent) && parent.type === node
    ? parent
    : undefined;
}

/** Unknown signature containers retain their earlier capture alternatives. */
function parameterVariance(signature: Node): boolean | undefined {
  if (isMethodSignatureDeclaration(signature)) return false;
  return isFunctionTypeNode(signature) ||
    isConstructorTypeNode(signature) ||
    isCallSignatureDeclaration(signature) ||
    isConstructSignatureDeclaration(signature)
    ? true
    : undefined;
}

/** Uniform primitives and closed disjoint contravariant object shapes retain a joint result. */
export function inferredCandidates(
  candidates: readonly InferredCandidate[],
  resolve: Resolve,
): readonly TypeReading[] {
  const original = candidates.map((candidate) => candidate.reading);
  const [first] = candidates;
  if (first?.contravariant === undefined || candidates.length === 1) return original;
  if (candidates.some((candidate) => candidate.contravariant !== first.contravariant))
    return original;
  let selected: readonly Primitive[] | undefined;
  for (const candidate of candidates) {
    const domain = primitiveDomain(candidate.reading, resolve);
    if (domain === undefined) return structuralCandidates(candidates, resolve) ?? original;
    if (selected === undefined) selected = domain;
    else
      selected = first.contravariant
        ? intersectDomains(selected, domain)
        : unionDomain([...selected, ...domain]);
  }
  const types = (selected ?? []).map((primitive) => primitive.type);
  let type: TypeNode = NEVER;
  if (types.length === 1) type = types[0] ?? NEVER;
  else if (types.length > 1) type = factory.createUnionTypeNode(types);
  return [{ ...first.reading, type }];
}

/** Only disjoint known literal fields add structural intersections; opaque or overlapping shapes stay unchanged. */
function structuralCandidates(
  candidates: readonly InferredCandidate[],
  resolve: Resolve,
): readonly TypeReading[] | undefined {
  const first = candidates[0];
  if (first?.contravariant !== true) return undefined;
  const names = new Set<string>();
  const readings: TypeReading[] = [];
  for (const candidate of candidates) {
    const reading = resolve(candidate.reading);
    if (reading === undefined || !isTypeLiteralNode(reading.type)) return undefined;
    for (const member of reading.type.members) {
      if (!isPropertySignatureDeclaration(member)) return undefined;
      const name = memberName(member);
      if (name === undefined || names.has(name)) return undefined;
      names.add(name);
    }
    readings.push(reading);
  }
  return [capturedIntersection(first.reading, readings)];
}

/** Aliases and actual bindings are resolved before finite native primitive alternatives are read. */
function primitiveDomain(reading: TypeReading, resolve: Resolve): readonly Primitive[] | undefined {
  const result: Primitive[] = [];
  const pending = [reading];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const actual = resolve(at);
    if (actual === undefined) return undefined;
    const { type } = actual;
    if (isUnionTypeNode(type)) {
      pending.push(...type.types.map((each) => ({ ...actual, type: each })));
      continue;
    }
    if (type.kind === SyntaxKind.NeverKeyword) continue;
    const primitive = primitiveOf(type);
    if (primitive === undefined) return undefined;
    result.push(primitive);
  }
  return unionDomain(result);
}

/** Primitive literals retain their semantic value and unqualified native category. */
function primitiveOf(type: TypeReading['type']): Primitive | undefined {
  if (isLiteralTypeNode(type)) {
    const literal = literalValue(type);
    const kind = literalKind(type);
    return literal === undefined ? undefined : { kind, literal, type };
  }
  return PRIMITIVES.has(type.kind)
    ? { kind: type.kind, literal: undefined, type: type as TypeNode }
    : undefined;
}

/** A native category covers its literals; repeated semantic literals denote one alternative. */
function unionDomain(values: readonly Primitive[]): readonly Primitive[] {
  const selected: Primitive[] = [];
  for (const value of values) {
    if (selected.some((prior) => covers(prior, value))) continue;
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      const prior = selected[index];
      if (prior !== undefined && covers(value, prior)) selected.splice(index, 1);
    }
    selected.push(value);
  }
  return selected;
}

/** Intersections retain a shared literal or category, never independent choices of disjoint inputs. */
function intersectDomains(
  left: readonly Primitive[],
  right: readonly Primitive[],
): readonly Primitive[] {
  const selected: Primitive[] = [];
  for (const source of left) {
    for (const target of right) {
      if (covers(source, target)) selected.push(target);
      else if (covers(target, source)) selected.push(source);
    }
  }
  return unionDomain(selected);
}

/** Literal identity is compared only inside the same native primitive category. */
function covers(left: Primitive, right: Primitive): boolean {
  return left.kind === right.kind && (left.literal === undefined || left.literal === right.literal);
}
