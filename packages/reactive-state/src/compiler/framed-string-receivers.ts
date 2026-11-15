import {
  type EntityName,
  type Expression,
  isBigIntLiteral,
  isExpressionWithTypeArguments,
  isIdentifier,
  isImportTypeNode,
  isIndexedAccessTypeNode,
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isQualifiedName,
  isStringLiteral,
  isTemplateLiteralTypeNode,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  isTypeQueryNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeNode,
  type TypeReferenceNode,
} from 'typescript/ast';

import { frameDeclarationOf, frameTypeOf } from './framed-bindings.ts';
import { framedValueShape } from './framed-values.ts';
import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { constrainedOperands } from './local-type-constrained-operands.ts';
import {
  boundTypeBody,
  constraintReading,
  initialTypeReading,
  type TypeReading,
  typeReadingKey,
} from './local-type-environment.ts';
import { qualifiedLocalTypeBinding } from './local-type-namespaces.ts';
import { transparentOperand } from './local-type-native-arguments.ts';
import { memberReadings, returnTypeReadings } from './local-type-selections.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { valueQueryReading } from './local-type-value-queries.ts';

/**
 * Resolves written receiver annotations and assertions through local type aliases, generic
 * bindings, member paths, unions, and intrinsic string utilities without a runtime type checker.
 * Imported or otherwise external type references remain conservative string candidates so native
 * text argument conversion checks are not skipped across module boundaries.
 */

const INTRINSIC_STRING_TYPES: ReadonlySet<string> = new Set([
  'Capitalize',
  'Lowercase',
  'Uncapitalize',
  'Uppercase',
]);

const NON_STRING_BUILTINS: ReadonlySet<string> = new Set([
  ...STANDARD_ERRORS,
  ...'AbortController AbortSignal Array ArrayBuffer AsyncGenerator AsyncIterable AsyncIterableIterator AsyncIterator'.split(
    ' ',
  ),
  ...'BigInt BigInt64Array BigUint64Array Blob Boolean BroadcastChannel ConcatArray ConstructorParameters CustomEvent'.split(
    ' ',
  ),
  ...'DataView Date Event EventTarget File FinalizationRegistry Float16Array Float32Array Float64Array FormData Function'.split(
    ' ',
  ),
  ...'Generator Headers IArguments InstanceType Int8Array Int16Array Int32Array Iterable IterableIterator Iterator Map'.split(
    ' ',
  ),
  ...'MessageChannel MessageEvent MessagePort Number Object Omit Parameters Pick Promise PromiseLike PropertyKey'.split(
    ' ',
  ),
  ...'ReadableStream ReadonlyArray ReadonlyMap ReadonlySet Record RegExp RegExpExecArray RegExpMatchArray Request'.split(
    ' ',
  ),
  ...'RequestInit Response ResponseInit Set SharedArrayBuffer String Symbol TemplateStringsArray TextDecoder TextEncoder'.split(
    ' ',
  ),
  ...'ThisType TransformStream Uint8Array Uint8ClampedArray Uint16Array Uint32Array URL URLSearchParams WeakMap WeakRef WeakSet WritableStream'.split(
    ' ',
  ),
]);

const OTHER_PRIMITIVE_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NumberKeyword,
]);

type LeafKind = 'never' | 'non-primitive' | 'nullish' | 'opaque' | 'other-primitive' | 'string';

const NULLISH_COMPATIBLE: ReadonlySet<LeafKind> = new Set(['nullish', 'opaque']);
const PRIMITIVE_OR_OPAQUE_LEAVES: ReadonlySet<LeafKind> = new Set([
  'opaque',
  'other-primitive',
  'string',
]);

type Operands = (reading: TypeReading) => readonly TypeReading[];

type StepResult =
  | {
      readonly kind: 'step';
      readonly leaves: readonly LeafKind[];
      readonly next: readonly TypeReading[];
    }
  | { readonly kind: 'unresolved' };

/** Whether `node` has a declared or asserted type that may invoke `String.prototype` methods. */
export function framedStringTypeReceiver(node: Expression): boolean {
  const { assertions, value } = framedValueShape(node);
  if (assertions.some((each) => resolvesToStringType(each.type, each.keys))) {
    return true;
  }
  const selected = frameTypeOf(value);
  return selected !== undefined && resolvesToStringType(selected.type, selected.keys);
}

/** Whether `type` at `keys` resolves exclusively to non-nullish primitive or external-alias values. */
export function framedPrimitiveInputType(type: TypeNode, keys: readonly string[]): boolean {
  const leaves = selectedLeafKinds(type, keys);
  if (leaves === undefined) return false;
  const active = leaves.filter((leaf) => leaf !== 'never');
  return active.length > 0 && active.every((leaf) => PRIMITIVE_OR_OPAQUE_LEAVES.has(leaf));
}

/** Every non-nullish leaf must be a primitive string or external reference, with at least one present. */
function resolvesToStringType(type: TypeNode, keys: readonly string[]): boolean {
  const leaves = selectedLeafKinds(type, keys);
  if (leaves === undefined) return false;
  let hasCandidate = false;
  for (const leaf of leaves) {
    if (leaf === 'never' || leaf === 'nullish') continue;
    if (leaf !== 'string' && leaf !== 'opaque') return false;
    hasCandidate = true;
  }
  return hasCandidate;
}

/** Selects `keys` and expands aliases, parameters, intersections, and unions to leaf classifications. */
function selectedLeafKinds(
  type: TypeNode,
  keys: readonly string[],
): readonly LeafKind[] | undefined {
  const operands = constrainedOperands(expandMemberOperands);
  const selected = selectKeyedReadings(initialTypeReading(type), keys, operands);
  if (!selected.hasOpaque && selected.readings.length === 0) return undefined;
  const expanded = expandReadingLeaves(selected.readings, operands);
  if (expanded === undefined) return undefined;
  return selected.hasOpaque ? ['opaque', ...expanded] : expanded;
}

/** Steps `keys` one property at a time while preserving opaque imported holder branches. */
function selectKeyedReadings(
  initial: TypeReading,
  keys: readonly string[],
  operands: Operands,
): { readonly hasOpaque: boolean; readonly readings: readonly TypeReading[] } {
  let current: readonly TypeReading[] = [initial];
  let hasOpaque = false;
  for (const key of keys) {
    const next: TypeReading[] = [];
    for (const reading of current) {
      for (const source of operands(reading)) {
        if (opaqueMemberSource(source, operands)) hasOpaque = true;
        else next.push(...memberReadings(source, [key], operands));
      }
    }
    current = next;
  }
  return { hasOpaque, readings: current };
}

/** Whether a member-selection base is an imported or otherwise external type whose fields are unseen. */
function opaqueMemberSource(source: TypeReading, operands: Operands): boolean {
  if (isExpressionWithTypeArguments(source.type)) return false;
  if (isImportTypeNode(source.type)) return true;
  if (isTypeReferenceNode(source.type)) return opaqueTypeReference(source.type);
  if (!isIndexedAccessTypeNode(source.type)) return false;
  const objects = operands({ ...source, type: source.type.objectType });
  return objects.some(
    (each) => !isIndexedAccessTypeNode(each.type) && opaqueMemberSource(each, operands),
  );
}

/** Whether `reference` names an imported binding or an unshadowed external non-builtin type. */
function opaqueTypeReference(reference: TypeReferenceNode): boolean {
  const binding = isIdentifier(reference.typeName)
    ? localTypeBinding(reference.typeName)
    : qualifiedLocalTypeBinding(reference.typeName);
  if (binding === null) return true;
  if (binding !== undefined) return false;
  const builtin = isIdentifier(reference.typeName)
    ? reference.typeName.text
    : qualifiedBuiltinName(reference.typeName);
  return (
    builtin === undefined ||
    (!INTRINSIC_STRING_TYPES.has(builtin) && !NON_STRING_BUILTINS.has(builtin))
  );
}

/** Expands selected `TypeReading`s into classified leaves, returning `undefined` on local cycles. */
function expandReadingLeaves(
  initial: readonly TypeReading[],
  operands: Operands,
): readonly LeafKind[] | undefined {
  const pending = [...initial];
  const seen = new Set<string>();
  const leaves: LeafKind[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const key = typeReadingKey(at);
    if (seen.has(key)) continue;
    seen.add(key);
    const step = stepLeafReading(at, operands);
    if (step.kind === 'unresolved') return undefined;
    leaves.push(...step.leaves);
    pending.push(...step.next);
  }
  return leaves;
}

/** Expands aliases, bound type parameters and unions while preserving object shapes for `keys`. */
function expandMemberOperands(reading: TypeReading): readonly TypeReading[] {
  const pending = [reading];
  const seen = new Set<string>();
  const result: TypeReading[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const key = typeReadingKey(at);
    if (seen.has(key)) continue;
    seen.add(key);
    const next = memberOperandStep(at);
    if (next === undefined) result.push(at);
    else pending.push(...next);
  }
  return result;
}

/** Single expansion step before member selection, leaving unbound parameters to constraints. */
function memberOperandStep(at: TypeReading): readonly TypeReading[] | undefined {
  const transparent = transparentOperand(at, true);
  if (transparent !== undefined) return [transparent];
  if (isUnionTypeNode(at.type)) return at.type.types.map((member) => ({ ...at, type: member }));
  if (!isTypeReferenceNode(at.type)) return undefined;
  const binding = isIdentifier(at.type.typeName)
    ? localTypeBinding(at.type.typeName)
    : qualifiedLocalTypeBinding(at.type.typeName);
  if (binding === undefined || binding === null) return undefined;
  if (isTypeAliasDeclaration(binding)) {
    const bound = boundTypeBody(binding, at.type, at);
    return bound === undefined ? [] : [{ ...bound, type: binding.type }];
  }
  if (isTypeParameterDeclaration(binding)) {
    const actual = at.bindings.get(binding);
    return actual === undefined ? undefined : [actual];
  }
  return undefined;
}

/** Expands one selected reading toward primitive or external leaves, cutting cyclic local aliases. */
function stepLeafReading(at: TypeReading, operands: Operands): StepResult {
  if (isExpressionWithTypeArguments(at.type)) return { kind: 'unresolved' };
  const transparent = transparentOperand(at, true);
  if (transparent !== undefined) return { kind: 'step', leaves: [], next: [transparent] };
  if (isUnionTypeNode(at.type)) {
    return {
      kind: 'step',
      leaves: [],
      next: at.type.types.map((member) => ({ ...at, type: member })),
    };
  }
  if (isIntersectionTypeNode(at.type)) return intersectionLeafStep(at.type.types, at, operands);
  if (isImportTypeNode(at.type)) return { kind: 'step', leaves: ['opaque'], next: [] };
  if (isTypeQueryNode(at.type)) return queryLeafStep(at, operands);
  if (isIndexedAccessTypeNode(at.type)) return indexedLeafStep(at, operands);
  if (isTypeReferenceNode(at.type)) return referenceLeafStep(at.type, at, operands);
  return { kind: 'step', leaves: [classifyLeafNode(at.type)], next: [] };
}

/** Resolves branded primitives and intersections without mistaking structural objects for strings. */
function intersectionLeafStep(
  types: readonly TypeNode[],
  at: TypeReading,
  operands: Operands,
): StepResult {
  let current: ReadonlySet<LeafKind> | undefined;
  for (const member of types) {
    const expanded = expandReadingLeaves([{ ...at, type: member }], operands);
    if (expanded === undefined) return { kind: 'unresolved' };
    const active = expanded.filter((leaf) => leaf !== 'never');
    current = current === undefined ? new Set(active) : intersectLeafSets(current, active);
    if (current.size === 0) return { kind: 'step', leaves: ['never'], next: [] };
  }
  return { kind: 'step', leaves: current === undefined ? ['never'] : [...current], next: [] };
}

/** Distributes intersection across finite classified union branches. */
function intersectLeafSets(left: ReadonlySet<LeafKind>, right: readonly LeafKind[]): Set<LeafKind> {
  const combined = new Set<LeafKind>();
  for (const first of left) {
    for (const second of right) {
      const both = intersectTwoLeaves(first, second);
      if (both !== 'never') combined.add(both);
    }
  }
  return combined;
}

/** Intersects two single leaf classifications while preserving primitive and opaque brand bases. */
function intersectTwoLeaves(left: LeafKind, right: LeafKind): LeafKind {
  if (left === 'never' || right === 'never') return 'never';
  if (left === 'nullish' || right === 'nullish') {
    return NULLISH_COMPATIBLE.has(left) && NULLISH_COMPATIBLE.has(right) ? 'nullish' : 'never';
  }
  if (
    (left === 'string' && right === 'other-primitive') ||
    (left === 'other-primitive' && right === 'string')
  ) {
    return 'never';
  }
  if (left === 'string' || right === 'string') return 'string';
  if (left === 'other-primitive' || right === 'other-primitive') return 'other-primitive';
  return left === 'opaque' || right === 'opaque' ? 'opaque' : 'non-primitive';
}

/** Resolves `typeof x` queries through local declarations while keeping imported values opaque. */
function queryLeafStep(at: TypeReading, operands: Operands): StepResult {
  if (!isTypeQueryNode(at.type)) return { kind: 'unresolved' };
  const resolved = valueQueryReading(at, operands);
  if (resolved !== undefined && resolved.length > 0) {
    return { kind: 'step', leaves: [], next: resolved };
  }
  const root = leftmostIdentifier(at.type.exprName);
  const imported = frameDeclarationOf(root) === undefined && localTypeBinding(root) === null;
  return { kind: 'step', leaves: [imported ? 'opaque' : 'non-primitive'], next: [] };
}

/** Extracts the root identifier of an entity name. */
function leftmostIdentifier(name: EntityName) {
  let current = name;
  while (isQualifiedName(current)) {
    current = current.left;
  }
  return current;
}

/** Resolves literal string indexed-access types and preserves opaque imported object lookups. */
function indexedLeafStep(at: TypeReading, operands: Operands): StepResult {
  if (!isIndexedAccessTypeNode(at.type)) return { kind: 'unresolved' };
  const objectReading = { ...at, type: at.type.objectType };
  if (isLiteralTypeNode(at.type.indexType)) {
    const { literal } = at.type.indexType;
    if (isStringLiteral(literal) || isNoSubstitutionTemplateLiteral(literal)) {
      const stepped = selectKeyedReadings(objectReading, [literal.text], operands);
      if (!stepped.hasOpaque && stepped.readings.length === 0) return { kind: 'unresolved' };
      return {
        kind: 'step',
        leaves: stepped.hasOpaque ? ['opaque'] : [],
        next: stepped.readings,
      };
    }
  }
  const objects = operands(objectReading);
  const allOpaque =
    objects.length > 0 && objects.every((each) => opaqueMemberSource(each, operands));
  return allOpaque ? { kind: 'step', leaves: ['opaque'], next: [] } : { kind: 'unresolved' };
}

/** Follows local aliases, type parameters, imports, local shapes, and unshadowed global types. */
function referenceLeafStep(
  reference: TypeReferenceNode,
  at: TypeReading,
  operands: Operands,
): StepResult {
  const binding = isIdentifier(reference.typeName)
    ? localTypeBinding(reference.typeName)
    : qualifiedLocalTypeBinding(reference.typeName);
  if (binding === null) return { kind: 'step', leaves: ['opaque'], next: [] };
  if (binding === undefined) return unboundReferenceStep(reference, at, operands);
  if (isTypeAliasDeclaration(binding)) {
    const bound = boundTypeBody(binding, reference, at);
    return bound === undefined
      ? { kind: 'unresolved' }
      : { kind: 'step', leaves: [], next: [{ ...bound, type: binding.type }] };
  }
  if (isTypeParameterDeclaration(binding)) {
    const actual = at.bindings.get(binding) ?? constraintReading(binding, at);
    if (actual !== undefined) return { kind: 'step', leaves: [], next: [actual] };
    return binding.constraint === undefined
      ? { kind: 'step', leaves: ['non-primitive'], next: [] }
      : { kind: 'unresolved' };
  }
  return { kind: 'step', leaves: ['non-primitive'], next: [] };
}

/** Classifies unshadowed global built-ins and treats unknown external references as opaque. */
function unboundReferenceStep(
  reference: TypeReferenceNode,
  at: TypeReading,
  operands: Operands,
): StepResult {
  const builtin = isIdentifier(reference.typeName)
    ? reference.typeName.text
    : qualifiedBuiltinName(reference.typeName);
  if (builtin !== undefined) {
    const utility = utilityReferenceStep(builtin, reference.typeArguments, at, operands);
    if (utility !== undefined) return utility;
    if (NON_STRING_BUILTINS.has(builtin)) {
      return { kind: 'step', leaves: ['non-primitive'], next: [] };
    }
  }
  return { kind: 'step', leaves: ['opaque'], next: [] };
}

/** Expands unshadowed intrinsic string utilities, callable result queries, and Extract/Exclude. */
function utilityReferenceStep(
  builtin: string,
  args: readonly TypeNode[] | undefined,
  at: TypeReading,
  operands: Operands,
): StepResult | undefined {
  if (INTRINSIC_STRING_TYPES.has(builtin)) {
    return args?.length === 1 && args[0] !== undefined
      ? { kind: 'step', leaves: [], next: [{ ...at, type: args[0] }] }
      : { kind: 'unresolved' };
  }
  if (builtin === 'ReturnType' || builtin === 'ThisParameterType') {
    const returned = returnTypeReadings(at, operands) ?? [];
    return returned.length > 0
      ? { kind: 'step', leaves: [], next: returned }
      : { kind: 'step', leaves: ['opaque'], next: [] };
  }
  if (builtin === 'Exclude' && args?.length === 2 && args[0] !== undefined) {
    return { kind: 'step', leaves: [], next: [{ ...at, type: args[0] }] };
  }
  if (
    builtin === 'Extract' &&
    args?.length === 2 &&
    args[0] !== undefined &&
    args[1] !== undefined
  ) {
    return intersectionLeafStep([args[0], args[1]], at, operands);
  }
  return undefined;
}

/** Classifies syntax leaf `TypeNode`s into string, nullish, never, other-primitive, or non-primitive. */
function classifyLeafNode(node: TypeNode): LeafKind {
  if (node.kind === SyntaxKind.NeverKeyword) return 'never';
  if (nullishTypeNode(node)) return 'nullish';
  if (stringTypeNode(node)) return 'string';
  return otherPrimitiveNode(node) ? 'other-primitive' : 'non-primitive';
}

/** `null` and `undefined` keywords or literal `null` type nodes. */
function nullishTypeNode(node: TypeNode): boolean {
  return (
    node.kind === SyntaxKind.NullKeyword ||
    node.kind === SyntaxKind.UndefinedKeyword ||
    (isLiteralTypeNode(node) && node.literal.kind === SyntaxKind.NullKeyword)
  );
}

/** Primitive `string`, string literal types, and template literal types. */
function stringTypeNode(node: TypeNode): boolean {
  return (
    node.kind === SyntaxKind.StringKeyword ||
    isTemplateLiteralTypeNode(node) ||
    (isLiteralTypeNode(node) &&
      (isStringLiteral(node.literal) || isNoSubstitutionTemplateLiteral(node.literal)))
  );
}

/** Non-string, non-nullish primitive keywords and literal types (`number`, `boolean`, `bigint`). */
function otherPrimitiveNode(node: TypeNode): boolean {
  if (OTHER_PRIMITIVE_KEYWORDS.has(node.kind)) return true;
  if (!isLiteralTypeNode(node)) return false;
  const { literal } = node;
  if (
    literal.kind === SyntaxKind.TrueKeyword ||
    literal.kind === SyntaxKind.FalseKeyword ||
    isNumericLiteral(literal) ||
    isBigIntLiteral(literal)
  ) {
    return true;
  }
  return (
    isPrefixUnaryExpression(literal) &&
    (isNumericLiteral(literal.operand) || isBigIntLiteral(literal.operand))
  );
}
