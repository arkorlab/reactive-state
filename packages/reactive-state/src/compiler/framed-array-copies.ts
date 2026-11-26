import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { flattenedArrayViews } from './framed-array-flatten.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { splicedArrayViews } from './framed-array-spliced.ts';
import { arrayMethodMayBeOverridden } from './framed-arrays.ts';
import { frameMemberName } from './framed-bindings.ts';
import { concatQuietArguments } from './framed-concat-properties.ts';
import { framedConcatSegment } from './framed-concat-spreads.ts';
import { filteredArrayViews } from './framed-filter-results.ts';
import { expandedFlatViews } from './framed-flat-depth-results.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { removedArrayViews } from './framed-splice-results.ts';
import { constantValue } from './numbers.ts';

/** Native shallow copies retain source element identity before a later numeric selection. */

const COPIES = new Set([
  'concat',
  'filter',
  'flat',
  'slice',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'with',
]);
const COPY_WRAPPER = { reflect: 3 } as const;

interface CopyCall {
  readonly call: CallExpression;
  readonly wrapperTail: readonly Expression[];
  readonly receiver: Expression;
  readonly method: string;
  readonly given: readonly Expression[];
  readonly borrowed: boolean;
  readonly unknownArguments?: boolean;
}

/**
 * Known array-copy methods preserve selected source slots and their copy-time mutation boundary.
 * `stable` proves a receiver unchanged at the copy; `proven`, for concat's quiet slots, whose proof an
 * exposure drops, may count fewer earlier uses. A method that the file may give an array of its own
 * is read as the language's here: a reader of the answer asks `arrayCopyMayBeOverridden` first.
 */
export function arrayCopyViews(
  call: CallExpression,
  index: number | undefined,
  proven: (receiver: Expression) => boolean,
  stable: (receiver: Expression) => boolean = proven,
): readonly ArrayElementView[] | undefined {
  const selected = copyCall(call);
  if (selected === undefined) return undefined;
  if (!selected.borrowed && sourceArrayFunction(call.expression)) return undefined;
  if (selected.method === 'toSpliced') return nativeSplicedViews(call, selected, index, stable);
  if (selected.method === 'splice')
    return (
      removedArrayViews(selected, index, stable) ?? [
        { value: selected.receiver, index: undefined },
        { value: selected.receiver, index: undefined, typeOnly: true },
      ]
    );
  if (selected.method === 'flat')
    return (
      expandedFlatViews(selected, index, stable) ??
      flattenedArrayViews(selected.receiver, index, flatDepth(selected.given[0]), {
        stable,
        capture: call,
      })
    );
  const at = index !== undefined && index < 0 ? undefined : index;
  const position = stable(selected.receiver) ? at : undefined;
  const views = nativeCopies(selected, position, stable, proven);
  return views.map((view) => ({ ...view, capture: call }));
}

/**
 * Whether the call is a native array copy named at an array the file may give a method of that name
 * of its own: what it answers is then no copy of the array's slots, and a reader of the answer
 * refuses. A borrowed call runs the native method whatever the array holds.
 */
export function arrayCopyMayBeOverridden(call: CallExpression): boolean {
  const selected = copyCall(call);
  return (
    selected !== undefined &&
    !selected.borrowed &&
    arrayMethodMayBeOverridden(call, selected.method)
  );
}

/** A complete quiet argument list lets native toSpliced map each retained and inserted result. */
function nativeSplicedViews(
  call: CallExpression,
  selected: CopyCall,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
): readonly ArrayElementView[] | undefined {
  if (selected.unknownArguments === true) return undefined;
  const args = framedArgumentPrefix(call, selected.given, Infinity);
  if (args.unknown) return undefined;
  const stableReceiver = stable(selected.receiver);
  const views = splicedArrayViews(selected.receiver, args.values, index, stableReceiver);
  return views.map((view) => ({ ...view, capture: call }));
}

/** Direct and known borrowed methods share receiver semantics; borrowed calls ignore own overrides. */
function copyCall(call: CallExpression): CopyCall | undefined {
  const borrowed = borrowedTextCall(call);
  if (borrowed?.path.slice(0, -1).join('.') === 'Array.prototype') {
    const method = borrowed.path.at(-1) ?? '';
    if (!COPIES.has(method)) return undefined;
    const given =
      borrowed.applied === undefined
        ? borrowed.given
        : framedAppliedArguments(call, borrowed.applied);
    return {
      call,
      wrapperTail: copyWrapperTail(call),
      receiver: borrowed.receiver,
      method,
      given: given ?? [],
      borrowed: true,
      unknownArguments: given === undefined,
    };
  }
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = frameMemberName(member);
  return method !== undefined && COPIES.has(method)
    ? {
        call,
        wrapperTail: [],
        receiver: member.expression,
        method,
        given: call.arguments,
        borrowed: false,
      }
    : undefined;
}

/** Ignored apply wrapper arguments still run before the native target copies its slots. */
function copyWrapperTail(call: CallExpression): readonly Expression[] {
  const member = unwrapped(call.expression);
  if (globalPathOf(member)?.join('.') === 'Reflect.apply')
    return call.arguments.slice(COPY_WRAPPER.reflect);
  return (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === 'apply'
    ? call.arguments.slice(2)
    : [];
}

/** Each supported native copy either preserves a range or replaces selected positions explicitly. */
function nativeCopies(
  copy: CopyCall,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
  proven: (receiver: Expression) => boolean,
): readonly ArrayElementView[] {
  const base = { value: copy.receiver, index };
  switch (copy.method) {
    case 'slice': {
      return sliced(copy.receiver, copy.given, index);
    }
    case 'concat': {
      return nativeConcatenated(copy, index, proven);
    }
    case 'filter': {
      return filteredArrayViews(copy, index, stable);
    }
    case 'toReversed': {
      const length = literalLength(copy.receiver);
      if (length !== undefined && index !== undefined && index >= length) return [];
      return [
        {
          ...base,
          index: index === undefined || length === undefined ? undefined : length - 1 - index,
        },
      ];
    }
    case 'with': {
      return replaced(copy, index);
    }
    default: {
      return [{ ...base, index: undefined }];
    }
  }
}

/** Literal lengths constrain offsets only when no spread can change the position count. */
function literalLength(value: Expression): number | undefined {
  const array = unwrapped(value);
  return isArrayLiteralExpression(array) && !array.elements.some((each) => isSpreadElement(each))
    ? array.elements.length
    : undefined;
}

/** Written primitive numbers supply copy bounds without executing application conversions. */
function bound(value: Expression | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  const constant = constantValue(unwrapped(value));
  return constant === undefined ? undefined : Math.trunc(Number(constant)) || 0;
}

/** Known slice bounds exclude untouched prefixes and suffixes while opaque offsets retain all elements. */
function sliced(
  receiver: Expression,
  given: readonly Expression[],
  index: number | undefined,
): readonly ArrayElementView[] {
  const length = literalLength(receiver);
  let start = bound(given[0], 0);
  let end = bound(given[1], length);
  if (start !== undefined && start < 0)
    start = length === undefined ? undefined : Math.max(length + start, 0);
  if (end !== undefined && end < 0)
    end = length === undefined ? undefined : Math.max(length + end, 0);
  return [
    {
      value: receiver,
      index: start === undefined || index === undefined ? undefined : start + index,
      start,
      end,
    },
  ];
}

/**
 * All evaluated arguments must keep an earlier array-like source unchanged before native copying;
 * source-known argument spreads expand first, an unresolved one keeping the written list.
 */
function nativeConcatenated(
  copy: CopyCall,
  index: number | undefined,
  stable: (value: Expression) => boolean,
): readonly ArrayElementView[] {
  const args = framedArgumentPrefix(copy.call, copy.given, Infinity);
  const given = args.unknown || args.alternatives !== undefined ? copy.given : args.values;
  const quiet =
    copy.unknownArguments !== true &&
    concatQuietArguments([copy.receiver, ...given, ...copy.wrapperTail], stable);
  return concatenated({ ...copy, given }, index, (value) => quiet && stable(value));
}

/** A literal concatenation keeps its runtime segment boundaries; unknown lengths keep every segment. */
function concatenated(
  copy: CopyCall,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
): readonly ArrayElementView[] {
  const sources = [
    { value: copy.receiver, receiver: true },
    ...copy.given.map((value) => ({ value, receiver: false })),
  ];
  const views: ArrayElementView[] = [];
  let position = index;
  for (const source of sources) {
    const { value } = source;
    const segment = concatSourceViews(value, source.receiver, position, {
      stable,
      capture: copy.call,
    });
    const { length } = segment;
    if (position !== undefined && length !== undefined && position >= length) {
      position -= length;
      continue;
    }
    views.push(...segment.views);
    if (position !== undefined && length !== undefined) break;
    position = undefined;
  }
  return views;
}

/** A known array-like hook adds its slots; other sources retain the existing native array fallback. */
function concatSourceViews(
  value: Expression,
  receiver: boolean,
  index: number | undefined,
  context: { readonly stable: (value: Expression) => boolean; readonly capture: CallExpression },
): { readonly length: number | undefined; readonly views: readonly ArrayElementView[] } {
  const spread = framedConcatSegment(value, index, context.stable, context.capture);
  if (spread !== undefined) return spread;
  const length = literalLength(value);
  const views: ArrayElementView[] = [{ value, index: length === undefined ? undefined : index }];
  if (!receiver && !isArrayLiteralExpression(unwrapped(value)))
    views.push({ value, index: undefined, element: true });
  return { length, views };
}

/** Array.with replaces exactly one known slot; unknown positions preserve source and replacement. */
function replaced(copy: CopyCall, index: number | undefined): readonly ArrayElementView[] {
  const args = framedArgumentPrefix(copy.call, copy.given, 2);
  const replacements = replacementViews(copy, args);
  const length = literalLength(copy.receiver);
  let position = args.alternatives === undefined ? bound(args.values[0], undefined) : undefined;
  if (position !== undefined && position < 0)
    position = length === undefined ? undefined : length + position;
  const source = { value: copy.receiver, index };
  if (
    replacements.length === 0 &&
    (args.unknown || args.alternatives !== undefined || copy.unknownArguments === true)
  )
    return [source];
  if (position !== undefined && index !== undefined && position !== index) return [source];
  return position !== undefined && index === position ? replacements : [source, ...replacements];
}

/** The written replacement after spreads expand, or each value an unresolved spread may supply. */
function replacementViews(
  copy: CopyCall,
  args: ReturnType<typeof framedArgumentPrefix>,
): readonly ArrayElementView[] {
  const replacement = args.values[1];
  if (replacement !== undefined) return [{ value: replacement, index: undefined, element: true }];
  if (!args.unknown) return [];
  return copy.given.flatMap((each) =>
    isSpreadElement(each) ? [{ value: each.expression, index: undefined }] : [],
  );
}

/** Omitted depth is one; fixed primitive numeric conversions retain zero and unbounded depths. */
function flatDepth(argument: Expression | undefined): number {
  if (argument === undefined) return 1;
  const value = unwrapped(argument);
  if (globalPathOf(value)?.join('.') === 'undefined') return 1;
  if (value.kind === SyntaxKind.NullKeyword || value.kind === SyntaxKind.FalseKeyword) return 0;
  if (value.kind === SyntaxKind.TrueKeyword) return 1;
  const fixed = constantValue(value);
  return fixed === undefined ? Infinity : Math.max(Math.trunc(Number(fixed)) || 0, 0);
}
