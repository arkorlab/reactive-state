import { describe, expect, it } from 'vitest';

import { jsonBudget, MAX_JSON_LENGTH, toJson } from '../src/runtime/json.ts';

/**
 * The properties a copy leaves out: one that holds `undefined` is no part of the JSON a copy
 * writes, and is read all the same at every place its object stands, so it is counted there as a
 * property that is written is — a comma of the object's — and an object of many of them, held in
 * many places, is refused once they are counted past the bound, not read first.
 */

const BOUND = 1_048_576;
const PAST = /is past the 1048576 characters of JSON one request carries\.$/u;

/** An object of `count` properties that each hold `undefined`: `{}` as JSON writes it. */
function leftOut(count: number): Record<string, undefined> {
  const value: Record<string, undefined> = {};
  for (let index = 0; index < count; index += 1) {
    value[`k${String(index)}`] = undefined;
  }
  return value;
}

/** `value`, counting each time a copy reads it, and a plain object otherwise. */
function counted<T extends WeakKey>(value: T): { readonly held: T; readonly reads: () => number } {
  let reads = 0;
  const held = new Proxy(value, {
    getPrototypeOf: (target) => {
      reads += 1;
      return Reflect.getPrototypeOf(target);
    },
  });
  return { held, reads: () => reads };
}

/** What a copy of `value` throws, as its message; nothing where it copies it. */
function refusalOf(value: unknown): string | undefined {
  try {
    toJson(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** How much of a budget of its own a copy of `value` spends. */
function spentBy(value: unknown): number {
  const budget = jsonBudget();
  toJson(value, 'The value', budget);
  return MAX_JSON_LENGTH - budget.remaining;
}

describe('the properties a copy leaves out', () => {
  it('are read no more often than the bound has room for: an object of 1,024 of them, held in 2,048 places', () => {
    const { held, reads } = counted(leftOut(1024));
    const value = Array.from({ length: 2048 }, () => held);

    const refused = refusalOf(value);

    // Each place counts the object's braces and a comma for each property but the first, 1,025:
    // the bound has room for 1,021 places after the array's own 2,049, and the next is refused.
    expect(reads()).toBe(1022);
    expect(refused).toBe(
      'The value[1021] is past the 1048576 characters of JSON one request carries.',
    );
  });

  it('refuse an object of 16,384 of them held in 65,536 places at the sixtieth, a thousand million properties unread', () => {
    const { held, reads } = counted(leftOut(16_384));
    const value = Array.from({ length: 65_536 }, () => held);

    expect(refusalOf(value)).toBe(
      'The value[59] is past the 1048576 characters of JSON one request carries.',
    );
    expect(reads()).toBe(60);
  });

  it('refuse one object of more of them than the bound, before any is read', () => {
    expect(() => toJson(leftOut(BOUND))).toThrow(PAST);
    expect(() => toJson({ list: [leftOut(BOUND)] }, 'The props')).toThrow(
      'The props.list[0] is past the 1048576 characters of JSON one request carries.',
    );
  });

  it.each([
    ['one of one', { a: undefined }, 0],
    ['one of two', { a: undefined, b: undefined }, 1],
    ['two beside one that is written', { a: undefined, b: 1, c: undefined }, 2],
    ['one in an object a list holds', [{ id: 'x', none: undefined }], 1],
    [
      'one in a record',
      { id: 'p1', nested: { list: [1, 2, 3], none: undefined, zero: -0 }, title: '' },
      1,
    ],
  ])('are counted as a comma each is: %s', (_what, value, over) => {
    expect(spentBy(value)).toBe(JSON.stringify(value).length + over);
  });

  it('are the only thing counted that JSON does not write: an object of none is counted as JSON writes it, its commas among them', () => {
    const value = { a: 1, b: ['x', 2], c: { d: 'y' }, e: {}, f: [] };

    expect(spentBy(value)).toBe(JSON.stringify(value).length);
    expect(spentBy({})).toBe(2);
    expect(spentBy({ only: '' })).toBe(JSON.stringify({ only: '' }).length);
  });

  it('are left out as before of a value that is small, however many places hold them', () => {
    const shared = { kept: 1, none: undefined };

    expect(
      toJson({ a: undefined, list: [shared, shared], nested: { b: undefined } }),
    ).toStrictEqual({ list: [{ kept: 1 }, { kept: 1 }], nested: {} });
    expect(toJson(leftOut(1000))).toStrictEqual({});
    expect(toJson(Array.from({ length: 1000 }, () => leftOut(1000)))).toHaveLength(1000);
  });
});
