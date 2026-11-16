import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { arrayCopyViews } from './framed-array-copies.ts';
import { arrayProjectedViews } from './framed-array-projections.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { concatQuietArguments, concatSource } from './framed-concat-properties.ts';
import { framedConcatSegment } from './framed-concat-spreads.ts';
import { flatArgumentDepths } from './framed-flat-depth-arguments.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import {
  middlewareCopyArgumentsQuiet,
  type MiddlewareCopyOrigin,
  middlewareInsertedOrigins,
  middlewareLiteralOwners,
  middlewareSpreadCandidates,
  middlewareStableSource,
  middlewareWholeOrigin,
  middlewareWrapperTail,
} from './middleware-array-copy-arguments.ts';

/** Existing native copy proofs retain all possible original runtime payload nodes. */

interface CopyCall {
  readonly receiver: Expression;
  readonly method: string;
  readonly given: readonly Expression[] | undefined;
  readonly applied?: Expression | undefined;
  readonly stableLength?: ((length: number) => boolean) | undefined;
}

interface SlotSelection {
  readonly slot: string | undefined;
  readonly viewIndex: number | undefined;
  readonly wrapperLength: number | undefined;
}

interface Segment {
  readonly length: number | undefined;
  readonly views: readonly ArrayElementView[];
}

interface ConcatEntry {
  readonly value: Expression;
  readonly kind: 'receiver' | 'argument' | 'spread';
}

/** Native copies use the original source view; unsupported annotation-only views add no runtime proof. */
export function middlewareCopyOrigins(
  call: CallExpression,
  keys: readonly string[],
  selected: CopyCall,
  relative: boolean,
): readonly MiddlewareCopyOrigin[] {
  const key = keys[0];
  const index = key === undefined ? undefined : Number(key);
  if (
    index === undefined ||
    String(index) !== key ||
    !Number.isSafeInteger(index) ||
    (!relative && index < 0)
  )
    return [];
  if (selected.method === 'with' && unresolvedArguments(call, selected.given))
    return unknownWithOrigins(call, keys, selected, index);
  const quiet =
    middlewareCopyArgumentsQuiet(call, selected.given) && quietFlatDepth(call, selected);
  const stable = (value: Expression) => quiet && middlewareStableSource(value);
  const copied =
    selected.method === 'concat'
      ? concatenatedViews(call, selected, index, keys.length > 1)
      : undefined;
  const selection =
    copied === undefined
      ? copySlotSelection(selected, index, stable)
      : { slot: copied.slot, viewIndex: index, wrapperLength: copied.wrapperLength };
  const views =
    copied?.views ??
    arrayProjectedViews(call, selection.viewIndex, stable) ??
    arrayCopyViews(call, selection.viewIndex, stable);
  if (views === undefined) return [];
  return views.flatMap((view) =>
    projectedViewOrigins(view, keys.slice(1), selection.slot, selection.wrapperLength),
  );
}

/** Annotation-only or sliced views add no runtime proof; valid views keep literal collection owners. */
function projectedViewOrigins(
  view: ArrayElementView,
  tail: readonly string[],
  slot: string | undefined,
  wrapperLength: number | undefined,
): readonly MiddlewareCopyOrigin[] {
  if (
    view.typeOnly === true ||
    view.packedRest !== undefined ||
    view.start !== undefined ||
    view.end !== undefined
  )
    return [];
  return [
    {
      of: view.value,
      keys: originKeys(view, tail),
      tail,
      slot,
      wrapperLength,
      references: middlewareLiteralOwners(view.value),
    },
  ];
}

/** Exact runtime elements keep their own keys; unknown array positions retain their whole source. */
function originKeys(view: ArrayElementView, tail: readonly string[]): readonly string[] {
  if (view.element === true) return [...(view.keys ?? []), ...tail];
  return view.index === undefined || view.index < 0
    ? []
    : [String(view.index), ...(view.keys ?? []), ...tail];
}

/** Length-preserving native copies normalize negative at only while the wrapper length stays fixed. */
function copySlotSelection(
  selected: CopyCall,
  index: number,
  stable: (value: Expression) => boolean,
): SlotSelection {
  if (index >= 0) return { slot: String(index), viewIndex: index, wrapperLength: undefined };
  const length = knownCopyLength(selected, stable);
  if (selected.stableLength !== undefined && !selected.stableLength(length ?? 0))
    return { slot: undefined, viewIndex: undefined, wrapperLength: undefined };
  if (length === undefined || length + index < 0)
    return { slot: undefined, viewIndex: index, wrapperLength: undefined };
  return { slot: String(length + index), viewIndex: index, wrapperLength: length };
}

/** Spread-free literal receivers give map and with a known creation-time wrapper length. */
function knownCopyLength(
  selected: CopyCall,
  stable: (value: Expression) => boolean,
): number | undefined {
  if (selected.method !== 'map' && selected.method !== 'with') return undefined;
  const source = concatSource(selected.receiver, stable);
  return source === undefined ||
    !isArrayLiteralExpression(source) ||
    source.elements.some((value) => isSpreadElement(value))
    ? undefined
    : source.elements.length;
}

/** Unresolved spreads or borrowed apply tuples on Array.with retain the receiver and replacements. */
function unknownWithOrigins(
  call: CallExpression,
  keys: readonly string[],
  selected: CopyCall,
  index: number,
): readonly MiddlewareCopyOrigin[] {
  const tail = keys.slice(1);
  const slot = index < 0 ? undefined : String(index);
  const origins = [
    middlewareWholeOrigin(selected.receiver, tail),
    ...middlewareInsertedOrigins(
      { call, given: selected.given, applied: selected.applied, tail },
      'with',
    ),
  ];
  return slot === undefined ? origins : origins.map((origin) => ({ ...origin, slot }));
}

/** Whether a call's argument list contains an unresolved spread or mutated borrowed apply tuple. */
function unresolvedArguments(
  call: CallExpression,
  given: readonly Expression[] | undefined,
): boolean {
  if (given === undefined) return true;
  const prefix = framedArgumentPrefix(call, given, Infinity);
  return prefix.unknown || prefix.alternatives !== undefined;
}

/** An untyped or computed flat depth may evaluate to zero or run conversion hooks before copying. */
function quietFlatDepth(call: CallExpression, selected: CopyCall): boolean {
  if (selected.method !== 'flat' || selected.given === undefined) return true;
  const prefix = framedArgumentPrefix(call, selected.given, 1);
  return (
    !prefix.unknown &&
    prefix.alternatives === undefined &&
    flatArgumentDepths(prefix.values[0]) !== undefined
  );
}

/** Quiet known concat segments retain alias lengths without materializing or synthesizing an array. */
function concatenatedViews(
  call: CallExpression,
  selected: CopyCall,
  index: number,
  hasTail: boolean,
): {
  readonly views: readonly ArrayElementView[];
  readonly slot: string | undefined;
  readonly wrapperLength: number | undefined;
} {
  const { entries, exact } = concatEntries(call, selected);
  const quiet =
    exact &&
    concatQuietArguments(
      [...entries.map((entry) => entry.value), ...middlewareWrapperTail(call)],
      middlewareStableSource,
    );
  const stable = (value: Expression) => quiet && middlewareStableSource(value);
  const lengths = entries.map(
    (entry) => concatSegment(entry, undefined, { call, hasTail, stable }).length,
  );
  const total = stableConcatLength(totalLength(lengths), index, selected.stableLength);
  let position = copiedPosition(index, total);
  if (position !== undefined && position < 0)
    return { views: [], slot: undefined, wrapperLength: undefined };
  const slot = position === undefined ? undefined : String(position);
  const wrapperLength = index < 0 ? total : undefined;
  const views: ArrayElementView[] = [];
  for (const entry of entries) {
    const segment = concatSegment(entry, position, { call, hasTail, stable });
    if (position !== undefined && segment.length !== undefined && position >= segment.length) {
      position -= segment.length;
      continue;
    }
    views.push(...segment.views);
    if (position !== undefined && segment.length !== undefined) break;
    position = undefined;
  }
  return { views, slot, wrapperLength };
}

/** Drops concat total-length normalization when negative indexing observes a grown wrapper. */
function stableConcatLength(
  total: number | undefined,
  index: number,
  stableLength: ((length: number) => boolean) | undefined,
): number | undefined {
  if (total === undefined || stableLength === undefined || index >= 0) return total;
  return stableLength(total) ? total : undefined;
}

/** Expands known concat argument spreads while keeping opaque spread containers and apply tuples. */
function concatEntries(
  call: CallExpression,
  selected: CopyCall,
): { readonly entries: readonly ConcatEntry[]; readonly exact: boolean } {
  const head: ConcatEntry = { value: selected.receiver, kind: 'receiver' };
  if (selected.given === undefined) {
    const spread = selected.applied === undefined ? [] : spreadConcatEntries(selected.applied);
    return { entries: [head, ...spread], exact: false };
  }
  const prefix = framedArgumentPrefix(call, selected.given, Infinity);
  if (!prefix.unknown && prefix.alternatives === undefined) {
    const entries = prefix.values.map((value): ConcatEntry => ({ value, kind: 'argument' }));
    return { entries: [head, ...entries], exact: true };
  }
  return { entries: [head, ...mixedConcatEntries(call, selected.given)], exact: false };
}

/** Mixed concat argument lists expand constant spreads individually without dropping later spreads. */
function mixedConcatEntries(
  call: CallExpression,
  given: readonly Expression[],
): readonly ConcatEntry[] {
  const entries: ConcatEntry[] = [];
  for (const argument of given) {
    if (!isSpreadElement(argument)) {
      entries.push({ value: argument, kind: 'argument' });
      continue;
    }
    const expanded = framedArgumentPrefix(call, [argument], Infinity);
    if (!expanded.unknown && expanded.alternatives === undefined) {
      for (const value of expanded.values) entries.push({ value, kind: 'argument' });
      continue;
    }
    entries.push(...spreadConcatEntries(argument.expression));
  }
  return entries;
}

/** Literal spread elements become concat arguments; opaque spread sources stay whole containers. */
function spreadConcatEntries(expression: Expression): readonly ConcatEntry[] {
  return middlewareSpreadCandidates(expression).map((candidate) => {
    return {
      value: candidate.value,
      kind: candidate.element ? 'argument' : 'spread',
    };
  });
}

/** Only wholly known original segment lengths establish the final native negative position. */
function totalLength(lengths: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  for (const length of lengths) {
    if (length === undefined) return undefined;
    total += length;
  }
  return total;
}

/** A negative native at index is relative to the entire copied wrapper when that length is known. */
function copiedPosition(index: number, length: number | undefined): number | undefined {
  if (index >= 0) return index;
  return length === undefined ? undefined : length + index;
}

/** Source-known Symbol.isConcatSpreadable metadata keeps the existing native segment proof. */
function concatSegment(
  entry: ConcatEntry,
  index: number | undefined,
  context: {
    readonly call: CallExpression;
    readonly hasTail: boolean;
    readonly stable: (value: Expression) => boolean;
  },
): Segment {
  const { value, kind } = entry;
  const { call: capture, hasTail, stable } = context;
  if (kind === 'spread')
    return { length: undefined, views: [{ value, index: undefined, capture }] };
  const spread = framedConcatSegment(value, index, stable, capture);
  if (spread !== undefined) return spread;
  const source = concatSource(value, stable);
  if (source === undefined) return unknownConcatSegment(value, kind, capture, hasTail);
  if (isArrayLiteralExpression(source)) {
    if (source.elements.some((element) => isSpreadElement(element)))
      return { length: undefined, views: [{ value, index: undefined, capture }] };
    return {
      length: source.elements.length,
      views:
        index === undefined || index < source.elements.length ? [{ value, index, capture }] : [],
    };
  }
  return {
    length: 1,
    views:
      index === undefined || index === 0
        ? [{ value, index: undefined, capture, element: true }]
        : [],
  };
}

/** An unresolved concat argument may either spread its elements or stand as a single object slot. */
function unknownConcatSegment(
  value: Expression,
  kind: 'receiver' | 'argument',
  capture: CallExpression,
  hasTail: boolean,
): Segment {
  const views: ArrayElementView[] = [{ value, index: undefined, capture }];
  if (kind === 'argument' && hasTail && !isArrayLiteralExpression(unwrapped(value)))
    views.push({ value, index: undefined, capture, element: true });
  return { length: undefined, views };
}
