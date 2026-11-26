import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isElementAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { framedKeyNames } from './framed-keys.ts';

/** A nested index read selects an element of the outer array, then reads on by the inner position. */

const INDEX = /^(?:0|[1-9]\d*)$/u;

/**
 * Readings of the array an indexed element is read from, `rows` of `rows[0]` at a known inner
 * position: its element at each written outer index, read on by the inner position and keys. What
 * the reading copies for (`copied`) carries on, one more leading key deep.
 */
export function nestedArrayReadings(reading: ArrayElementView): readonly ArrayElementView[] {
  const value = unwrapped(reading.value);
  if (!isElementAccessExpression(value) || reading.index === undefined || reading.index < 0)
    return [];
  const keys = framedKeyNames(value.argumentExpression);
  if (keys === undefined) return [];
  const inner = [String(reading.index), ...(reading.keys ?? [])];
  const capture = reading.capture === undefined ? {} : { capture: reading.capture };
  const { copied: from } = reading;
  const copied = from === undefined ? {} : { copied: { ...from, depth: from.depth + 1 } };
  return keys.flatMap((key) => {
    return INDEX.test(key)
      ? [{ value: value.expression, index: Number(key), keys: inner, ...capture, ...copied }]
      : [];
  });
}

/** A written array read on by an index key selects its element at that position. */
export function literalKeyedReading(
  value: Expression,
  keys: readonly string[] | undefined,
):
  | {
      readonly value: ArrayLiteralExpression;
      readonly index: number;
      readonly keys: readonly string[];
    }
  | undefined {
  const [key, ...rest] = keys ?? [];
  const array = unwrapped(value);
  return key !== undefined && INDEX.test(key) && isArrayLiteralExpression(array)
    ? { value: array, index: Number(key), keys: rest }
    : undefined;
}

/**
 * A value other than a written array, read on by an index key: the array it names read at that
 * position by the remaining keys, its own writes and initializer included, as of the original read.
 */
export function indexedReading(
  value: Expression,
  keys: readonly string[] | undefined,
): ArrayElementView | undefined {
  const [key, ...rest] = keys ?? [];
  return key !== undefined && INDEX.test(key) && !isArrayLiteralExpression(unwrapped(value))
    ? { value, index: Number(key), keys: rest }
    : undefined;
}
