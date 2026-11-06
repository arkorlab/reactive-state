import {
  type CallSignatureDeclaration,
  type ConstructSignatureDeclaration,
  type ConstructorTypeNode,
  type FunctionTypeNode,
  isConstructorTypeNode,
  isFunctionTypeNode,
  isIdentifier,
  isInferTypeNode,
  isTypeParameterDeclaration,
  isTypeReferenceNode,
  type MethodSignatureDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { constraintReading, type TypeReading } from './local-type-environment.ts';

/** Bare generic value inputs retain possible undefined without instantiating a callable result. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;
interface Position {
  readonly reading: TypeReading;
  readonly optional: boolean;
}
interface Signature {
  readonly positions: readonly Position[];
  readonly rest: TypeReading | undefined;
  readonly capture: TypeReading | undefined;
  readonly uncertain: boolean;
}
interface Reading {
  readonly reading: TypeReading;
  readonly signature:
    | FunctionTypeNode
    | ConstructorTypeNode
    | MethodSignatureDeclaration
    | CallSignatureDeclaration
    | ConstructSignatureDeclaration;
}
const TOP_RESULTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AnyKeyword,
  SyntaxKind.UnknownKeyword,
  SyntaxKind.VoidKeyword,
]);

/** One optional target input and an unconstrained result keep the uninstantiated source possible. */
export function optionalGenericPattern(
  source: {
    readonly checked: Reading;
    readonly pattern: Reading;
    readonly actual: Signature;
    readonly target: Signature;
  },
  resolve: Resolve,
  compatible: (source: TypeReading, target: TypeReading) => boolean | undefined,
): { readonly matches: boolean | undefined } | undefined {
  const { checked, pattern, actual, target } = source;
  if (!callable(checked.signature) || !callable(pattern.signature)) return undefined;
  if (!fixedOptionalPair(actual, target) || !topResult(pattern, resolve)) return undefined;
  const first = actual.positions[0];
  const expected = target.positions[0];
  if (first === undefined || expected === undefined) return undefined;
  const value = resolve(first.reading);
  const provided = resolve(expected.reading);
  if (value === undefined || provided === undefined || containsInfer(provided.type))
    return undefined;
  if (!isTypeReferenceNode(value.type) || !isIdentifier(value.type.typeName)) return undefined;
  const binding = localTypeBinding(value.type.typeName);
  if (
    binding === undefined ||
    binding === null ||
    !isTypeParameterDeclaration(binding) ||
    binding.parent !== checked.signature ||
    value.bindings.has(binding)
  )
    return undefined;
  const constraint = constraintReading(binding, value);
  const matches =
    constraint !== undefined && compatible(constraint, expected.reading) === false
      ? false
      : undefined;
  return { matches };
}

/** Only written function and constructor types enter the added non-inference relation. */
function callable(type: Reading['signature']): type is FunctionTypeNode | ConstructorTypeNode {
  return isFunctionTypeNode(type) || isConstructorTypeNode(type);
}

/** Additional optional source positions are ignored; required tails and unresolved rests are not. */
function fixedOptionalPair(source: Signature, target: Signature): boolean {
  return (
    !source.uncertain &&
    !target.uncertain &&
    source.rest === undefined &&
    target.rest === undefined &&
    source.capture === undefined &&
    target.capture === undefined &&
    target.positions.length === 1 &&
    target.positions[0]?.optional === true &&
    source.positions[0]?.optional === false &&
    source.positions.slice(1).every((each) => each.optional)
  );
}

/** Any, unknown and void ignore the result; aliases retain their original lexical environments. */
function topResult(pattern: Reading, resolve: Resolve): boolean {
  const type = pattern.signature.type;
  if (type === undefined) return false;
  let current: TypeReading | undefined = { ...pattern.reading, type };
  const seen = new Set<Node>();
  while (current !== undefined && !seen.has(current.type)) {
    seen.add(current.type);
    if (TOP_RESULTS.has(current.type.kind)) return true;
    current = resolve(current);
  }
  return false;
}

/** Captured target inputs retain the original inference path and its candidate bindings. */
function containsInfer(node: Node): boolean {
  const pending = [node];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isInferTypeNode(at)) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
