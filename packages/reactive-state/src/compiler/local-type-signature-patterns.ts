import {
  factory,
  isCallSignatureDeclaration,
  isConstructSignatureDeclaration,
  type CallSignatureDeclaration,
  type ConstructSignatureDeclaration,
  type TypeElement,
  type TypeLiteralNode,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { writtenSignaturePatternMatch } from './local-type-function-patterns.ts';

/** Anonymous signatures retain inference order and compatible non-inference source overloads. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;
type Compare = (checked: TypeReading, pattern: TypeReading) => boolean | undefined;
type Match = ReturnType<typeof writtenSignaturePatternMatch>;
interface Context {
  readonly resolve: Resolve;
  readonly compare: Compare;
  readonly overloads: Compare | undefined;
}
type Signature = CallSignatureDeclaration | ConstructSignatureDeclaration;
interface Pattern {
  readonly reading: TypeReading;
  readonly member: TypeElement;
}

/** A literal call or construct member, with the existing arity and parameter checks retained. */
export function signatureMemberPatternMatch(
  checked: TypeReading & { readonly type: TypeLiteralNode },
  pattern: Pattern,
  context: Context,
): Match | undefined {
  const { member } = pattern;
  if (!isCallSignatureDeclaration(member) && !isConstructSignatureDeclaration(member)) return;
  const sources: Signature[] = [];
  for (const each of checked.type.members) {
    if (
      (isCallSignatureDeclaration(member) && isCallSignatureDeclaration(each)) ||
      (isConstructSignatureDeclaration(member) && isConstructSignatureDeclaration(each))
    )
      sources.push(each);
  }
  if (sources.length > 1 && context.overloads !== undefined)
    return overloadMatch(checked, pattern, sources, context.overloads);
  const source = sources.at(-1);
  return source === undefined
    ? { matches: false, pairs: [] }
    : writtenSignaturePatternMatch(
        { reading: checked, signature: source },
        { reading: pattern.reading, signature: member },
        context.resolve,
        context.compare,
      );
}

/** Each target signature can be supplied by any compatible written source overload. */
function overloadMatch(
  checked: TypeReading,
  pattern: Pattern,
  sources: readonly Signature[],
  compare: Compare,
): Match {
  const expected = {
    ...pattern.reading,
    type: factory.createTypeLiteralNode([pattern.member]),
  };
  let matches: boolean | undefined = false;
  for (const source of sources) {
    const actual = { ...checked, type: factory.createTypeLiteralNode([source]) };
    const result = compare(actual, expected);
    if (result === true) return { matches: true, pairs: [] };
    if (result === undefined) matches = undefined;
  }
  return { matches, pairs: [] };
}
