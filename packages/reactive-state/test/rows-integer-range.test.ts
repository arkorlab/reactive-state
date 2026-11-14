import { describe, expect, it } from 'vitest';

import { integer } from '../src/authority/rows.ts';

describe('integer', () => {
  it('answers an integer of `bigint` a number holds exactly, as the number', () => {
    const most = BigInt(Number.MAX_SAFE_INTEGER);

    expect(integer({ n: 7n }, 'n')).toBe(7);
    expect(integer({ n: most }, 'n')).toBe(Number.MAX_SAFE_INTEGER);
    expect(integer({ n: -most }, 'n')).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it('refuses an integer of `bigint` no number holds exactly, as it refuses such a number', () => {
    const past = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

    expect(() => integer({ n: 2 ** 53 }, 'n')).toThrow('column n is not an integer');
    expect(() => integer({ n: past }, 'n')).toThrow('column n is not an integer');
    expect(() => integer({ n: past + 1n }, 'n')).toThrow('column n is not an integer');
    expect(() => integer({ n: -past }, 'n')).toThrow('column n is not an integer');
  });
});
