import {
  type Expression,
  isArrayLiteralExpression,
  isAwaitExpression,
  isCallExpression,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { concatSource } from './framed-concat-properties.ts';
import { immediateSelection } from './framed-copy-guards.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedRaceInput } from './framed-race-values.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/**
 * An awaited native Array.fromAsync fulfills with each element of its source settled in order: a
 * written array's elements are awaited one by one, and a hole is read as undefined.
 */

const FROM_ASYNC = new Set(['Array.fromAsync']);
const UNDEFINED = new Set(['undefined']);

/**
 * The settled elements an immediately read `await Array.fromAsync(source)` holds at a selected
 * position, of a finite quiet written source whose every element is already fulfilled.
 */
export function asyncArrayFactoryViews(
  value: Expression,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
): readonly ArrayElementView[] | undefined {
  if (!isAwaitExpression(value) || !immediateSelection(value)) return undefined;
  const call = unwrapped(value.expression);
  if (!isCallExpression(call) || !framedNativeConstructor(call.expression, FROM_ASYNC))
    return undefined;
  const prefix = framedArgumentPrefix(call, call.arguments, Infinity);
  const [input, mapper, ...rest] = prefix.values;
  const source = input === undefined ? undefined : concatSource(input, stable, false);
  if (
    source === undefined ||
    prefix.unknown ||
    prefix.alternatives !== undefined ||
    !isArrayLiteralExpression(source) ||
    (mapper !== undefined && !framedNativeConstructor(mapper, UNDEFINED)) ||
    !iteratorQuietValues(rest) ||
    !framedOriginPrefix(call)
  )
    return undefined;
  const settled = settledElements(source.elements);
  if (settled === undefined) return undefined;
  const selected = index === undefined ? settled : settled.slice(index, index + 1);
  const values = selected.flatMap((each) => (each === undefined ? [] : [{ value: each }]));
  if (
    values.some((each) => !framedOriginCoowned(each.value, call)) ||
    !iteratorCarriedUnexposed([source, ...rest], values, call)
  )
    return undefined;
  return values.map((each) => settledView(each.value, call));
}

/** A settled element stands as a written element of the awaited result. */
function settledView(value: Expression, capture: Expression): ArrayElementView {
  return { value, index: undefined, element: true, capture };
}

/** Each element's fulfilled value, or none for a hole; an element not yet fulfilled keeps no proof. */
function settledElements(
  elements: readonly Expression[],
): readonly (Expression | undefined)[] | undefined {
  const settled: (Expression | undefined)[] = [];
  for (const element of elements) {
    if (isSpreadElement(element)) return undefined;
    const input = framedRaceInput(element);
    if (input === undefined) return undefined;
    settled.push(input.value);
  }
  return settled;
}
