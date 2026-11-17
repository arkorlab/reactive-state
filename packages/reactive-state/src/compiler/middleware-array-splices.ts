import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isOmittedExpression,
  SyntaxKind,
} from 'typescript/ast';

import { framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import {
  type MiddlewareCopyOrigin,
  middlewareElementOrigin,
  middlewareInsertedOrigins,
  middlewareLiteralOwners,
  middlewareStableCopy,
  middlewareWholeOrigin,
} from './middleware-array-copy-arguments.ts';

/** Native shallow-copy slots retain original payloads or inserted argument nodes while stable. */

interface SpliceInput {
  readonly call: CallExpression;
  readonly keys: readonly string[];
  readonly receiver: Expression;
  readonly given: readonly Expression[] | undefined;
  readonly applied?: Expression | undefined;
  readonly length: number;
  readonly relative: boolean;
  readonly stableLength?: ((length: number) => boolean) | undefined;
}

interface SliceCopyInput {
  readonly call: CallExpression;
  readonly keys: readonly string[];
  readonly method: string;
  readonly receiver: Expression;
  readonly given: readonly Expression[] | undefined;
  readonly applied?: Expression | undefined;
  readonly source: ArrayLiteralExpression;
  readonly index: number;
  readonly relative: boolean;
  readonly stableLength?: ((length: number) => boolean) | undefined;
}

interface NativeBounds {
  readonly start: (
    value: Expression | undefined,
    length: number,
    fallback: number,
  ) => number | undefined;
  readonly count: (value: Expression | undefined) => number | undefined;
}

interface SpliceWindow {
  readonly start: number;
  readonly removed: number;
  readonly inserted: readonly Expression[];
}

export interface SliceProjection {
  readonly of: Expression;
  readonly keys: readonly string[];
  readonly tail: readonly string[];
  readonly slot?: string | undefined;
  readonly whole?: boolean | undefined;
  readonly wrapperLength?: number | undefined;
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
  bounds: NativeBounds,
): SliceProjection | undefined {
  const { call, keys, method, receiver, given, applied, source, index, relative, stableLength } =
    input;
  if (method === 'toSpliced') {
    const spliced = middlewareArraySplice(
      {
        call,
        keys,
        receiver,
        given,
        applied,
        length: source.elements.length,
        relative,
        stableLength,
      },
      bounds,
    );
    return spliced.length === 1 ? spliced[0] : undefined;
  }
  const tail = keys.slice(1);
  if (!middlewareStableCopy(call, receiver, given)) return wholeSliceOrigin(receiver, index, tail);
  if (method !== 'slice') return reorderedSliceOrigin(input, tail);
  const boundsWindow = knownSliceBounds(call, given, source.elements.length, bounds);
  if (boundsWindow === undefined)
    return unknownSliceOrigin(receiver, source, index, { relative, stableLength, tail });
  return fixedSliceWindowOrigin(input, boundsWindow, tail);
}

/** Original argument count distinguishes cloning, suffix removal and explicit undefined deletion. */
export function middlewareArraySplice(
  input: SpliceInput,
  bounds: NativeBounds,
): readonly MiddlewareCopyOrigin[] {
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

/** Resolves finite start and end indices when all slice arguments evaluate quietly without spreads. */
function knownSliceBounds(
  call: CallExpression,
  given: readonly Expression[] | undefined,
  length: number,
  bounds: NativeBounds,
): { readonly start: number; readonly end: number } | undefined {
  if (given === undefined) return undefined;
  const prefix = framedArgumentPrefix(call, given, 2);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  const start = bounds.start(prefix.values[0], length, 0);
  const end = bounds.start(prefix.values[1], length, length);
  return start === undefined || end === undefined ? undefined : { start, end };
}

/** Projects a known slice window while refusing negative normalization across wrapper growth. */
function fixedSliceWindowOrigin(
  input: SliceCopyInput,
  window: { readonly start: number; readonly end: number },
  tail: readonly string[],
): SliceProjection | undefined {
  const { receiver, source, index, relative, stableLength } = input;
  const { start, end } = window;
  const length = Math.max(end - start, 0);
  const relativeNegative = relative && index < 0;
  if (relativeNegative && stableLength !== undefined && !stableLength(length))
    return unstableWindowOrigin(receiver, source.elements.slice(start, end), index, tail);
  const offset = relativeNegative ? length + index : index;
  const position = start + offset;
  const element = source.elements[position];
  if (element === undefined || offset < 0 || offset >= length || isOmittedExpression(element))
    return undefined;
  return {
    of: receiver,
    keys: [String(position), ...tail],
    tail,
    slot: String(offset),
    wrapperLength: relativeNegative ? length : undefined,
  };
}

/** Retains the whole receiver when any candidate element in a slice window is non-scalar. */
function unstableWindowOrigin(
  receiver: Expression,
  elements: readonly Expression[],
  index: number,
  tail: readonly string[],
): SliceProjection | undefined {
  return elements.every((element) => knownScalarElement(element))
    ? undefined
    : wholeSliceOrigin(receiver, index, tail);
}

/** Unstable copy arguments or receivers retain the whole original array without a negative slot. */
function wholeSliceOrigin(
  receiver: Expression,
  index: number,
  tail: readonly string[],
): SliceProjection {
  const base: SliceProjection = { of: receiver, keys: [], tail, whole: true };
  return index < 0 ? base : { ...base, slot: String(index) };
}

/** Opaque bounds on a stable literal retain the receiver whenever a non-hole slot can fit. */
function unknownSliceOrigin(
  receiver: Expression,
  source: ArrayLiteralExpression,
  index: number,
  options: {
    readonly relative: boolean;
    readonly stableLength?: ((length: number) => boolean) | undefined;
    readonly tail: readonly string[];
  },
): SliceProjection | undefined {
  const length = source.elements.length;
  const grown =
    index < 0 && options.relative && options.stableLength !== undefined && !options.stableLength(0);
  const inRange = index >= 0 ? index < length : options.relative && (grown || length + index >= 0);
  return inRange ? unstableWindowOrigin(receiver, source.elements, index, options.tail) : undefined;
}

/** Reversal fixes its copied position; sorting retains the original array without assuming order. */
function reorderedSliceOrigin(
  input: SliceCopyInput,
  tail: readonly string[],
): SliceProjection | undefined {
  const { method, receiver, source, index, relative, stableLength } = input;
  const length = source.elements.length;
  const relativeNegative = relative && index < 0;
  if (relativeNegative && stableLength !== undefined && !stableLength(length))
    return unstableWindowOrigin(receiver, source.elements, index, tail);
  const offset = relativeNegative ? length + index : index;
  if (offset < 0 || offset >= length) return undefined;
  const wrapperLength = relativeNegative ? length : undefined;
  if (method === 'toSorted') {
    return source.elements.every((element) => knownScalarElement(element))
      ? undefined
      : { of: receiver, keys: [], tail, slot: String(offset), whole: true, wrapperLength };
  }
  const position = length - 1 - offset;
  const element = source.elements[position];
  return element === undefined || isOmittedExpression(element)
    ? undefined
    : {
        of: receiver,
        keys: [String(position), ...tail],
        tail,
        slot: String(offset),
        wrapperLength,
      };
}

/** Fixed copied positions distinguish retained slots from the actual inserted payload nodes. */
function selectedSpliceSlot(
  input: SpliceInput,
  index: number,
  window: SpliceWindow,
): readonly MiddlewareCopyOrigin[] {
  const { receiver, keys, length, relative, stableLength } = input;
  const { start, removed, inserted } = window;
  const copiedLength = length - removed + inserted.length;
  const relativeNegative = relative && index < 0;
  if (relativeNegative && stableLength !== undefined && !stableLength(copiedLength))
    return unknownSpliceOrigins(input, index);
  const offset = relativeNegative ? copiedLength + index : index;
  if (offset < 0 || offset >= copiedLength) return [];
  const tail = keys.slice(1);
  const slot = String(offset);
  const wrapperLength = relativeNegative ? copiedLength : undefined;
  if (offset >= start && offset < start + inserted.length)
    return insertedSpliceOrigin(inserted[offset - start], tail, slot, wrapperLength);
  const position = offset < start ? offset : offset - inserted.length + removed;
  return [
    {
      of: receiver,
      keys: [String(position), ...tail],
      tail,
      slot,
      wrapperLength,
      references: middlewareLiteralOwners(receiver),
    },
  ];
}

/** Formats a single inserted splice slot origin when the inserted argument expression exists. */
function insertedSpliceOrigin(
  value: Expression | undefined,
  tail: readonly string[],
  slot: string,
  wrapperLength: number | undefined,
): readonly MiddlewareCopyOrigin[] {
  return value === undefined
    ? []
    : [{ ...middlewareElementOrigin(value, tail), slot, wrapperLength }];
}

/** Opaque bounds, spreads or side-effecting arguments retain receiver and inserted candidates. */
function unknownSpliceOrigins(input: SpliceInput, index: number): readonly MiddlewareCopyOrigin[] {
  const tail = input.keys.slice(1);
  const slot = index < 0 ? undefined : String(index);
  const origins = [
    middlewareWholeOrigin(input.receiver, tail),
    ...middlewareInsertedOrigins(
      { call: input.call, given: input.given, applied: input.applied, tail },
      'splice',
    ),
  ];
  return slot === undefined ? origins : origins.map((origin) => ({ ...origin, slot }));
}

/** Omitted slots and quiet primitive literals hold no mutable object identity on a stable copy. */
function knownScalarElement(element: Expression): boolean {
  return (
    isOmittedExpression(element) ||
    element.kind === SyntaxKind.BigIntLiteral ||
    framedQuietPrimitive(element)
  );
}
