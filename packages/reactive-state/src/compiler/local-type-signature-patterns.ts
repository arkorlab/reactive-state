import {
  factory,
  isCallSignatureDeclaration,
  isConstructorTypeNode,
  isConstructSignatureDeclaration,
  isFunctionTypeNode,
  isTypeLiteralNode,
  SyntaxKind,
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
type SignatureReading = Parameters<typeof writtenSignaturePatternMatch>[0];
interface Pattern {
  readonly reading: TypeReading;
  readonly member: TypeElement;
}
interface Parts {
  readonly sources: readonly TypeReading[];
  readonly unknown: boolean;
}

const UNCERTAIN: Match = { matches: undefined, pairs: [] };

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

/**
 * A call or construct member that the parts of an interface, an intersection or a function type
 * supply: the one written signature of its kind among them is matched as a literal's own one is,
 * its inferred values in its own part's environment. Several, whose order and overloads the parts
 * decide, none, or a part the reader cannot see leave the requirement uncertain.
 */
export function partSignatureMatch(
  parts: Parts,
  pattern: Pattern,
  context: Omit<Context, 'overloads'>,
): Match | undefined {
  const { member } = pattern;
  if (!isCallSignatureDeclaration(member) && !isConstructSignatureDeclaration(member)) return;
  if (parts.unknown) return UNCERTAIN;
  const signatures: SignatureReading[] = [];
  for (const source of parts.sources) {
    const written = partSignatures(source, member);
    if (written === undefined) return UNCERTAIN;
    signatures.push(...written);
  }
  const [only] = signatures;
  if (only === undefined || signatures.length > 1) return UNCERTAIN;
  // An abstract constructor type is never assignable to a construct signature a literal writes.
  if (
    isConstructorTypeNode(only.signature) &&
    only.signature.modifiers?.some((each) => each.kind === SyntaxKind.AbstractKeyword) === true
  )
    return { matches: false, pairs: [] };
  return writtenSignaturePatternMatch(
    only,
    { reading: pattern.reading, signature: member },
    context.resolve,
    context.compare,
  );
}

/** A part's written signatures of the member's kind; none known of a part of another shape. */
function partSignatures(
  source: TypeReading,
  member: Signature,
): readonly SignatureReading[] | undefined {
  const { type } = source;
  const call = isCallSignatureDeclaration(member);
  if (isFunctionTypeNode(type)) return call ? [{ reading: source, signature: type }] : [];
  if (isConstructorTypeNode(type)) return call ? [] : [{ reading: source, signature: type }];
  if (!isTypeLiteralNode(type)) return undefined;
  const signatures: SignatureReading[] = [];
  for (const each of type.members) {
    if (
      (call && isCallSignatureDeclaration(each)) ||
      (!call && isConstructSignatureDeclaration(each))
    )
      signatures.push({ reading: source, signature: each });
  }
  return signatures;
}
