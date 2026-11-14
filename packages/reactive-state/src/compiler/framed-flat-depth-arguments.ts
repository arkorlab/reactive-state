import {
  type Expression,
  isExpression,
  isIdentifier,
  isLiteralTypeNode,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVoidExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameTypeOf } from './framed-bindings.ts';
import { signedInfinity } from './framed-copy-guards.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { localTypeBinding } from './local-type-aliases.ts';

/** Quiet primitive depths retain finite written alternatives without executing a conversion hook. */

const INFINITY = new Set(['Infinity']);
const NAN = new Set(['NaN']);
const UNDEFINED = new Set(['undefined']);

export interface FlatDepths {
  readonly values: readonly number[] | undefined;
}

/** An unresolved primitive number may keep any finite written array layer; an object stays opaque. */
export function flatArgumentDepths(expression: Expression | undefined): FlatDepths | undefined {
  if (expression === undefined) return { values: [1] };
  const fixed = literalDepth(expression);
  if (fixed !== undefined) return { values: [fixed] };
  const source = wholeDepthSource(expression);
  const selected = source === undefined ? undefined : frameTypeOf(source);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const result = writtenDepths(selected.type);
  const binding =
    source !== undefined && isIdentifier(source) ? frameBindingOf(source)?.binding : undefined;
  return binding !== undefined &&
    isParameterDeclaration(binding) &&
    binding.questionToken !== undefined &&
    result?.values !== undefined
    ? { values: [...result.values, 1] }
    : result;
}

/** Omitted values use one; literal primitive ToNumber results clamp negative and nonfinite depths. */
function literalDepth(expression: Expression): number | undefined {
  const value = wholeDepthSource(expression);
  if (value === undefined) return undefined;
  if (framedNativeConstructor(value, UNDEFINED)) return 1;
  if (framedNativeConstructor(value, INFINITY)) return Infinity;
  if (framedNativeConstructor(value, NAN)) return 0;
  const infinity = signedInfinity(value);
  if (infinity !== undefined) return depthNumber(infinity);
  if (isVoidExpression(value) && framedMapKey(value.expression) !== undefined) return 1;
  const key = framedMapKey(value);
  if (key === undefined) return undefined;
  if (key === 'undefined' || key === 'true') return 1;
  if (key === 'false' || key === 'null') return 0;
  const prefix = key.startsWith('text:') ? 'text:' : 'number:';
  const text = key.slice(prefix.length);
  return depthNumber(Number(text));
}

/** Native ToIntegerOrInfinity leaves infinity and clamps the remaining numeric range at zero. */
function depthNumber(value: number): number {
  return Math.max(Math.trunc(value) || 0, 0);
}

/** Plain local aliases and primitive literal unions retain their declared finite depth domain. */
function writtenDepths(type: TypeNode): FlatDepths | undefined {
  const pending: { readonly type: TypeNode; readonly seen: ReadonlySet<TypeNode> }[] = [
    { type, seen: new Set() },
  ];
  const values = new Set<number>();
  let unknown = false;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.seen.has(next.type)) return undefined;
    const seen = new Set(next.seen).add(next.type);
    const step = depthTypeStep(next.type);
    if (step === undefined) return undefined;
    if (step.unknown) unknown = true;
    for (const value of step.values) values.add(value);
    pending.push(...step.next.map((nextType) => ({ type: nextType, seen })));
  }
  return { values: unknown ? undefined : [...values] };
}

interface DepthTypeStep {
  readonly values: readonly number[];
  readonly next: readonly TypeNode[];
  readonly unknown: boolean;
}

/** Only written primitive syntax or a plain local alias fixes a conversion domain. */
function depthTypeStep(type: TypeNode): DepthTypeStep | undefined {
  if (isParenthesizedTypeNode(type)) return { values: [], next: [type.type], unknown: false };
  if (isUnionTypeNode(type)) return { values: [], next: type.types, unknown: false };
  if (isLiteralTypeNode(type) && isExpression(type.literal)) {
    const fixed = literalDepth(type.literal);
    return fixed === undefined ? undefined : { values: [fixed], next: [], unknown: false };
  }
  if (type.kind === SyntaxKind.NumberKeyword || type.kind === SyntaxKind.StringKeyword)
    return { values: [], next: [], unknown: true };
  if (type.kind === SyntaxKind.BooleanKeyword) return { values: [0, 1], next: [], unknown: false };
  if (type.kind === SyntaxKind.UndefinedKeyword || type.kind === SyntaxKind.VoidKeyword)
    return { values: [1], next: [], unknown: false };
  const alias = plainAlias(type);
  return alias === undefined ? undefined : { values: [], next: [alias], unknown: false };
}

/** Whole constants retain a literal depth source; parameters stop at their original binding. */
function wholeDepthSource(expression: Expression): Expression | undefined {
  let value = unwrapped(expression);
  const seen = new Set<Expression>();
  while (isIdentifier(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) return value;
    const { binding } = selected;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return value;
    value = unwrapped(binding.initializer);
  }
  return value;
}

/** Only a lexical alias with no type parameters carries this primitive-only view. */
function plainAlias(type: TypeNode): TypeNode | undefined {
  if (
    !isTypeReferenceNode(type) ||
    !isIdentifier(type.typeName) ||
    type.typeArguments !== undefined
  )
    return undefined;
  const alias = localTypeBinding(type.typeName);
  return alias !== null &&
    alias !== undefined &&
    isTypeAliasDeclaration(alias) &&
    (alias.typeParameters?.length ?? 0) === 0
    ? alias.type
    : undefined;
}
