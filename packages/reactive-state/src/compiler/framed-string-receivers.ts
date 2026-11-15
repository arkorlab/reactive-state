import {
  type Expression,
  isBigIntLiteral,
  isExpressionWithTypeArguments,
  isIdentifier,
  isIndexedAccessTypeNode,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isStringLiteral,
  isTemplateLiteralTypeNode,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeNode,
  type TypeReferenceNode,
} from 'typescript/ast';

import { frameTypeOf } from './framed-bindings.ts';
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
import { memberReadings } from './local-type-selections.ts';

/**
 * Resolves written receiver annotations and assertions through local type aliases, generic
 * bindings, member paths, unions, and intrinsic string utilities without a runtime type checker.
 */

const INTRINSIC_STRING_TYPES: ReadonlySet<string> = new Set([
  'Capitalize',
  'Lowercase',
  'Uncapitalize',
  'Uppercase',
]);

const OTHER_PRIMITIVE_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NumberKeyword,
]);

const NULLISH_OR_NEVER: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.NeverKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.UndefinedKeyword,
]);

type StepResult = readonly TypeReading[] | 'leaf' | 'unresolved';

/** Whether `node` has a declared or asserted type that can only invoke `String.prototype` methods. */
export function framedStringTypeReceiver(node: Expression): boolean {
  const { assertions, value } = framedValueShape(node);
  if (assertions.some((each) => resolvesToStringType(each.type, each.keys))) {
    return true;
  }
  const selected = frameTypeOf(value);
  return selected !== undefined && resolvesToStringType(selected.type, selected.keys);
}

/** Whether `type` at `keys` resolves exclusively to non-nullish primitive values. */
export function framedPrimitiveInputType(type: TypeNode, keys: readonly string[]): boolean {
  const leaves = selectedLeafReadings(type, keys);
  if (leaves === undefined) return false;
  const active = leaves.filter((leaf) => leaf.type.kind !== SyntaxKind.NeverKeyword);
  return active.length > 0 && active.every((leaf) => nonNullishPrimitiveNode(leaf.type));
}

/** Every non-nullish leaf must be a primitive string, with at least one string leaf present. */
function resolvesToStringType(type: TypeNode, keys: readonly string[]): boolean {
  const leaves = selectedLeafReadings(type, keys);
  if (leaves === undefined) return false;
  let hasString = false;
  for (const leaf of leaves) {
    if (NULLISH_OR_NEVER.has(leaf.type.kind)) continue;
    if (!stringTypeNode(leaf.type)) return false;
    hasString = true;
  }
  return hasString;
}

/** Selects `keys` and expands aliases, parameters and unions down to concrete leaf `TypeNode`s. */
function selectedLeafReadings(
  type: TypeNode,
  keys: readonly string[],
): readonly TypeReading[] | undefined {
  const operands = constrainedOperands(expandMemberOperands);
  const selected = memberReadings(initialTypeReading(type), keys, operands);
  if (selected.length === 0) return undefined;
  const pending = [...selected];
  const seen = new Set<string>();
  const leaves: TypeReading[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const key = typeReadingKey(at);
    if (seen.has(key)) continue;
    seen.add(key);
    const step = stepLeafReading(at, operands);
    if (step === 'unresolved') return undefined;
    if (step === 'leaf') leaves.push(at);
    else pending.push(...step);
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

/** Expands one selected reading toward primitive leaves, marking cyclic or opaque references. */
function stepLeafReading(
  at: TypeReading,
  operands: (reading: TypeReading) => readonly TypeReading[],
): StepResult {
  if (isExpressionWithTypeArguments(at.type)) return 'unresolved';
  const transparent = transparentOperand(at, true);
  if (transparent !== undefined) return [transparent];
  if (isUnionTypeNode(at.type)) return at.type.types.map((member) => ({ ...at, type: member }));
  if (isIndexedAccessTypeNode(at.type)) return indexedLeafStep(at, operands);
  if (isTypeReferenceNode(at.type)) return referenceLeafStep(at.type, at);
  return 'leaf';
}

/** Resolves literal string indexed-access types such as `Box['label']`. */
function indexedLeafStep(
  at: TypeReading,
  operands: (reading: TypeReading) => readonly TypeReading[],
): StepResult {
  if (!isIndexedAccessTypeNode(at.type) || !isLiteralTypeNode(at.type.indexType)) {
    return 'unresolved';
  }
  const { literal } = at.type.indexType;
  if (!isStringLiteral(literal) && !isNoSubstitutionTemplateLiteral(literal)) {
    return 'unresolved';
  }
  const selected = memberReadings({ ...at, type: at.type.objectType }, [literal.text], operands);
  return selected.length === 0 ? 'unresolved' : selected;
}

/** Follows local aliases, type parameters, and unshadowed intrinsic string utilities. */
function referenceLeafStep(reference: TypeReferenceNode, at: TypeReading): StepResult {
  const binding = isIdentifier(reference.typeName)
    ? localTypeBinding(reference.typeName)
    : qualifiedLocalTypeBinding(reference.typeName);
  if (binding === undefined) {
    const builtin = isIdentifier(reference.typeName)
      ? reference.typeName.text
      : qualifiedBuiltinName(reference.typeName);
    const argument = reference.typeArguments?.length === 1 ? reference.typeArguments[0] : undefined;
    return builtin !== undefined && INTRINSIC_STRING_TYPES.has(builtin) && argument !== undefined
      ? [{ ...at, type: argument }]
      : 'unresolved';
  }
  if (binding === null) return 'unresolved';
  if (isTypeAliasDeclaration(binding)) {
    const bound = boundTypeBody(binding, reference, at);
    return bound === undefined ? 'unresolved' : [{ ...bound, type: binding.type }];
  }
  if (isTypeParameterDeclaration(binding)) {
    const actual = at.bindings.get(binding) ?? constraintReading(binding, at);
    return actual === undefined ? 'unresolved' : [actual];
  }
  return 'unresolved';
}

/** Primitive `string`, string literal types, and template literal types. */
function stringTypeNode(node: TypeNode | TypeReading['type']): boolean {
  if (isExpressionWithTypeArguments(node)) return false;
  return (
    node.kind === SyntaxKind.StringKeyword ||
    isTemplateLiteralTypeNode(node) ||
    (isLiteralTypeNode(node) &&
      (isStringLiteral(node.literal) || isNoSubstitutionTemplateLiteral(node.literal)))
  );
}

/** Non-nullish primitive keywords and literal types (`string`, `number`, `boolean`, `bigint`). */
function nonNullishPrimitiveNode(node: TypeNode | TypeReading['type']): boolean {
  if (isExpressionWithTypeArguments(node)) return false;
  if (stringTypeNode(node) || OTHER_PRIMITIVE_KEYWORDS.has(node.kind)) return true;
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
