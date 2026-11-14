import { describe, expect, it } from 'vitest';

import { isCarriedJson, isJson } from '../src/authority/canonical.ts';

/** The deepest nesting `isJson` takes, as `canonical.ts` bounds it. */
const MAX_DEPTH = 64;
/** How many arrays deep `counted` nests: its JSON holds 2^16 zeros. */
const LEVELS = 16;

/**
 * `LEVELS` arrays, each holding the one below it twice — no cycle — each read through a proxy that
 * counts how often an element of it is looked up, as the validators look one up.
 */
function counted(): { readonly value: unknown; readonly lookups: () => number } {
  let lookups = 0;
  const counting: ProxyHandler<unknown[]> = {
    getOwnPropertyDescriptor(target, key) {
      lookups += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  };
  let value: unknown = 0;
  for (let level = 0; level < LEVELS; level += 1) {
    value = new Proxy([value, value], counting);
  }
  return { lookups: () => lookups, value };
}

/** `value` inside `levels` arrays of one element each. */
function nested(value: unknown, levels: number): unknown {
  let outer = value;
  for (let level = 0; level < levels; level += 1) {
    outer = [outer];
  }
  return outer;
}

describe('a value that holds one object more than once', () => {
  it('reads an object it holds once where it stands no deeper, however often it is held', () => {
    for (const validate of [isJson, isCarriedJson]) {
      const { lookups, value } = counted();

      expect(validate(value)).toBe(true);
      // Each array's own two elements and length, a few times over, rather than 2^16 of them.
      expect(lookups()).toBeLessThan(LEVELS * 16);
    }
  });

  it('reads an object it holds again where it stands deeper, against the bound from there', () => {
    const shared = nested(0, 8);

    // Within the bound where it stands under 55 more arrays, past it under 56.
    expect(isJson([shared, nested(shared, MAX_DEPTH - 9)])).toBe(true);
    expect(isJson([shared, nested(shared, MAX_DEPTH - 8)])).toBe(false);
    expect(isCarriedJson([shared, nested(shared, MAX_DEPTH - 8)])).toBe(false);
  });

  it('still refuses an object that holds itself', () => {
    const cycle: unknown[] = [];
    cycle.push([cycle]);

    expect(isJson(cycle)).toBe(false);
    expect(isCarriedJson(cycle)).toBe(false);
  });
});
