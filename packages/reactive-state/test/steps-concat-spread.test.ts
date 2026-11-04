import { describe, expect, it } from 'vitest';

import { counted, method, withinSteps } from '../src/authority/steps.ts';
import { VIEW_LIMITS } from '../src/program.ts';

/** Past what a call of a site's function may spend: as long as the code below says a value is. */
const PAST = VIEW_LIMITS.steps * 2;

/** `[].concat(value)` in a call of a site's function, `value` counted as the program counts it. */
function concatenated(value: unknown): () => unknown {
  return () => withinSteps(() => method([] as unknown[], 'concat')(counted(value)));
}

describe('what a dynamic site gives `concat` to spread', () => {
  it('refuses one whose length an accessor answers, before `concat` reads it', () => {
    let reads = 0;
    const value = {
      [Symbol.isConcatSpreadable]: true,
      get length() {
        reads += 1;
        return PAST;
      },
    };

    expect(concatenated(value)).toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it('refuses one an accessor makes spreadable, and one whose length converts through code', () => {
    let calls = 0;
    const flagged = Object.defineProperty({ length: PAST }, Symbol.isConcatSpreadable, {
      get: () => {
        calls += 1;
        return true;
      },
    });
    const converted = {
      [Symbol.isConcatSpreadable]: true,
      length: {
        valueOf: () => {
          calls += 1;
          return PAST;
        },
      },
    };

    expect(concatenated(flagged)).toThrow(TypeError);
    expect(concatenated(converted)).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it('spreads what its stored entries say spreads, and holds anything else as one element', () => {
    const spread = { 0: 'a', 1: 'b', [Symbol.isConcatSpreadable]: true, length: 2 };
    const held = { length: PAST };

    const made = withinSteps(() =>
      method([0] as unknown[], 'concat')(['x'], counted(spread), counted(held), 'y'),
    );

    expect(made).toStrictEqual([0, 'x', 'a', 'b', held, 'y']);
  });

  it('checks nothing outside a call of a site’s function', () => {
    const value = {
      0: 'a',
      [Symbol.isConcatSpreadable]: true,
      get length() {
        return 1;
      },
    };

    expect(method([] as unknown[], 'concat')(value)).toStrictEqual(['a']);
  });
});
