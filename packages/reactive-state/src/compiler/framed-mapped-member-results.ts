import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { selectedError } from './framed-array-selections.ts';
import { arrayMethodMayBeOverridden } from './framed-arrays.ts';
import { frameMemberName } from './framed-bindings.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { quietMapperFunction } from './framed-mapper-quiet.ts';
import { mapperMemberSlots, mapperSlotValues } from './framed-mapper-slots.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';

/** An immediately selected native mapper holder retains its own literal data member path. */

const INDEX = /^(?:0|[1-9]\d*)$/u;

interface Selection {
  readonly call: CallExpression;
  readonly index: number;
  readonly keys: readonly string[];
}

interface Mapping {
  readonly roots: readonly Expression[];
  readonly call: CallExpression;
  /** The file may give an array a method of this name of its own: what it answers is not read. */
  readonly overridden: boolean;
}

/** Only a quiet mapper and a literal own-data path add an Error beyond the selected array slot. */
export function framedMappedMemberResult(
  node: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean {
  if (!quietObservation(node)) return false;
  const selected = selectionOf(node, keys);
  if (selected === undefined) return false;
  const mapping = quietMapping(selected.call);
  if (mapping === undefined) return false;
  if (mapping.overridden) return true;
  return selectedError(
    selected.call,
    selected.index,
    {
      error: (value, path = []) =>
        ownMemberError(value, [...path, ...selected.keys], mapping, error),
      typed: () => false,
    },
    node,
  );
}

/** Literal computed names perform no application evaluation between the holder and its observation. */
function quietMemberName(node: Expression): string | undefined {
  if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) return undefined;
  return isElementAccessExpression(node) && framedMapKey(node.argumentExpression) === undefined
    ? undefined
    : frameMemberName(node);
}

/** A direct member observation adds no new general text-consumer or saved-result proof. */
function quietObservation(node: Expression): boolean {
  let { at, parent } = useOf(node);
  let found = false;
  while (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  ) {
    if (quietMemberName(parent) === undefined) return false;
    found = true;
    ({ at, parent } = useOf(parent));
  }
  return found;
}

/** A fixed output index followed by written literal names retains those names in their original scope. */
function selectionOf(node: Expression, keys: readonly string[]): Selection | undefined {
  let value = unwrapped(node);
  const path = [...keys];
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = quietMemberName(value);
    if (key === undefined) return undefined;
    path.unshift(key);
    value = unwrapped(value.expression);
  }
  const [index, ...selected] = path;
  return index !== undefined && selected.length > 0 && isCallExpression(value) && INDEX.test(index)
    ? { call: value, index: Number(index), keys: selected }
    : undefined;
}

/** Existing mapper guards prove all original operands, defaults, callback work and owner prefix quiet. */
function quietMapping(call: CallExpression): Mapping | undefined {
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const name = quietMemberName(member);
  if (name !== 'map' && name !== 'flatMap') return undefined;
  const source = framedQuietSource(member.expression, false);
  if (source === undefined || !isArrayLiteralExpression(source)) return undefined;
  if (arrayMethodMayBeOverridden(call, name)) return { call, roots: [], overridden: true };
  const args = framedArgumentPrefix(call, call.arguments, Infinity);
  const callback = args.values[0];
  if (callback === undefined || args.unknown || args.alternatives !== undefined) return undefined;
  const fn = framedQuietSource(callback, false);
  return fn !== undefined &&
    (isArrowFunction(fn) || isFunctionExpression(fn)) &&
    quietMapperFunction(fn, call, source, { evaluated: args.values })
    ? { call, roots: [source, ...call.arguments], overridden: false }
    : undefined;
}

/** Only selected own literal data, co-owned and unexposed at the original call, adds an origin. */
function ownMemberError(
  value: Expression,
  keys: readonly string[],
  mapping: Mapping,
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean {
  let slots = mapperSlotValues(value);
  for (const key of keys) {
    if (slots.some((slot) => typeof slot === 'string')) return false;
    slots = slots.flatMap((slot) => mapperMemberSlots(slot, key));
  }
  if (slots.some((slot) => typeof slot === 'string')) return false;
  const values = slots.flatMap((slot) => (typeof slot === 'string' ? [] : [slot]));
  return (
    values.every((each) => framedOriginCoowned(each, mapping.call)) &&
    iteratorCarriedUnexposed(
      mapping.roots,
      values.map((each) => ({ value: each })),
      mapping.call,
    ) &&
    values.some((each) => error(each, []))
  );
}
