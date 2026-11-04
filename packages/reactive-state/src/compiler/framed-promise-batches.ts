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
import { framedBatchInput } from './framed-batch-values.ts';
import { frameMemberName } from './framed-bindings.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Immediately selected native Promise batch fulfillments retain their original source elements. */

const PROMISES = new Set(['Promise']);
const METHODS = new Set(['all', 'allSettled']);

/** Only a written finite list of immediate fulfillments contributes an indexed native batch result. */
export function framedPromiseBatchResult(
  node: Expression,
  made: boolean,
  keys: readonly string[],
  error: (value: Expression, made: boolean, keys: readonly string[]) => boolean,
): true | undefined {
  if (!immediateMember(node)) return undefined;
  let awaited = unwrapped(node);
  const path = [...keys];
  while (isPropertyAccessExpression(awaited) || isElementAccessExpression(awaited)) {
    const key = frameMemberName(awaited);
    if (key === undefined) return undefined;
    path.unshift(key);
    awaited = unwrapped(awaited.expression);
  }
  if (!isAwaitExpression(awaited)) return undefined;
  const call = unwrapped(awaited.expression);
  if (!isCallExpression(call)) return undefined;
  const method = nativeMethod(call.expression);
  if (method === undefined || !framedOriginPrefix(call)) return undefined;
  const index = path.shift();
  if (index === undefined || !/^(?:0|[1-9]\d*)$/u.test(index)) return undefined;
  if (method === 'allSettled' && path.shift() !== 'value') return undefined;
  const selection = batchSelection(call, Number(index));
  if (
    selection?.selected === undefined ||
    selection.sources.some(({ value }) => !framedOriginCoowned(value, call)) ||
    !iteratorCarriedUnexposed(selection.roots, selection.sources, call)
  )
    return undefined;
  return error(selection.selected, made, path) ? true : undefined;
}

/** The native receiver and method retain lexical identity through constructor aliases. */
function nativeMethod(node: Expression): string | undefined {
  const member = unwrapped(node);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const name = frameMemberName(member);
  return name !== undefined &&
    METHODS.has(name) &&
    framedNativeConstructor(member.expression, PROMISES)
    ? name
    : undefined;
}

interface BatchSelection {
  readonly selected: Expression | undefined;
  readonly roots: readonly Expression[];
  readonly sources: readonly { readonly value: Expression }[];
}

/** All inputs are quiet and immediately fulfilled before an indexed source value is selected. */
function batchSelection(call: CallExpression, index: number): BatchSelection | undefined {
  const input = call.arguments[0];
  if (
    input === undefined ||
    isSpreadElement(input) ||
    !iteratorQuietValues(call.arguments.slice(1))
  )
    return undefined;
  const elements = framedAppliedArguments(call, input);
  if (elements === undefined) return undefined;
  const prefix = framedArgumentPrefix(call, elements, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  const inputs = prefix.values.map((value) => framedBatchInput(value));
  if (inputs.includes(undefined)) return undefined;
  const sources: { readonly value: Expression }[] = [];
  for (const value of inputs) {
    if (value?.value !== undefined) sources.push({ value: value.value });
  }
  return {
    selected: inputs[index]?.value,
    roots: [...prefix.values, ...call.arguments.slice(1)],
    sources,
  };
}

/** Stored arrays and selected fulfillments retain their previous opaque projection boundary. */
function immediateMember(value: Expression): boolean {
  const { at, parent } = useOf(value);
  if (isPropertyAccessExpression(parent) && parent.expression === at) return true;
  return (
    isElementAccessExpression(parent) &&
    parent.expression === at &&
    framedMapKey(parent.argumentExpression) !== undefined
  );
}
