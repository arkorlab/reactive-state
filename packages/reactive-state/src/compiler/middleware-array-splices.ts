import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedSourceValues } from './framed-sources.ts';
import { middlewareLiteralOwners, middlewareStableCopy } from './middleware-array-copy-origins.ts';

/** Native shallow-copy slots retain original payloads or inserted argument nodes while stable. */

interface SpliceInput {
  readonly call: CallExpression;
  readonly keys: readonly string[];
  readonly receiver: Expression;
  readonly given: readonly Expression[] | undefined;
  readonly applied?: Expression;
  readonly length: number;
  readonly relative: boolean;
}

interface SliceCopyInput {
  readonly call: CallExpression;
  readonly keys: readonly string[];
  readonly method: string;
  readonly receiver: Expression;
  readonly given: readonly Expression[] | undefined;
  readonly applied?: Expression;
  readonly source: ArrayLiteralExpression;
  readonly index: number;
  readonly relative: boolean;
}

interface NativeBounds {
  readonly start: (
    value: Expression | undefined,
    length: number,
    fallback: number,
  ) => number | undefined;
  readonly count: (value: Expression | undefined) => number | undefined;
  readonly possible?: (elements: readonly Expression[], keys: readonly string[]) => boolean;
}

interface SpliceWindow {
  readonly start: number;
  readonly removed: number;
  readonly inserted: readonly Expression[];
}

interface SliceProjection {
  readonly of: Expression;
  readonly keys: readonly string[];
  readonly tail: readonly string[];
  readonly slot?: string;
}

interface SpliceOrigin extends SliceProjection {
  readonly references: readonly Identifier[];
}

/** Canonical integer keys select copied slots; negative keys apply only to relative at reads. */
export function middlewareCopySlotIndex(
  key: string | undefined,
  relative: boolean,
): number | undefined {
  if (key === undefined) return undefined;
  const index = Number(key);
  return String(index) === key && Number.isSafeInteger(index) && (relative || index >= 0)
    ? index
    : undefined;
}

/** Known slice windows map a copied slot back to its original position while the copy is stable. */
export function middlewareSliceProjection(
  input: SliceCopyInput,
  bounds: Required<NativeBounds>,
): SliceProjection | undefined {
  const { call, keys, method, receiver, given, applied, source, index, relative } = input;
  if (method === 'toSpliced') {
    const spliced = middlewareArraySplice(
      { call, keys, receiver, given, applied, length: source.elements.length, relative },
      bounds,
    );
    return spliced.length === 1 ? spliced[0] : undefined;
  }
  const tail = keys.slice(1);
  if (!middlewareStableCopy(call, receiver, given))
    return unknownSliceOrigin(receiver, source, index, { tail, possible: bounds.possible });
  if (method !== 'slice') return reorderedSliceOrigin(input, tail, bounds.possible);
  const prefix = given === undefined ? undefined : framedArgumentPrefix(call, given, 2);
  const definite = prefix !== undefined && !prefix.unknown && prefix.alternatives === undefined;
  const start = definite ? bounds.start(prefix.values[0], source.elements.length, 0) : undefined;
  const end = definite
    ? bounds.start(prefix.values[1], source.elements.length, source.elements.length)
    : undefined;
  if (start === undefined || end === undefined)
    return unknownSliceOrigin(receiver, source, index, { tail, possible: bounds.possible });
  const length = Math.max(end - start, 0);
  const offset = relative && index < 0 ? length + index : index;
  const position = start + offset;
  const element = source.elements[position];
  if (element === undefined || offset < 0 || offset >= length || isOmittedExpression(element))
    return undefined;
  return { of: receiver, keys: [String(position), ...tail], tail, slot: String(offset) };
}

/** Original argument count distinguishes cloning, suffix removal and explicit undefined deletion. */
export function middlewareArraySplice(
  input: SpliceInput,
  bounds: NativeBounds,
): readonly SpliceOrigin[] {
  const index = middlewareCopySlotIndex(input.keys[0], input.relative);
  if (index === undefined) return [];
  const { call, given, length, receiver } = input;
  const prefix = given === undefined ? undefined : framedArgumentPrefix(call, given, Infinity);
  if (
    prefix === undefined ||
    prefix.unknown ||
    prefix.alternatives !== undefined ||
    !middlewareStableCopy(call, receiver, given)
  )
    return unknownSpliceOrigins(input, index);
  const args = prefix.values;
  const start = bounds.start(args[0], length, 0);
  const count = args.length < 2 ? undefined : bounds.count(args[1]);
  if (start === undefined || (count === undefined && args.length >= 2))
    return unknownSpliceOrigins(input, index);
  let removed = 0;
  if (args.length === 1) removed = length - start;
  else if (args.length >= 2) removed = Math.min(Math.max(count ?? 0, 0), length - start);
  return selectedSpliceSlot(input, index, { start, removed, inserted: args.slice(2) });
}

/** Opaque bounds or unstable receivers retain possible collections without an exact slot offset. */
function unknownSliceOrigin(
  receiver: Expression,
  source: ArrayLiteralExpression,
  index: number,
  options: {
    readonly tail: readonly string[];
    readonly possible: (elements: readonly Expression[], keys: readonly string[]) => boolean;
  },
): SliceProjection | undefined {
  if (!options.possible(source.elements, [])) return undefined;
  const base = { of: receiver, keys: [], tail: options.tail };
  return index < 0 ? base : { ...base, slot: String(index) };
}

/** Reversal fixes its copied position; sorting retains possible original payloads without assuming order. */
function reorderedSliceOrigin(
  input: SliceCopyInput,
  tail: readonly string[],
  possible: (elements: readonly Expression[], keys: readonly string[]) => boolean,
): SliceProjection | undefined {
  const { method, receiver, source, index, relative } = input;
  const length = source.elements.length;
  const offset = relative && index < 0 ? length + index : index;
  if (offset < 0 || offset >= length) return undefined;
  if (method === 'toSorted')
    return possible(source.elements, [])
      ? { of: receiver, keys: [], tail, slot: String(offset) }
      : undefined;
  const position = length - 1 - offset;
  const element = source.elements[position];
  return element === undefined || isOmittedExpression(element)
    ? undefined
    : { of: receiver, keys: [String(position), ...tail], tail, slot: String(offset) };
}

/** Fixed copied positions distinguish retained slots from the actual inserted payload nodes. */
function selectedSpliceSlot(
  input: SpliceInput,
  index: number,
  window: SpliceWindow,
): readonly SpliceOrigin[] {
  const { receiver, keys, length, relative } = input;
  const { start, removed, inserted } = window;
  const tail = keys.slice(1);
  const copiedLength = length - removed + inserted.length;
  const offset = relative && index < 0 ? copiedLength + index : index;
  if (offset < 0 || offset >= copiedLength) return [];
  const slot = String(offset);
  if (offset >= start && offset < start + inserted.length) {
    const value = inserted[offset - start];
    return value === undefined ? [] : [{ ...elementOrigin(value, tail), slot }];
  }
  const position = offset < start ? offset : offset - inserted.length + removed;
  return [
    {
      of: receiver,
      keys: [String(position), ...tail],
      tail,
      slot,
      references: middlewareLiteralOwners(receiver),
    },
  ];
}

/** Opaque bounds, spreads or side-effecting arguments retain receiver and inserted candidates. */
function unknownSpliceOrigins(input: SpliceInput, index: number): readonly SpliceOrigin[] {
  const tail = input.keys.slice(1);
  const slot = index < 0 ? undefined : String(index);
  const origins = [
    wholeOrigin(input.receiver, tail),
    ...insertedOrigins(input.call, input.given, input.applied, tail),
  ];
  return slot === undefined ? origins : origins.map((origin) => ({ ...origin, slot }));
}

/** Candidate inserted values come from arguments past the two bounds or unresolved spread tuples. */
function insertedOrigins(
  call: CallExpression,
  given: readonly Expression[] | undefined,
  applied: Expression | undefined,
  tail: readonly string[],
): readonly SpliceOrigin[] {
  if (given === undefined)
    return applied === undefined ? [] : spreadOrigins(applied, tail, new Set());
  const prefix = framedArgumentPrefix(call, given, Infinity);
  if (!prefix.unknown && prefix.alternatives === undefined)
    return prefix.values.slice(2).map((value) => elementOrigin(value, tail));
  return mixedArgumentOrigins(call, given, tail);
}

/** Arguments after an unresolved spread may land in the inserted range regardless of written index. */
function mixedArgumentOrigins(
  call: CallExpression,
  given: readonly Expression[],
  tail: readonly string[],
): readonly SpliceOrigin[] {
  const origins: SpliceOrigin[] = [];
  const state = { position: 0, afterSpread: false };
  for (const argument of given) {
    if (!isSpreadElement(argument)) {
      appendInserted(origins, [argument], state, tail);
      continue;
    }
    const expanded = framedArgumentPrefix(call, [argument], Infinity);
    if (!expanded.unknown && expanded.alternatives === undefined) {
      appendInserted(origins, expanded.values, state, tail);
      continue;
    }
    state.afterSpread = true;
    origins.push(...spreadOrigins(argument.expression, tail, new Set()));
  }
  return origins;
}

/** Only argument slots at or after index two, or shifted past an opaque spread, insert items. */
function appendInserted(
  origins: SpliceOrigin[],
  values: readonly Expression[],
  state: { position: number; afterSpread: boolean },
  tail: readonly string[],
): void {
  for (const value of values) {
    if (state.afterSpread || state.position >= 2) origins.push(elementOrigin(value, tail));
    state.position += 1;
  }
}

/** Unresolved spread expressions keep whole array containers and literal branch elements. */
function spreadOrigins(
  expression: Expression,
  tail: readonly string[],
  seen: Set<Node>,
): readonly SpliceOrigin[] {
  const value = unwrapped(expression);
  if (seen.has(value)) return [];
  seen.add(value);
  if (isArrayLiteralExpression(value)) return arraySpreadOrigins(value.elements, tail, seen);
  const branches = framedSourceValues(value);
  if (branches !== undefined)
    return branches.flatMap((branch) => spreadOrigins(branch, tail, seen));
  return [wholeOrigin(expression, tail)];
}

/** Literal spread arrays contribute each non-hole element and recurse into nested spreads. */
function arraySpreadOrigins(
  elements: readonly Expression[],
  tail: readonly string[],
  seen: Set<Node>,
): readonly SpliceOrigin[] {
  const origins: SpliceOrigin[] = [];
  for (const element of elements) {
    if (isOmittedExpression(element)) continue;
    if (isSpreadElement(element)) origins.push(...spreadOrigins(element.expression, tail, seen));
    else origins.push(elementOrigin(element, tail));
  }
  return origins;
}

/** An inserted argument supplies the selected element directly under the remaining member tail. */
function elementOrigin(of: Expression, tail: readonly string[]): SpliceOrigin {
  return { of, keys: tail, tail, references: middlewareLiteralOwners(of) };
}

/** An array container with an unknown selected slot retains its whole collection identity. */
function wholeOrigin(expression: Expression, tail: readonly string[]): SpliceOrigin {
  const of = unwrapped(expression);
  return { of, keys: [], tail, references: middlewareLiteralOwners(of) };
}
