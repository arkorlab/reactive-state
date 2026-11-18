import { type Expression, isSpreadElement } from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { GLOBAL_OBJECTS, globalPathOf } from './code-globals.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import type { BoundArgCount, TagPath } from './render-raw-tag-calls.ts';
import {
  type ForwardedSlotsResult,
  hasDatedFromIndex,
  isIdentifierForParam,
  isWholeArgumentsReference,
  type RawWrapperQuery,
  type RawWrapperSearch,
  type WrapperBindings,
} from './render-raw-wrapper-bindings.ts';
import {
  type CallArgumentList,
  KIND_ELEMENTS,
  KIND_SPREAD,
  KIND_WHOLE_ARGS,
} from './render-tag-date-call-unpacking.ts';
import { carriesDatedSubstitution } from './render-tag-date-carriers.ts';

/** Maps the dated slots of the calls a tag's body makes, and finds the direct String and raw-String references among them. */

export interface CallSlotContext {
  readonly bindings: WrapperBindings;
  readonly query: RawWrapperQuery;
}

export function carriesDatedExpr(expr: Expression, context: CallSlotContext): boolean {
  return carriesDatedSubstitution(expr, context.bindings, context.query.datedIndices, new Set());
}

export function collectCallArgDatedSlots(
  args: CallArgumentList,
  context: CallSlotContext,
): ForwardedSlotsResult {
  const forwardedSlots = new Set<number>();
  let slot = 0;
  if (args.kind === KIND_SPREAD) {
    slot = appendSpreadCallArgSlots(args.list, 0, forwardedSlots, context);
  } else if (args.kind === KIND_ELEMENTS) {
    for (const arg of args.elements) {
      if (isSpreadElement(arg)) {
        slot = appendSpreadCallArgSlots(arg.expression, slot, forwardedSlots, context);
        continue;
      }
      if (carriesDatedExpr(arg, context)) forwardedSlots.add(slot);
      slot += 1;
    }
  }
  const highest = forwardedSlots.size === 0 ? 0 : Math.max(...forwardedSlots) + 1;
  return { effectiveSpanCount: Math.max(slot, highest), forwardedSlots };
}

function appendSpreadCallArgSlots(
  spreadExpr: Expression,
  slot: number,
  forwardedSlots: Set<number>,
  context: CallSlotContext,
): number {
  const target = unwrapped(spreadExpr);
  const { restSubs } = context.bindings;
  if (restSubs !== undefined && isIdentifierForParam(target, restSubs.param)) {
    for (const datedIndex of context.query.datedIndices) {
      if (datedIndex >= restSubs.startIndex) {
        forwardedSlots.add(slot + (datedIndex - restSubs.startIndex));
      }
    }
    return slot + Math.max(0, context.query.spanCount - restSubs.startIndex);
  }
  if (isWholeArgumentsReference(target, context.bindings)) {
    for (const datedIndex of context.query.datedIndices) {
      forwardedSlots.add(slot + context.bindings.paramOffset + datedIndex);
    }
    return slot + context.bindings.paramOffset + context.query.spanCount;
  }
  if (carriesDatedExpr(target, context)) {
    const limit = slot + Math.max(1, context.query.spanCount);
    for (let idx = slot; idx < limit; idx += 1) forwardedSlots.add(idx);
  }
  return slot + 1;
}

export function anyCallArgCarriesDated(args: CallArgumentList, context: CallSlotContext): boolean {
  if (args.kind === KIND_WHOLE_ARGS) return context.query.datedIndices.size > 0;
  if (args.kind === KIND_SPREAD) return carriesDatedExpr(args.list, context);
  return args.elements.some((arg) => {
    const expr = isSpreadElement(arg) ? arg.expression : arg;
    const target = unwrapped(expr);
    if (isSpreadElement(arg) && isWholeArgumentsReference(target, context.bindings)) {
      return context.query.datedIndices.size > 0;
    }
    return carriesDatedExpr(expr, context);
  });
}

export function callArgSlotCarriesDated(
  args: CallArgumentList,
  targetSlot: number,
  context: CallSlotContext,
): boolean {
  if (args.kind === KIND_WHOLE_ARGS) {
    const offset = context.bindings.paramOffset;
    return targetSlot >= offset && context.query.datedIndices.has(targetSlot - offset);
  }
  if (args.kind === KIND_SPREAD) {
    const collected = collectCallArgDatedSlots(args, context);
    return (
      collected.forwardedSlots.has(targetSlot) ||
      (hasDatedFromIndex(context.query.datedIndices, 0) && carriesDatedExpr(args.list, context))
    );
  }
  return argElementsSlotCarriesDated(args.elements, targetSlot, context);
}

export function argElementsSlotCarriesDated(
  elements: readonly Expression[],
  targetSlot: number,
  context: CallSlotContext,
): boolean {
  const collected = collectCallArgDatedSlots({ elements, kind: KIND_ELEMENTS }, context);
  if (collected.forwardedSlots.has(targetSlot)) return true;
  return elements.some((arg, index) => {
    return (
      index <= targetSlot &&
      isSpreadElement(arg) &&
      hasDatedFromIndex(context.query.datedIndices, 0) &&
      carriesDatedExpr(arg.expression, context)
    );
  });
}

const RAW_TAGS: ReadonlySet<string> = new Set(['String.raw']);
const STRINGS: ReadonlySet<string> = new Set(['String']);

/** Direct native String.raw (tag mode) or String (helper mode) references and global paths. */
export function matchesDirectRawOrStringTag(
  value: Expression,
  suffix: readonly (string | undefined)[],
  search: RawWrapperSearch,
): boolean {
  if (search.paramOffset === 0) return matchesDirectStringConstructor(value, suffix, search);
  if (suffix.length === 0 && framedNativeConstructor(value, RAW_TAGS)) return true;
  const direct = globalPathOf(value);
  return direct !== undefined && matchesNativeRawPath([...direct, ...suffix]);
}

function matchesDirectStringConstructor(
  value: Expression,
  suffix: readonly (string | undefined)[],
  search: RawWrapperSearch,
): boolean {
  if (
    (search.boundArgs !== undefined && search.boundArgs !== 'unknown') ||
    !search.datedIndices.has(0)
  ) {
    return false;
  }
  if (suffix.length === 0 && framedNativeConstructor(value, STRINGS)) return true;
  const direct = globalPathOf(value);
  return direct !== undefined && matchesNativeStringPath([...direct, ...suffix]);
}

function matchesNativeRawPath(parts: readonly (string | undefined)[]): boolean {
  let index = 0;
  while (parts.length - index > 2 && isPossibleGlobalHolder(parts[index])) index += 1;
  while (parts.length - index > 1 && isKnownGlobalHolder(parts[index])) index += 1;
  if (parts.length - index !== 2) return false;
  const holder = parts[index];
  const member = parts[index + 1];
  return (
    (holder === undefined || holder === 'String') && (member === undefined || member === 'raw')
  );
}

function matchesNativeStringPath(parts: readonly (string | undefined)[]): boolean {
  let index = 0;
  while (parts.length - index > 1 && isPossibleGlobalHolder(parts[index])) index += 1;
  if (parts.length - index !== 1) return false;
  const holder = parts[index];
  return holder === undefined || holder === 'String';
}

function isKnownGlobalHolder(name: string | undefined): boolean {
  return name !== undefined && GLOBAL_OBJECTS.has(name);
}

function isPossibleGlobalHolder(name: string | undefined): boolean {
  return name === undefined || GLOBAL_OBJECTS.has(name);
}

export function inheritBoundArgCount(
  pending: TagPath[],
  startIndex: number,
  boundArgs: BoundArgCount | undefined,
): void {
  if (boundArgs === undefined) return;
  for (let index = startIndex; index < pending.length; index += 1) {
    const item = pending[index];
    if (item !== undefined && item.boundArgs === undefined) {
      pending[index] = { ...item, boundArgs };
    }
  }
}
