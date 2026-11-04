import {
  isParenthesizedTypeNode,
  isArrayTypeNode,
  isConstructorTypeNode,
  isFunctionTypeNode,
  isIdentifier,
  isInferTypeNode,
  isMethodSignatureDeclaration,
  isNamedTupleMember,
  isOptionalTypeNode,
  isRestTypeNode,
  isTupleTypeNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type ConstructorTypeNode,
  type CallSignatureDeclaration,
  type ConstructSignatureDeclaration,
  type FunctionTypeNode,
  type MethodSignatureDeclaration,
  type ParameterDeclaration,
  type TypeNode,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { capturedArray, capturedSequence } from './local-type-captured-sequences.ts';
import { booleanReadings } from './local-type-distribution.ts';
import type { TypeReading } from './local-type-environment.ts';
import { functionParameterCaptures } from './local-type-function-captures.ts';
import { normalizedAnyOperand } from './local-type-never-any.ts';
import { optionalGenericPattern } from './local-type-optional-generics.ts';
import { receiverReading } from './local-type-receivers.ts';

/** Results and explicit parameter positions of written call and construct inference patterns. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;
type Compare = (checked: TypeReading, pattern: TypeReading) => boolean | undefined;
interface Pair {
  readonly checked: TypeReading;
  readonly pattern: TypeReading;
}
interface Match {
  readonly matches: boolean | undefined;
  readonly pairs: readonly Pair[];
}
interface Position {
  readonly reading: TypeReading;
  readonly optional: boolean;
}
interface ParameterPair {
  readonly checked: Position;
  readonly pattern: Position;
}
interface SignatureReading {
  readonly reading: TypeReading;
  readonly signature:
    | FunctionTypeNode
    | ConstructorTypeNode
    | MethodSignatureDeclaration
    | CallSignatureDeclaration
    | ConstructSignatureDeclaration;
}
interface Signature {
  readonly positions: readonly Position[];
  readonly rest: TypeReading | undefined;
  readonly capture: TypeReading | undefined;
  readonly required: number;
  readonly minimum: number;
  readonly uncertain: boolean;
}
interface WrittenPosition {
  readonly reading: TypeReading;
  readonly optional: boolean;
  readonly rest: boolean;
}

const UNDEFINED_KINDS = new Set([
  SyntaxKind.AnyKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.UnknownKeyword,
  SyntaxKind.VoidKeyword,
]);

const VOID_KINDS: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.VoidKeyword]);

/** Covariant results and syntax-known contravariant parameter compatibility, preserving scopes. */
export function functionPatternMatch(
  checked: TypeReading,
  pattern: TypeReading,
  resolve: Resolve,
  compare: Compare,
): Match | undefined {
  if (!writtenCallable(checked.type) || !writtenCallable(pattern.type)) return undefined;
  if (!constructorCompatible(checked.type, pattern.type)) return { matches: false, pairs: [] };
  return writtenSignaturePatternMatch(
    { reading: checked, signature: checked.type },
    { reading: pattern, signature: pattern.type },
    resolve,
    compare,
  );
}

/** Explicit signature positions and results, with method targets retaining method bivariance. */
export function writtenSignaturePatternMatch(
  checked: SignatureReading,
  pattern: SignatureReading,
  resolve: Resolve,
  compare: Compare,
): Match {
  const source = signatureOf(checked.reading, checked.signature, resolve);
  const target = signatureOf(pattern.reading, pattern.signature, resolve);
  const bivariant = isMethodSignatureDeclaration(pattern.signature);
  const optional = optionalGenericPattern(
    { checked, pattern, actual: source, target },
    resolve,
    (actual, expected) => {
      return parameterCompatibility(
        { optional: false, reading: actual },
        { optional: true, reading: expected },
        resolve,
        compare,
      );
    },
  );
  if (optional === undefined && incompatibleArity(source, target, bivariant)) {
    return { matches: false, pairs: [] };
  }
  const receiver = signatureReceiverMatch(checked, pattern, resolve, compare);
  if (receiver.matches === false) return { matches: false, pairs: [] };
  if (optional !== undefined) return { matches: optional.matches, pairs: receiver.pairs };
  const pairs: Pair[] = [...receiver.pairs];
  let matches: boolean | undefined =
    source.uncertain || target.uncertain || receiver.matches === undefined ? undefined : true;
  for (const pair of parameterPairs(source, target)) {
    const result = bivariant
      ? methodParameterMatch(pair, resolve, compare)
      : parameterMatch(pair.checked, pair.pattern, resolve, compare);
    if (result.matches === false) return { matches: false, pairs: [] };
    if (result.matches === undefined) matches = undefined;
    pairs.push(...result.pairs);
  }
  const captured = capturedParameters(source, target, checked.reading);
  if (captured !== undefined) pairs.push(captured);
  const sourceResult = checked.signature.type;
  const targetResult = pattern.signature.type;
  if (sourceResult === undefined || targetResult === undefined) {
    return { matches: undefined, pairs };
  }
  const expectedResult = { ...pattern.reading, type: targetResult };
  if (!voidResult(expectedResult, resolve)) {
    pairs.push({ checked: { ...checked.reading, type: sourceResult }, pattern: expectedResult });
  }
  return { matches, pairs };
}

/** Fixed written arity retains required, trailing-void and method-bivariance rules. */
function incompatibleArity(source: Signature, target: Signature, bivariant: boolean): boolean {
  const targetRequired = target.positions.filter((position) => !position.optional).length;
  return (
    !source.uncertain &&
    !target.uncertain &&
    target.rest === undefined &&
    target.capture === undefined &&
    (source.minimum > target.positions.length || (!bivariant && source.required > targetRequired))
  );
}

/**
 * Whether a target's result is `void` itself, through parentheses, aliases and actual arguments in
 * its own environment, as TypeScript reads a void-returning target: it accepts any result. A union
 * holding `void` is compared as any other result.
 */
function voidResult(reading: TypeReading, resolve: Resolve): boolean {
  let at: TypeReading | undefined = reading;
  const seen = new Set<TypeReading['type']>();
  while (at !== undefined && !seen.has(at.type)) {
    const current: TypeReading = at;
    const type: TypeReading['type'] = current.type;
    seen.add(type);
    if (type.kind === SyntaxKind.VoidKeyword) return true;
    at = isParenthesizedTypeNode(type) ? { ...current, type: type.type } : resolve(current);
  }
  return false;
}

/** Receiver annotations compare separately from runtime positions and variadic arity. */
function signatureReceiverMatch(
  checked: SignatureReading,
  pattern: SignatureReading,
  resolve: Resolve,
  compare: Compare,
): Match {
  const actualReceiver = receiverReading(checked.reading, checked.signature.parameters);
  const expectedReceiver = receiverReading(pattern.reading, pattern.signature.parameters);
  return actualReceiver === undefined || expectedReceiver === undefined
    ? { matches: true, pairs: [] }
    : parameterMatch(
        { optional: false, reading: actualReceiver },
        { optional: false, reading: expectedReceiver },
        resolve,
        compare,
      );
}

/** A bare rest infer receives the whole remaining source tuple or native array, once. */
function capturedParameters(
  source: Signature,
  target: Signature,
  context: TypeReading,
): Pair | undefined {
  if (target.capture === undefined || source.uncertain || target.uncertain) return undefined;
  const remaining = source.positions.slice(target.positions.length);
  const positions = remaining.map((position) => ({ ...position, rest: false }));
  let checked: TypeReading;
  if (source.rest !== undefined && positions.length === 0) {
    checked = capturedArray(context, source.rest);
  } else {
    checked = capturedSequence(context, [
      ...positions,
      ...(source.rest === undefined
        ? []
        : [{ reading: capturedArray(context, source.rest), rest: true }]),
    ]);
  }
  return { checked, pattern: target.capture };
}

/** Explicit call or construct signatures, with unknown callable forms left opaque. */
function writtenCallable(
  type: TypeReading['type'],
): type is FunctionTypeNode | ConstructorTypeNode {
  return isFunctionTypeNode(type) || isConstructorTypeNode(type);
}

/** Abstract constructs cannot satisfy concrete constructs, and construct values are not calls. */
function constructorCompatible(
  source: FunctionTypeNode | ConstructorTypeNode,
  target: FunctionTypeNode | ConstructorTypeNode,
): boolean {
  if (isConstructorTypeNode(source) !== isConstructorTypeNode(target)) return false;
  if (!isConstructorTypeNode(source) || !isConstructorTypeNode(target)) return true;
  const sourceAbstract = source.modifiers?.some((each) => each.kind === SyntaxKind.AbstractKeyword);
  const targetAbstract = target.modifiers?.some((each) => each.kind === SyntaxKind.AbstractKeyword);
  return sourceAbstract !== true || targetAbstract === true;
}

/** Method variance accepts either whole parameter relation without mixing union alternatives. */
function methodParameterMatch(pair: ParameterPair, resolve: Resolve, compare: Compare): Match {
  const result = parameterMatch(pair.checked, pair.pattern, resolve, compare);
  if (result.matches === true || result.pairs.length > 0) return result;
  const reverse = parameterCompatibility(pair.pattern, pair.checked, resolve, compare);
  if (reverse === true) return { matches: true, pairs: [] };
  if (reverse === undefined || result.matches === undefined)
    return { matches: undefined, pairs: [] };
  return result;
}

/** A variadic argument has no optional fixed-position marker. */
function restPosition(reading: TypeReading | undefined): Position | undefined {
  return reading === undefined ? undefined : { optional: false, reading };
}

/** Corresponding argument positions, ignoring extra arguments a source function does not read. */
function parameterPairs(source: Signature, target: Signature): readonly ParameterPair[] {
  const pairs: ParameterPair[] = [];
  const count = Math.max(source.positions.length, target.positions.length);
  for (let index = 0; index < count; index += 1) {
    const checked = source.positions[index] ?? restPosition(source.rest);
    const pattern = target.positions[index] ?? restPosition(target.rest);
    if (checked !== undefined && pattern !== undefined) pairs.push({ checked, pattern });
  }
  if (source.rest !== undefined && target.rest !== undefined) {
    pairs.push({
      checked: { optional: false, reading: source.rest },
      pattern: { optional: false, reading: target.rest },
    });
  }
  return pairs;
}

/** Direct inferred parameters retain the source type; ordinary parameters compare in reverse. */
function parameterMatch(
  checked: Position,
  pattern: Position,
  resolve: Resolve,
  compare: Compare,
): Match {
  const source = resolve(checked.reading);
  const target = resolve(pattern.reading);
  if (source === undefined || target === undefined) return { matches: undefined, pairs: [] };
  if (isInferTypeNode(target.type)) {
    return { matches: true, pairs: [{ checked: source, pattern: target }] };
  }
  const captures = functionParameterCaptures(source, target, resolve);
  if (captures.length > 0) return { matches: undefined, pairs: captures };
  return {
    matches: parameterCompatibility(
      { ...checked, reading: source },
      { ...pattern, reading: target },
      resolve,
      compare,
    ),
    pairs: [],
  };
}

/** Each supplied written alternative fits one accepted alternative; structural doubt stays opaque. */
function parameterCompatibility(
  source: Position,
  target: Position,
  resolve: Resolve,
  compare: Compare,
): boolean | undefined {
  if (
    target.optional &&
    !source.optional &&
    !acceptsKind(source.reading, resolve, UNDEFINED_KINDS)
  ) {
    return false;
  }
  const accepted = parameterAlternatives(source.reading, resolve, compare);
  let matches: boolean | undefined = true;
  for (const provided of parameterAlternatives(target.reading, resolve, compare)) {
    if (source.optional && provided.type.kind === SyntaxKind.UndefinedKeyword) continue;
    const relations = new Set(accepted.map((each) => parameterTruth(provided, each, compare)));
    if (relations.has(true)) continue;
    if (!relations.has(undefined)) return false;
    matches = undefined;
  }
  return matches;
}

/** The existing explicit any/never parameter rules, then the syntax comparison in reverse. */
function parameterTruth(
  provided: TypeReading,
  accepted: TypeReading,
  compare: Compare,
): boolean | undefined {
  if (
    accepted.type.kind === SyntaxKind.NeverKeyword &&
    provided.type.kind === SyntaxKind.AnyKeyword
  ) {
    return false;
  }
  if (
    accepted.type.kind === SyntaxKind.AnyKeyword ||
    provided.type.kind === SyntaxKind.AnyKeyword
  ) {
    return true;
  }
  return compare(provided, accepted);
}

/** Explicit union members and boolean literals preserve their original argument environments. */
function parameterAlternatives(
  reading: TypeReading,
  resolve: Resolve,
  compare: Compare,
): readonly TypeReading[] {
  const result: TypeReading[] = [];
  const pending = [normalizedAnyOperand(reading, resolve, compare) ?? reading];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const operand = resolve(at) ?? at;
    if (isUnionTypeNode(operand.type)) {
      pending.push(...operand.type.types.map((type) => ({ ...operand, type })));
    } else {
      result.push(...(booleanReadings(operand) ?? [operand]));
    }
  }
  return result;
}

/** Required and optional fixed arguments, with known finite tuple rests flattened in place. */
function signatureOf(
  reading: TypeReading,
  type:
    | FunctionTypeNode
    | ConstructorTypeNode
    | MethodSignatureDeclaration
    | CallSignatureDeclaration
    | ConstructSignatureDeclaration,
  resolve: Resolve,
): Signature {
  const written = type.parameters
    .filter((parameter) => !isIdentifier(parameter.name) || parameter.name.text !== 'this')
    .map((parameter) => parameterPosition(parameter, reading));
  if (written.includes(undefined)) {
    return {
      capture: undefined,
      minimum: 0,
      positions: [],
      required: 0,
      rest: undefined,
      uncertain: true,
    };
  }
  const positions = written.flatMap((position) => (position === undefined ? [] : [position]));
  const last = positions.at(-1);
  const capture = last?.rest === true ? resolve(last.reading) : undefined;
  if (capture !== undefined && isInferTypeNode(capture.type)) {
    return { ...expandedSignature(positions.slice(0, -1), resolve), capture };
  }
  return expandedSignature(positions, resolve);
}

/** Finite tuple rests add positions; an unknown rest keeps the remaining signature uncertain. */
function expandedSignature(written: readonly WrittenPosition[], resolve: Resolve): Signature {
  const positions: Position[] = [];
  let rest: TypeReading | undefined;
  const pending = written.toReversed();
  let uncertain = false;
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (!at.rest) {
      if (rest === undefined) positions.push({ optional: at.optional, reading: at.reading });
      else uncertain = true;
      continue;
    }
    const expansion = restPositions(at.reading, resolve);
    if ('positions' in expansion) {
      pending.push(...expansion.positions.toReversed());
      continue;
    }
    if (rest !== undefined || expansion.element === undefined) {
      uncertain = true;
    } else {
      rest = expansion.element;
    }
  }
  return {
    capture: undefined,
    positions,
    minimum: minimumArguments(positions, resolve),
    required: positions.filter(
      (position) => !position.optional && !acceptsKind(position.reading, resolve, UNDEFINED_KINDS),
    ).length,
    rest,
    uncertain,
  };
}

/** A missing fixed position is allowed only when optional or among the trailing void positions. */
function minimumArguments(positions: readonly Position[], resolve: Resolve): number {
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    const position = positions[index];
    if (
      position !== undefined &&
      !position.optional &&
      !acceptsKind(position.reading, resolve, VOID_KINDS)
    ) {
      return index + 1;
    }
  }
  return 0;
}

/** A native kind retained through explicit aliases and unions, with cycles left unknown. */
function acceptsKind(
  reading: TypeReading,
  resolve: Resolve,
  kinds: ReadonlySet<SyntaxKind>,
): boolean {
  const pending = [reading];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const resolved = resolve(at);
    if (resolved === undefined) continue;
    if (isUnionTypeNode(resolved.type)) {
      pending.push(...resolved.type.types.map((type) => ({ ...resolved, type })));
      continue;
    }
    if (kinds.has(resolved.type.kind)) return true;
  }
  return false;
}

/** A resolved tuple's written positions or an array's element in the operand's original scope. */
function restPositions(
  reading: TypeReading,
  resolve: Resolve,
):
  | { readonly positions: readonly WrittenPosition[] }
  | { readonly element: TypeReading | undefined } {
  const resolved = resolve(reading);
  if (resolved !== undefined && isTupleTypeNode(resolved.type)) {
    return { positions: resolved.type.elements.map((member) => tuplePosition(member, resolved)) };
  }
  const element = resolved === undefined ? undefined : arrayElement(resolved.type);
  return {
    element:
      resolved === undefined || element === undefined ? undefined : { ...resolved, type: element },
  };
}

/** A function signature's written parameter; a receiver annotation is left unresolved. */
function parameterPosition(
  parameter: ParameterDeclaration,
  reading: TypeReading,
): WrittenPosition | undefined {
  if (
    parameter.type === undefined ||
    (isIdentifier(parameter.name) && parameter.name.text === 'this')
  ) {
    return undefined;
  }
  return {
    optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
    reading: { ...reading, type: parameter.type },
    rest: parameter.dotDotDotToken !== undefined,
  };
}

/** A finite tuple rest preserves optional positions and each nested rest's own environment. */
function tuplePosition(type: TypeNode, reading: TypeReading): WrittenPosition {
  if (isNamedTupleMember(type)) {
    return {
      optional: type.questionToken !== undefined,
      reading: { ...reading, type: type.type },
      rest: type.dotDotDotToken !== undefined,
    };
  }
  if (isOptionalTypeNode(type)) {
    return { optional: true, reading: { ...reading, type: type.type }, rest: false };
  }
  return isRestTypeNode(type)
    ? { optional: false, reading: { ...reading, type: type.type }, rest: true }
    : { optional: false, reading: { ...reading, type }, rest: false };
}

/** An array rest's element, including native generic spellings without shadowing local names. */
function arrayElement(type: TypeReading['type']): TypeNode | undefined {
  if (isArrayTypeNode(type)) return type.elementType;
  if (!isTypeReferenceNode(type) || type.typeArguments?.length !== 1) return undefined;
  const name = type.typeName;
  if (isIdentifier(name)) {
    return name.text === 'Array' && localTypeBinding(name) === undefined
      ? type.typeArguments[0]
      : undefined;
  }
  return qualifiedBuiltinName(name) === 'Array' ? type.typeArguments[0] : undefined;
}
