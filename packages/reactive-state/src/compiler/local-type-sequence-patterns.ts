import {
  isArrayTypeNode,
  isIdentifier,
  isInferTypeNode,
  isNamedTupleMember,
  isOptionalTypeNode,
  isRestTypeNode,
  isTupleTypeNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  SyntaxKind,
  type TupleTypeNode,
  type TypeNode,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import {
  capturedArray,
  capturedSequence,
  type CapturedPosition,
} from './local-type-captured-sequences.ts';
import type { TypeReading } from './local-type-environment.ts';

/** Fixed positions and native array elements of explicitly written sequence patterns. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;
interface Pair {
  readonly checked: TypeReading;
  readonly pattern: TypeReading;
}
interface Sequence {
  readonly prefix: readonly TypeReading[];
  readonly suffix: readonly TypeReading[];
  readonly rest: TypeReading | undefined;
}
interface Position {
  readonly reading: TypeReading;
  readonly rest: boolean;
}
interface Match {
  readonly matches: boolean | undefined;
  readonly pairs: readonly Pair[];
}

/** A readonly sequence's underlying syntax, with its assignability marker kept separately. */
export function sequenceReading(reading: TypeReading): { reading: TypeReading; readonly: boolean } {
  const { type } = reading;
  return isTypeOperatorNode(type) && type.operator === SyntaxKind.ReadonlyKeyword
    ? { reading: { ...reading, type: type.type }, readonly: true }
    : { reading, readonly: nativeArrayName(type) === 'ReadonlyArray' };
}

/** Whether the operand explicitly declares a tuple or an unshadowed native array. */
export function sequencePattern(reading: TypeReading): boolean {
  return isTupleTypeNode(reading.type) || arrayElement(reading.type) !== undefined;
}

/** Guaranteed tuple positions and each known remaining element, with opaque rests left unshifted. */
export function sequencePatternMatch(
  checked: TypeReading,
  pattern: TypeReading,
  resolve: Resolve,
): Match | undefined {
  const source = sequenceElements(checked, resolve);
  if (source === undefined) return undefined;
  const target = sequenceElements(pattern, resolve);
  if (target === undefined) return optionalTupleMatch(source, pattern);
  const element = arrayElement(pattern.type);
  if (element !== undefined) return arrayMatch(source, { ...pattern, type: element }, resolve);
  if (target.rest === undefined) return fixedMatch(source, target, resolve);
  return restMatch(source, target, resolve, checked);
}

/** The native array type's name, only where no local type declaration or import binds it. */
function nativeArrayName(type: TypeReading['type']): 'Array' | 'ReadonlyArray' | undefined {
  if (!isTypeReferenceNode(type) || type.typeArguments?.length !== 1) return undefined;
  const { typeName } = type;
  let name: string | undefined;
  if (isIdentifier(typeName)) {
    if (localTypeBinding(typeName) === undefined) name = typeName.text;
  } else {
    name = qualifiedBuiltinName(typeName);
  }
  return name === 'Array' || name === 'ReadonlyArray' ? name : undefined;
}

/** A written array's element, including the unshadowed native generic spelling. */
function arrayElement(type: TypeReading['type']): TypeNode | undefined {
  if (isArrayTypeNode(type)) return type.elementType;
  return nativeArrayName(type) !== undefined && isTypeReferenceNode(type)
    ? type.typeArguments?.[0]
    : undefined;
}

/** Required positions on either side of a single rest, without assuming its length. */
function sequenceElements(reading: TypeReading, resolve: Resolve): Sequence | undefined {
  if (arrayElement(reading.type) !== undefined) return { prefix: [], rest: reading, suffix: [] };
  const positions = expandedPositions(reading, resolve);
  if (positions === undefined) return undefined;
  const prefix: TypeReading[] = [];
  const suffix: TypeReading[] = [];
  let rest: TypeReading | undefined;
  for (const position of positions) {
    if (position.rest) {
      if (rest !== undefined) return undefined;
      rest = position.reading;
    } else {
      (rest === undefined ? prefix : suffix).push(position.reading);
    }
  }
  return { prefix, rest, suffix };
}

/** Explicit finite tuple rests flatten in order, resolving aliases with their actual environments. */
function expandedPositions(
  reading: TypeReading,
  resolve: Resolve,
): readonly Position[] | undefined {
  const { type } = reading;
  if (!isTupleTypeNode(type)) return undefined;
  const positions: Position[] = [];
  const pending = type.elements.toReversed().map((element) => ({ element, reading }));
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const position = tuplePosition(at.element);
    if (position === undefined) return undefined;
    const value = { ...at.reading, type: position.type };
    if (position.rest) {
      const resolved = resolve(value);
      const expanded = resolved === undefined ? undefined : sequenceReading(resolved).reading;
      if (expanded !== undefined && isTupleTypeNode(expanded.type)) {
        pending.push(
          ...expanded.type.elements.toReversed().map((element) => ({ element, reading: expanded })),
        );
        continue;
      }
      positions.push({ reading: expanded ?? value, rest: true });
    } else {
      positions.push({ reading: value, rest: false });
    }
  }
  return positions;
}

/** The required or rest syntax of one tuple element; an optional position stays opaque. */
function tuplePosition(
  element: TupleTypeNode['elements'][number],
): { readonly rest: boolean; readonly type: TypeNode } | undefined {
  if (isOptionalTypeNode(element)) return undefined;
  if (isNamedTupleMember(element)) {
    return element.questionToken === undefined
      ? { rest: element.dotDotDotToken !== undefined, type: element.type }
      : undefined;
  }
  return isRestTypeNode(element)
    ? { rest: true, type: element.type }
    : { rest: false, type: element };
}

/** The element of a resolved array rest, retaining the caller's actual argument environment. */
function restElement(rest: TypeReading | undefined, resolve: Resolve): TypeReading | undefined {
  if (rest === undefined) return undefined;
  const resolved = resolve(rest);
  if (resolved === undefined) return undefined;
  const underlying = sequenceReading(resolved).reading;
  const element = arrayElement(underlying.type);
  return element === undefined ? undefined : { ...underlying, type: element };
}

/** An array pattern takes each fixed source position and any known source rest element. */
function arrayMatch(source: Sequence, pattern: TypeReading, resolve: Resolve): Match {
  const pairs = [...source.prefix, ...source.suffix].map((checked) => ({ checked, pattern }));
  const element = restElement(source.rest, resolve);
  if (element !== undefined) pairs.push({ checked: element, pattern });
  return { matches: element !== undefined || source.rest === undefined ? true : undefined, pairs };
}

/** Fixed tuples require the same finite number of required positions. */
function fixedMatch(source: Sequence, target: Sequence, resolve: Resolve): Match {
  if (source.rest !== undefined) {
    return opaqueFixedMatch(source, target.prefix, resolve);
  }
  if (source.prefix.length !== target.prefix.length) {
    return { matches: false, pairs: [] };
  }
  return {
    matches: true,
    pairs: target.prefix.flatMap((pattern, index) => {
      const checked = source.prefix[index];
      return checked === undefined ? [] : [{ checked, pattern }];
    }),
  };
}

/** An opaque rest may be finite; a native array rest cannot establish a fixed tuple length. */
function opaqueFixedMatch(
  source: Sequence,
  target: readonly TypeReading[],
  resolve: Resolve,
): Match {
  if (
    source.prefix.length + source.suffix.length > target.length ||
    restElement(source.rest, resolve) !== undefined
  ) {
    return { matches: false, pairs: [] };
  }
  return {
    matches: undefined,
    pairs: target.flatMap((pattern, index) => {
      const checked =
        source.prefix[index] ?? source.suffix[source.suffix.length - target.length + index];
      return checked === undefined ? [] : [{ checked, pattern }];
    }),
  };
}

/** A finite source's middle belongs to the rest; an opaque source rest fixes neither end's offset. */
function restMatch(
  source: Sequence,
  target: Sequence,
  resolve: Resolve,
  context: TypeReading,
): Match {
  if (source.rest === undefined) return finiteRestMatch(source.prefix, target, resolve, context);
  const pairs = boundaryPairs(source, target);
  const fits =
    source.prefix.length >= target.prefix.length && source.suffix.length >= target.suffix.length;
  if (!fits) return { matches: undefined, pairs };
  if (target.rest !== undefined && isInferTypeNode(target.rest.type)) {
    const prefix = source.prefix.slice(target.prefix.length);
    const suffix = source.suffix.slice(0, source.suffix.length - target.suffix.length);
    const checked =
      prefix.length === 0 && suffix.length === 0
        ? inferredRestReading(source.rest)
        : capturedSequence(context, remainingSequence(prefix, source.rest, suffix));
    pairs.push({ checked, pattern: target.rest });
    return { matches: true, pairs };
  }
  const element = restElement(target.rest, resolve);
  if (element === undefined) return { matches: undefined, pairs };
  const actual = restElement(source.rest, resolve);
  for (const checked of remainingPositions(source, target))
    pairs.push({ checked, pattern: element });
  if (actual !== undefined) pairs.push({ checked: actual, pattern: element });
  return { matches: actual === undefined ? undefined : true, pairs };
}

/** A native readonly array rest loses its readonly marker when inferred as tuple positions. */
function inferredRestReading(rest: TypeReading): TypeReading {
  const element = arrayElement(rest.type);
  return element !== undefined && nativeArrayName(rest.type) === 'ReadonlyArray'
    ? capturedArray(rest, { ...rest, type: element })
    : rest;
}

/** A finite tuple either satisfies the minimum length or cannot match the pattern at all. */
function finiteRestMatch(
  source: readonly TypeReading[],
  target: Sequence,
  resolve: Resolve,
  context: TypeReading,
): Match {
  if (source.length < target.prefix.length + target.suffix.length) {
    return { matches: false, pairs: [] };
  }
  const pairs = boundaryPairs({ prefix: source, rest: undefined, suffix: source }, target);
  const middle = source.slice(target.prefix.length, source.length - target.suffix.length);
  if (target.rest !== undefined && isInferTypeNode(target.rest.type)) {
    pairs.push({
      checked: capturedSequence(context, remainingSequence(middle, undefined, [])),
      pattern: target.rest,
    });
    return { matches: true, pairs };
  }
  const element = restElement(target.rest, resolve);
  if (element === undefined) return { matches: undefined, pairs };
  for (const checked of middle) pairs.push({ checked, pattern: element });
  return { matches: true, pairs };
}

/** Fixed positions retain their order around an unshifted remaining source rest. */
function remainingSequence(
  prefix: readonly TypeReading[],
  rest: TypeReading | undefined,
  suffix: readonly TypeReading[],
): readonly CapturedPosition[] {
  const positions = prefix.map((reading) => ({ reading, rest: false }));
  if (rest !== undefined) positions.push({ reading: rest, rest: true });
  positions.push(...suffix.map((reading) => ({ reading, rest: false })));
  return positions;
}

/** Only positions guaranteed before or after the rest contribute candidates to fixed bindings. */
function boundaryPairs(source: Sequence, target: Sequence): Pair[] {
  const pairs: Pair[] = [];
  for (const [index, pattern] of target.prefix.entries()) {
    const checked = source.prefix[index];
    if (checked !== undefined) pairs.push({ checked, pattern });
  }
  for (const [index, pattern] of target.suffix.entries()) {
    const checked = source.suffix[source.suffix.length - target.suffix.length + index];
    if (checked !== undefined) pairs.push({ checked, pattern });
  }
  return pairs;
}

/** Fixed source positions beyond the pattern's guaranteed prefix and suffix. */
function remainingPositions(source: Sequence, target: Sequence): readonly TypeReading[] {
  return [
    ...source.prefix.slice(target.prefix.length),
    ...source.suffix.slice(0, source.suffix.length - target.suffix.length),
  ];
}

/** Present required source positions supply optional fixed target patterns without shifting rests. */
function optionalTupleMatch(source: Sequence, pattern: TypeReading): Match | undefined {
  if (!isTupleTypeNode(pattern.type) || source.rest !== undefined) return undefined;
  const positions: { readonly type: TypeNode; readonly optional: boolean }[] = [];
  for (const element of pattern.type.elements) {
    if (isRestTypeNode(element)) return undefined;
    if (isNamedTupleMember(element)) {
      if (element.dotDotDotToken !== undefined) return undefined;
      positions.push({ type: element.type, optional: element.questionToken !== undefined });
    } else {
      positions.push({
        type: isOptionalTypeNode(element) ? element.type : element,
        optional: isOptionalTypeNode(element),
      });
    }
  }
  if (positions.every((position) => !position.optional)) return undefined;
  if (
    source.prefix.length > positions.length ||
    positions.slice(source.prefix.length).some((position) => !position.optional)
  )
    return { matches: false, pairs: [] };
  return {
    matches: true,
    pairs: source.prefix.flatMap((checked, index) => {
      const position = positions[index];
      return position === undefined
        ? []
        : [{ checked, pattern: { ...pattern, type: position.type } }];
    }),
  };
}
