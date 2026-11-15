import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { arrayCopyViews } from './framed-array-copies.ts';
import { arrayProjectedViews } from './framed-array-projections.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { concatQuietArguments, concatSource } from './framed-concat-properties.ts';
import { framedConcatSegment } from './framed-concat-spreads.ts';
import { framedArgumentPrefix } from './framed-keys.ts';

/** Existing native copy proofs retain all possible original runtime payload nodes. */

interface CopyCall {
  readonly receiver: Expression;
  readonly method: string;
  readonly given: readonly Expression[] | undefined;
}

interface Origin {
  readonly of: Expression;
  readonly keys: readonly string[];
  readonly tail: readonly string[];
  readonly slot?: string;
  readonly references: readonly Identifier[];
  readonly originalView: ArrayElementView;
}

interface Segment {
  readonly length: number | undefined;
  readonly views: readonly ArrayElementView[];
}

const WRAPPER = { reflect: 3 } as const;

/** Native copies use the original source view; unsupported annotation-only views add no runtime proof. */
export function middlewareCopyOrigins(
  call: CallExpression,
  keys: readonly string[],
  selected: CopyCall,
  relative: boolean,
): readonly Origin[] {
  const key = keys[0];
  const index = key === undefined ? undefined : Number(key);
  if (
    index === undefined ||
    String(index) !== key ||
    !Number.isSafeInteger(index) ||
    (!relative && index < 0)
  )
    return [];
  const copied =
    selected.method === 'concat' ? concatenatedViews(call, selected, index) : undefined;
  const views =
    copied?.views ??
    arrayProjectedViews(call, index, stableSource) ??
    arrayCopyViews(call, index, stableSource);
  const slot = copied === undefined ? fixedCopySlot(selected, index) : copied.slot;
  if (views === undefined) return [];
  return views.flatMap((view) => {
    if (
      view.typeOnly === true ||
      view.packedRest !== undefined ||
      view.start !== undefined ||
      view.end !== undefined
    )
      return [];
    const tail = keys.slice(1);
    const projected = originKeys(view, tail);
    const origin = {
      of: view.value,
      keys: projected,
      tail,
      references: literalOwners(view.value),
      originalView: view,
    };
    return slot === undefined ? [origin] : [{ ...origin, slot }];
  });
}

/** Exact runtime elements keep their own keys; unknown array positions retain their whole source. */
function originKeys(view: ArrayElementView, tail: readonly string[]): readonly string[] {
  if (view.element === true) return [...(view.keys ?? []), ...tail];
  return view.index === undefined || view.index < 0
    ? []
    : [String(view.index), ...(view.keys ?? []), ...tail];
}

/** Length-preserving native copies retain the normalized fresh-wrapper slot for negative at. */
function fixedCopySlot(selected: CopyCall, index: number): string | undefined {
  if (index >= 0) return String(index);
  if (selected.method !== 'map' && selected.method !== 'with') return undefined;
  const source = concatSource(selected.receiver, stableSource);
  if (
    source === undefined ||
    !isArrayLiteralExpression(source) ||
    source.elements.some((value) => isSpreadElement(value))
  )
    return undefined;
  const position = source.elements.length + index;
  return position < 0 ? undefined : String(position);
}

/** Original literal descendants retain their lexical collection owner, stopping at callable creation. */
function literalOwners(value: Expression): readonly Identifier[] {
  let within: Node = value;
  for (let node: Node = value.parent; !isSourceFile(node); within = node, node = node.parent) {
    if (isAnswering(node)) return [];
    if (isVariableDeclaration(node) && isExpression(within) && node.initializer === within)
      return isIdentifier(node.name) ? [node.name] : [];
  }
  return [];
}

/** Original whole-array stability is the same exposure proof used by the shared native copy readers. */
function stableSource(expression: Expression, at: Expression = expression): boolean {
  let value = unwrapped(expression);
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
      return false;
    aliases.add(selected.binding);
    if (selected.binding.initializer === undefined) return false;
    value = unwrapped(selected.binding.initializer);
  }
  return !argumentArrayExposed(at, aliases);
}

/** Quiet known concat segments retain alias lengths without materializing or synthesizing an array. */
function concatenatedViews(
  call: CallExpression,
  selected: CopyCall,
  index: number,
): { readonly views: readonly ArrayElementView[]; readonly slot: string | undefined } {
  const prefix =
    selected.given === undefined ? undefined : framedArgumentPrefix(call, selected.given, Infinity);
  const given =
    prefix === undefined || prefix.unknown || prefix.alternatives !== undefined
      ? (selected.given ?? [])
      : prefix.values;
  const sources = [selected.receiver, ...given];
  const quiet =
    selected.given !== undefined &&
    concatQuietArguments([...sources, ...wrapperTail(call)], stableSource);
  const stable = (value: Expression) => quiet && stableSource(value);
  const lengths = sources.map((value) => concatSegment(value, undefined, call, stable).length);
  const total = totalLength(lengths);
  let position = copiedPosition(index, total);
  if (position !== undefined && position < 0) return { views: [], slot: undefined };
  const slot = position === undefined ? undefined : String(position);
  const views: ArrayElementView[] = [];
  for (const value of sources) {
    const segment = concatSegment(value, position, call, stable);
    if (position !== undefined && segment.length !== undefined && position >= segment.length) {
      position -= segment.length;
      continue;
    }
    views.push(...segment.views);
    if (position !== undefined && segment.length !== undefined) break;
    position = undefined;
  }
  return { views, slot };
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
  value: Expression,
  index: number | undefined,
  capture: CallExpression,
  stable: (value: Expression) => boolean,
): Segment {
  const spread = framedConcatSegment(value, index, stable, capture);
  if (spread !== undefined) return spread;
  const source = concatSource(value, stable);
  if (source === undefined)
    return { length: undefined, views: [{ value, index: undefined, capture }] };
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

/** Ignored native wrapper tails remain evaluated before the copy reads its original segments. */
function wrapperTail(call: CallExpression): readonly Expression[] {
  const member = unwrapped(call.expression);
  if (globalPathOf(member)?.join('.') === 'Reflect.apply')
    return call.arguments.slice(WRAPPER.reflect);
  return (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === 'apply'
    ? call.arguments.slice(2)
    : [];
}
