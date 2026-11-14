import {
  factory,
  isFunctionTypeNode,
  isInferTypeNode,
  SyntaxKind,
  isMethodSignatureDeclaration,
  isPropertySignatureDeclaration,
  type FunctionTypeNode,
  type MethodSignatureDeclaration,
  type TypeElement,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { writtenSignaturePatternMatch } from './local-type-function-patterns.ts';

/** Named written methods matched as callable values, keeping their return separate from the value. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;
type Compare = (checked: TypeReading, pattern: TypeReading) => boolean | undefined;
interface SignatureReading {
  readonly reading: TypeReading;
  readonly signature: FunctionTypeNode | MethodSignatureDeclaration;
}
interface MemberReading {
  readonly reading: TypeReading;
  readonly member: TypeElement;
}
interface Match {
  readonly matches: boolean | undefined;
  readonly pairs: readonly { readonly checked: TypeReading; readonly pattern: TypeReading }[];
}

/** A method or corresponding function property, through its own lexical argument environment. */
export function methodPatternMatch(
  checked: MemberReading,
  pattern: MemberReading,
  resolve: Resolve,
  compare: Compare,
): Match | undefined {
  if (
    !isMethodSignatureDeclaration(checked.member) &&
    !isMethodSignatureDeclaration(pattern.member)
  )
    return;
  if (
    isMethodSignatureDeclaration(checked.member) &&
    isPropertySignatureDeclaration(pattern.member)
  ) {
    const expected = resolve({ ...pattern.reading, type: pattern.member.type });
    if (expected !== undefined && isInferTypeNode(expected.type)) {
      return {
        matches: true,
        pairs: [
          { checked: { ...checked.reading, type: methodValue(checked.member) }, pattern: expected },
        ],
      };
    }
  }
  const actual = signatureReading(checked.member, checked.reading, resolve);
  const expected = signatureReading(pattern.member, pattern.reading, resolve);
  return actual === undefined || expected === undefined
    ? { matches: undefined, pairs: [] }
    : writtenSignaturePatternMatch(actual, expected, resolve, compare);
}

/** An explicit method signature, or a locally resolved function-valued property. */
function signatureReading(
  member: TypeElement,
  reading: TypeReading,
  resolve: Resolve,
): SignatureReading | undefined {
  if (isMethodSignatureDeclaration(member)) return { reading, signature: member };
  if (!isPropertySignatureDeclaration(member)) return undefined;
  const resolved = resolve({ ...reading, type: member.type });
  return resolved !== undefined && isFunctionTypeNode(resolved.type)
    ? { reading: resolved, signature: resolved.type }
    : undefined;
}

const METHOD_VALUES = new WeakMap<MethodSignatureDeclaration, FunctionTypeNode>();

/** A method's callable value retains its original parameter and result syntax, never just its result. */
function methodValue(method: MethodSignatureDeclaration): FunctionTypeNode {
  const previous = METHOD_VALUES.get(method);
  if (previous !== undefined) return previous;
  const value = factory.createFunctionTypeNode(
    method.typeParameters,
    method.parameters,
    method.type ?? factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword),
  );
  METHOD_VALUES.set(method, value);
  return value;
}
