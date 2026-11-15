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
  const { call, keys, method, receiver, given, applied, source, index, relative } = input;
  if (method === 'toSpliced') {
    const spliced = middlewareArraySplice(
      { call, keys, receiver, given, applied, length: source.elements.length, relative },
      bounds,
    );
    return spliced.length === 1 ? spliced[0] : undefined;
  }
  const tail = keys.slice(1);
  if (!middlewareStableCopy(call, receiver, given)) return wholeSliceOrigin(receiver, index, tail);
  if (method !== 'slice') return reorderedSliceOrigin(input, tail);
  const prefix = given === undefined ? undefined : framedArgumentPrefix(call, given, 2);
  const definite = prefix !== undefined && !prefix.unknown && prefix.alternatives === undefined;
  const start = definite ? bounds.start(prefix.values[0], source.elements.length, 0) : undefined;
  const end = definite
    ? bounds.start(prefix.values[1], source.elements.length, source.elements.length)
    : undefined;
  if (start === undefined || end === undefined)
    return unknownSliceOrigin(receiver, source, index, { relative, tail });
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

/** Unstable copy arguments or receivers retain the whole original array without a negative slot. */
function wholeSliceOrigin(
  receiver: Expression,
  index: number,
  tail: readonly string[],
): SliceProjection {
  const base = { of: receiver, keys: [], tail };
  return index < 0 ? base : { ...base, slot: String(index) };
}

/** Opaque bounds on a stable literal retain the receiver whenever a non-hole slot can fit. */
function unknownSliceOrigin(
  receiver: Expression,
  source: ArrayLiteralExpression,
  index: number,
  options: { readonly relative: boolean; readonly tail: readonly string[] },
): SliceProjection | undefined {
  const length = source.elements.length;
  const inRange = index >= 0 ? index < length : options.relative && length + index >= 0;
  if (!inRange || source.elements.every((element) => knownScalarElement(element))) return undefined;
  return wholeSliceOrigin(receiver, index, options.tail);
}

/** Reversal fixes its copied position; sorting retains the original array without assuming order. */
function reorderedSliceOrigin(
  input: SliceCopyInput,
  tail: readonly string[],
): SliceProjection | undefined {
  const { method, receiver, source, index, relative } = input;
  const length = source.elements.length;
  const offset = relative && index < 0 ? length + index : index;
  if (offset < 0 || offset >= length) return undefined;
  if (method === 'toSorted')
    return source.elements.every((element) => knownScalarElement(element))
      ? undefined
      : { of: receiver, keys: [], tail, slot: String(offset) };
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
): readonly MiddlewareCopyOrigin[] {
  const { receiver, keys, length, relative } = input;
  const { start, removed, inserted } = window;
  const tail = keys.slice(1);
  const copiedLength = length - removed + inserted.length;
  const offset = relative && index < 0 ? copiedLength + index : index;
  if (offset < 0 || offset >= copiedLength) return [];
  const slot = String(offset);
  if (offset >= start && offset < start + inserted.length) {
    const value = inserted[offset - start];
    return value === undefined ? [] : [{ ...middlewareElementOrigin(value, tail), slot }];
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
