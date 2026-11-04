import { describe, expect, it } from 'vitest';

import { counted, method, withinSteps } from '../src/authority/steps.ts';
import { VIEW_LIMITS } from '../src/program.ts';

/** Past what a call of a site's function may spend: as long as the code below says a value is. */
const PAST = VIEW_LIMITS.steps * 2;

/** `[].concat(value)` in a call of a site's function, `value` counted as the program counts it. */
function concatenated(value: unknown): () => unknown {
  return () => withinSteps(() => method([] as unknown[], 'concat')(counted(value)));
}

/** What `run` answers, or the name of what it throws, while `holder[key]` is `replacement`. */
function replacing(
  holder: WeakKey,
  key: PropertyKey,
  replacement: unknown,
  run: () => unknown,
): unknown {
  const kept = Object.getOwnPropertyDescriptor(holder, key);
  Object.defineProperty(holder, key, { configurable: true, value: replacement, writable: true });
  try {
    return run();
  } catch (error) {
    return (error as Error).name;
  } finally {
    if (kept !== undefined) {
      Object.defineProperty(holder, key, kept);
    }
  }
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

  it('refuses as before where the application’s code put another function in what it reads', () => {
    const value = {
      [Symbol.isConcatSpreadable]: true,
      get length() {
        return PAST;
      },
    };
    const attempt = (): unknown => concatenated(value)();
    // Sealed as the first call of a site's function seals it, before anything is replaced.
    withinSteps(() => 0);

    const answers = [
      replacing(Array.prototype, 'some', () => false, attempt),
      replacing(Object, 'getOwnPropertyDescriptor', () => ({ value: false }), attempt),
    ];

    expect(answers).toStrictEqual(['TypeError', 'TypeError']);
  });

  it('answers as before where the application’s code made `some` throw', () => {
    withinSteps(() => 0);

    const made = replacing(
      Array.prototype,
      'some',
      () => {
        throw new Error('The application’s own `some`.');
      },
      () => withinSteps(() => method([0] as unknown[], 'concat')([1])),
    );

    expect(made).toStrictEqual([0, 1]);
  });
});

/** `[<hole>, 'b']`, of a prototype of arrays that holds position 0 as `held` says. */
function holeyOf(held: PropertyDescriptor): unknown[] {
  const prototype = Object.create(Array.prototype, { 0: held }) as unknown[];
  const holey = Object.setPrototypeOf([], prototype) as unknown[];
  holey.length = 2;
  holey[1] = 'b';
  return holey;
}

/** A getter of `'a'`, counting its calls in `calls.count`. */
function counting(calls: { count: number }): () => string {
  return () => {
    calls.count += 1;
    return 'a';
  };
}

describe('what `concat` reads, as ECMA-262 has it read', () => {
  it('charges a callable it spreads as long as its stored length says, before it walks one', () => {
    const value = Object.defineProperties(() => 0, {
      length: { value: PAST },
      [Symbol.isConcatSpreadable]: { value: true },
    });

    expect(concatenated(value)).toThrow(RangeError);
  });

  it('charges what it spreads as it is called, though the value was counted shorter as it was made', () => {
    const value = { [Symbol.isConcatSpreadable]: true, length: 1 };
    function lengthened(): unknown {
      return withinSteps(() => {
        const kept = counted(value);
        kept.length = PAST;
        return method([] as unknown[], 'concat')(kept);
      });
    }

    expect(lengthened).toThrow(RangeError);
  });

  it('refuses an array an accessor says spreads, of its own or of what it inherits', () => {
    const calls = { count: 0 };
    const own = Object.defineProperty(['a'], Symbol.isConcatSpreadable, {
      get: () => counting(calls)() === 'a',
    });
    const prototype = Object.create(Array.prototype, {
      [Symbol.isConcatSpreadable]: { get: () => counting(calls)() === 'a' },
    }) as unknown[];
    const inherited: unknown = Object.setPrototypeOf(['a'], prototype);

    expect(concatenated(own)).toThrow(TypeError);
    expect(concatenated(inherited)).toThrow(TypeError);
    expect(calls.count).toBe(0);
  });

  it('refuses what it would read a position of through an accessor, its own or one at a hole', () => {
    const calls = { count: 0 };
    const own = Object.defineProperty(['x', 'y'], 1, { get: counting(calls) });
    const holey = holeyOf({ get: counting(calls) });
    const spread = Object.defineProperty({ [Symbol.isConcatSpreadable]: true, length: 1 }, 0, {
      enumerable: true,
      get: counting(calls),
    });

    expect(concatenated(own)).toThrow(TypeError);
    expect(concatenated(holey)).toThrow(TypeError);
    expect(concatenated(spread)).toThrow(TypeError);
    expect(calls.count).toBe(0);
  });

  it('refuses a receiver whose array the application’s class or accessor would make', () => {
    let made = 0;
    class Listed extends Array<string> {
      constructor(...items: string[]) {
        super(...items);
        made += 1;
      }
    }
    const subclassed = Listed.from(['a']);
    made = 0;
    const constructed = Object.defineProperty(['a'], 'constructor', {
      get: () => {
        made += 1;
        return Array;
      },
    });

    expect(() => withinSteps(() => method(subclassed, 'concat')(['b']))).toThrow(TypeError);
    expect(() => withinSteps(() => method(constructed, 'concat')(['b']))).toThrow(TypeError);
    expect(made).toBe(0);
  });

  it('reads what a hole inherits of data, as before', () => {
    const holey = holeyOf({ value: 'inherited' });

    expect(withinSteps(() => method([] as unknown[], 'concat')(counted(holey)))).toStrictEqual([
      'inherited',
      'b',
    ]);
  });
});
