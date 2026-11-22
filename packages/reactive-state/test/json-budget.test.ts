import { describe, expect, it } from 'vitest';

import { MAX_CARRIED_BYTES } from '../src/authority/json-size.ts';
import { jsonBudget, MAX_JSON_LENGTH, toJson, toJsonRecord } from '../src/runtime/json.ts';

/**
 * The bound a value is copied within (`JsonBudget`): the JSON it comes to, counted as it is copied,
 * every place an object stands in it counted — so that a value of a few objects that hold each
 * other many times over, as a Server Function's decoder hands a caller's, is refused once it is
 * counted past what a request carries, and not copied first.
 */

/** The bound, as the suite was written against it: what the authority reads of one request. */
const BOUND = 1_048_576;

/**
 * `levels` objects that each hold the next twice, above `leaf`: `levels + 1` objects, and `2 **
 * levels` places `leaf` stands at in the JSON a copy writes.
 */
function doubled(levels: number, leaf: unknown = {}): unknown {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) {
    value = { a: value, b: value };
  }
  return value;
}

/** An empty object that counts each time a copy reads it, and is a plain object otherwise. */
function countedLeaf(): { readonly leaf: unknown; readonly reads: () => number } {
  let reads = 0;
  const leaf = new Proxy(
    {},
    {
      getPrototypeOf: (target) => {
        reads += 1;
        return Reflect.getPrototypeOf(target);
      },
    },
  );
  return { leaf, reads: () => reads };
}

/** How much of a budget of its own a copy of `value` spends. */
function spentBy(value: unknown): number {
  const budget = jsonBudget();
  toJson(value, 'The value', budget);
  return MAX_JSON_LENGTH - budget.remaining;
}

describe('the bound a value is copied within', () => {
  it('is what the authority reads of one request', () => {
    expect(MAX_JSON_LENGTH).toBe(BOUND);
    expect(MAX_JSON_LENGTH).toBe(MAX_CARRIED_BYTES);
  });

  it('refuses nineteen objects that come to more JSON than a request carries', () => {
    // 2 ** 18 places of the leaf: three million characters of JSON, of nineteen objects.
    expect(() => toJson(doubled(18))).toThrow(TypeError);
    expect(() => toJson(doubled(18), 'The view')).toThrow(
      /^The view(?:\.[ab])+ is past the 1048576 characters of JSON one request carries\.$/u,
    );
    expect(() => toJsonRecord(doubled(18))).toThrow(/is past the 1048576 characters of JSON/u);
  });

  it('refuses it before it copies it: a shared object is read no more often than the bound has room for', () => {
    const { leaf, reads } = countedLeaf();

    expect(() => toJson(doubled(18, leaf))).toThrow(/is past the 1048576 characters of JSON/u);
    // Each object above the leaf writes ten characters of its own at the least, the leaf two: the
    // bound has room for a hundred thousand of them, of the half a million places the value has.
    expect(reads()).toBeLessThan(BOUND / 10);
  });

  it('refuses thirty objects that each hold the next twice, a thousand million places, at once', () => {
    expect(() => toJson(doubled(30))).toThrow(/is past the 1048576 characters of JSON/u);
    expect(() => toJsonRecord({ view: doubled(30) })).toThrow(
      /is past the 1048576 characters of JSON/u,
    );
  });

  it('refuses arrays that hold each other many times over alike', () => {
    let value: unknown = [];
    for (let level = 0; level < 30; level += 1) {
      value = [value, value];
    }

    expect(() => toJson(value)).toThrow(/is past the 1048576 characters of JSON/u);
  });

  it.each([
    ['a string', (length: number) => 'x'.repeat(length - 2)],
    ['an object of a string', (length: number) => ({ k: 'x'.repeat(length - 8) })],
    ['an array of a string', (length: number) => ['x'.repeat(length - 4)]],
  ])(
    'copies %s of exactly as much JSON as a request carries, and none of a character more',
    (_what, made) => {
      const whole = made(BOUND);
      const over = made(BOUND + 1);

      expect(JSON.stringify(whole)).toHaveLength(BOUND);
      expect(toJson(whole)).toStrictEqual(whole);
      expect(JSON.stringify(over)).toHaveLength(BOUND + 1);
      expect(() => toJson(over)).toThrow(/is past the 1048576 characters of JSON/u);
    },
  );

  it('copies an array of numbers of as much JSON as a request carries, and none of two characters more', () => {
    // `[0,0,…]`: two characters an element, and one more.
    const whole = Array.from({ length: (BOUND - 2) / 2 }, () => 0);
    const over = [...whole, 0];

    expect(JSON.stringify(whole)).toHaveLength(BOUND - 1);
    expect(toJson(whole)).toHaveLength(whole.length);
    expect(JSON.stringify(over)).toHaveLength(BOUND + 1);
    expect(() => toJson(over)).toThrow(/is past the 1048576 characters of JSON/u);
  });

  it('refuses an array longer than the bound by its length, before it reads an element of it', () => {
    const sparse: unknown[] = [];
    sparse.length = 4_000_000_000;

    expect(() => toJson(sparse)).toThrow(/^The value is past the 1048576 characters of JSON/u);
  });

  it.each([
    ['text of escapes', 'a"b\\c\nd\0'],
    ['text beyond ASCII', '済 😀'],
    ['a number', -12.5e-7],
    ['a boolean', false],
    ['nothing', null],
    ['an empty array', []],
    ['an empty object', {}],
    ['a list of lists', [[], [1, [2, [3]]], ['a', null, true]]],
    ['a record', { id: 'p1', nested: { list: [1, 2, 3], none: undefined, zero: -0 }, title: '' }],
  ])('counts no more of %s than JSON writes of it', (_what, value) => {
    expect(spentBy(value)).toBeLessThanOrEqual(JSON.stringify(value).length);
    expect(spentBy(value)).toBeGreaterThan(0);
  });

  it('counts the values of one request together, where they are copied within one budget', () => {
    const budget = jsonBudget();
    const half = 'x'.repeat(BOUND / 2 - 2);

    expect(toJson(half, 'Argument 1', budget)).toBe(half);
    expect(toJson(half, 'Argument 2', budget)).toBe(half);
    expect(() => toJson('', 'Argument 3', budget)).toThrow(
      'Argument 3 is past the 1048576 characters of JSON one request carries.',
    );
    // A budget of its own, unless one is given.
    expect(toJson(half)).toBe(half);
  });

  it('copies a small value that holds one object in several places as before: each place a copy of its own', () => {
    const shared = { id: 'a', tags: ['x', 'y'] };
    const copied = toJson({ first: shared, list: [shared, shared], second: shared }) as {
      readonly first: unknown;
      readonly list: readonly unknown[];
      readonly second: unknown;
    };

    expect(copied).toStrictEqual({
      first: { id: 'a', tags: ['x', 'y'] },
      list: [
        { id: 'a', tags: ['x', 'y'] },
        { id: 'a', tags: ['x', 'y'] },
      ],
      second: { id: 'a', tags: ['x', 'y'] },
    });
    expect(copied.first).not.toBe(copied.second);
    expect(copied.list[0]).not.toBe(copied.list[1]);
    expect(toJson(doubled(10))).toStrictEqual(doubled(10));
  });

  it('refuses a value that holds itself as nested too deep, as before, whichever way it holds itself', () => {
    const cycle: Record<string, unknown> = {};
    cycle['a'] = cycle;
    cycle['b'] = cycle;

    expect(() => toJson(cycle)).toThrow(/nested more than 64 levels/u);
    expect(() => toJson(doubled(64))).toThrow(/nested more than 64 levels/u);
  });
});
