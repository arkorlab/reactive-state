import {
  type CallExpression,
  type Expression,
  isAwaitExpression,
  isCallExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedRaceInput } from './framed-race-values.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/**
 * A finite native race or any of immediately fulfillable inputs retains its first source
 * fulfillment: with no input pending or rejected, both settle with the first input's value.
 */

const PROMISES = new Set(['Promise']);
const SETTLING = new Set(['any', 'race']);

/** Only source-proven immediate fulfillments select a winner without simulating a job queue. */
export function framedRaceResult(
  node: Expression,
  made: boolean,
  keys: readonly string[],
  error: (value: Expression, made: boolean, keys: readonly string[]) => boolean,
): true | undefined {
  const awaited = unwrapped(node);
  if (!isAwaitExpression(awaited) || !immediateMember(awaited)) return undefined;
  const call = unwrapped(awaited.expression);
  if (!isCallExpression(call)) return undefined;
  const method = unwrapped(call.expression);
  if (
    (!isPropertyAccessExpression(method) && !isElementAccessExpression(method)) ||
    !SETTLING.has(frameMemberName(method) ?? '') ||
    !framedNativeConstructor(method.expression, PROMISES)
  )
    return undefined;
  if (!framedOriginPrefix(call)) return undefined;
  const selected = raceSelection(call);
  if (
    selected === undefined ||
    selected.sources.some(({ value }) => !framedOriginCoowned(value, call)) ||
    !iteratorCarriedUnexposed(selected.roots, selected.sources, call)
  )
    return undefined;
  return error(selected.first, made, keys) ? true : undefined;
}

interface RaceSelection {
  readonly first: Expression;
  readonly roots: readonly Expression[];
  readonly sources: readonly { readonly value: Expression }[];
}

/** A complete finite input list selects its first already-fulfilled value in native iteration order. */
function raceSelection(call: CallExpression): RaceSelection | undefined {
  const input = call.arguments[0];
  if (
    input === undefined ||
    isSpreadElement(input) ||
    !iteratorQuietValues(call.arguments.slice(1))
  )
    return undefined;
  const elements = framedAppliedArguments(call, input, false);
  if (elements === undefined) return undefined;
  const prefix = framedArgumentPrefix(call, elements, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  const inputs = prefix.values.map((value) => framedRaceInput(value));
  if (inputs.includes(undefined)) return undefined;
  const sources: { value: Expression }[] = [];
  for (const value of inputs) {
    if (value?.value !== undefined) sources.push({ value: value.value });
  }
  const first = inputs[0]?.value;
  return first === undefined
    ? undefined
    : { first, roots: [...prefix.values, ...call.arguments.slice(1)], sources };
}

/** Stored fulfillments retain the old opaque boundary; a direct member consumes its value immediately. */
function immediateMember(value: Expression): boolean {
  const { at, parent } = useOf(value);
  if (isPropertyAccessExpression(parent) && parent.expression === at) return true;
  return (
    isElementAccessExpression(parent) &&
    parent.expression === at &&
    framedMapKey(parent.argumentExpression) !== undefined
  );
}
