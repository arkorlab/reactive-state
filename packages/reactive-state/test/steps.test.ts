import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { counted, member, withinSteps } from '../src/authority/steps.ts';
import { VIEW_LIMITS } from '../src/program.ts';

/**
 * What a call of a dynamic site's function spends of its inputs: each value its code makes, which
 * the program writes through `$.counted`, and the size of it — each element and entry of it,
 * however deep, each character of its text, and the elements an object the language reads as an
 * array says it holds — held to `VIEW_LIMITS.steps`, so that no code turns the few bytes of a view
 * into work or memory without bound.
 */

/** A native method kept as data to verify it cannot escape the runtime guard. */
const PAD_START: unknown = Reflect.get(String.prototype, 'padStart');

/** A function of the application's, which a value may hold. */
function formatted(value: string): string {
  return value;
}

/** `count` calls of a function a method is given, each answering `value`, in one call of a site's function. */
function spending(count: number, value: unknown): () => void {
  return () => {
    withinSteps(() => {
      for (let index = 0; index < count; index += 1) {
        counted(value);
      }
    });
  };
}

/** A call of the global `name`, read as the call runs, given `source`. */
function calling(name: string, source: string): () => unknown {
  return () => (Reflect.get(globalThis, name) as (text: string) => unknown)(source);
}

/** A function made of text by the global `Function`, read as the call runs. */
function making(): unknown {
  return Reflect.construct(Reflect.get(globalThis, 'Function') as new () => unknown, ['return 1']);
}

describe('what a site’s function spends of its inputs', () => {
  it('answers what it counts as it is', () => {
    const answer = { ids: ['a'] };

    expect(withinSteps(() => counted(answer))).toBe(answer);
  });

  it('counts each call', () => {
    expect(spending(VIEW_LIMITS.steps, true)).not.toThrow();
    expect(spending(VIEW_LIMITS.steps + 1, true)).toThrow(RangeError);
  });

  it('counts each character of text, and each element and entry, however deep', () => {
    const half = Math.floor(VIEW_LIMITS.steps / 2);

    // One step for the call, the rest for the text.
    expect(spending(1, 'x'.repeat(VIEW_LIMITS.steps - 1))).not.toThrow();
    expect(spending(1, 'x'.repeat(VIEW_LIMITS.steps))).toThrow(RangeError);
    // A step for each element, and one for each character of it.
    expect(
      spending(
        1,
        Array.from({ length: half }, () => 'x'),
      ),
    ).toThrow(RangeError);
    expect(spending(1, [{ inner: [Array.from({ length: VIEW_LIMITS.steps }, () => 0)] }])).toThrow(
      RangeError,
    );
  });

  it('counts each character of an entry’s key', () => {
    // One step for the call, one for the entry, the rest for its key.
    expect(spending(1, { ['x'.repeat(VIEW_LIMITS.steps - 2)]: 0 })).not.toThrow();
    expect(spending(1, { ['x'.repeat(VIEW_LIMITS.steps - 1)]: 0 })).toThrow(RangeError);
  });

  it('counts what an object holds by a symbol, or not enumerated, as by any key', () => {
    const hidden = Symbol('hidden');
    const unlisted = Object.defineProperty({}, 'held', { value: 'x'.repeat(VIEW_LIMITS.steps) });

    expect(spending(1, { [hidden]: 'x'.repeat(VIEW_LIMITS.steps) })).toThrow(RangeError);
    expect(spending(1, unlisted)).toThrow(RangeError);
  });

  it.each(
    [
      Object.assign(['z'], { run: PAD_START }),
      Object.assign(['z'], { [Symbol('run')]: PAD_START }),
      Object.defineProperty(['z'], 'run', { value: PAD_START }),
      Object.assign(['z'], { nested: { run: PAD_START } }),
      Object.assign(['z'], { integer: 1n }),
      Object.assign([PAD_START], {
        [Symbol.iterator]: () => [][Symbol.iterator](),
      }),
    ].map((value) => ({ value })),
  )('refuses unsafe values held by an array outside its indexed elements %#', ({ value }) => {
    expect(spending(1, value)).toThrow(TypeError);
  });

  it.each(
    [
      Object.assign(['z'], { more: 'x'.repeat(VIEW_LIMITS.steps) }),
      Object.assign(['z'], { [Symbol('more')]: 'x'.repeat(VIEW_LIMITS.steps) }),
      Object.defineProperty(['z'], 'more', { value: 'x'.repeat(VIEW_LIMITS.steps) }),
      Object.assign(['z'], { ['x'.repeat(VIEW_LIMITS.steps)]: 0 }),
    ].map((value) => ({ value })),
  )('counts every extra own property of an array against the budget %#', ({ value }) => {
    expect(spending(1, value)).toThrow(RangeError);
  });

  it('measures array entries without invoking a custom iterator or indexed getters', () => {
    let calls = 0;
    const value = Object.assign(['z'], {
      *[Symbol.iterator]() {
        calls += 1;
        yield 'ignored';
      },
      format: formatted,
    });
    const indexed = Object.defineProperty([undefined], '0', {
      get: () => PAD_START,
    });

    expect(spending(1, value)).not.toThrow();
    expect(calls).toBe(0);
    expect(spending(1, indexed)).not.toThrow();
    expect(() => {
      withinSteps(() => {
        counted(indexed[0]);
      });
    }).toThrow(TypeError);
  });

  it.each(['throwing', 'counting', 'native'])(
    'measures indexed accessors without reading a %s getter',
    (kind) => {
      let calls = 0;
      const made = (): unknown[] => {
        return Object.defineProperty([], '0', {
          get: () => {
            calls += 1;
            if (kind === 'throwing') {
              throw new Error('The index was not read by the expression.');
            }
            return kind === 'native' ? PAD_START : 'value';
          },
        });
      };

      expect(withinSteps(() => counted(made()).length)).toBe(1);
      expect(calls).toBe(0);
    },
  );

  it('preserves explicitly read getters and counts accessor positions against the budget', () => {
    const value = Object.defineProperty([], '0', {
      get: () => {
        throw new Error('Explicit getter read.');
      },
    });
    const many = Object.defineProperty([], '0', { get: () => 'unused' });
    many.length = VIEW_LIMITS.steps;

    expect(() => {
      withinSteps(() => counted(value)[0]);
    }).toThrow('Explicit getter read.');
    expect(spending(1, many)).toThrow(RangeError);
  });

  it('counts the elements an object the language reads as an array says it holds, of no entry of them', () => {
    const many = VIEW_LIMITS.steps;
    const values = Array.prototype.values;

    // `concat` spreads one made spreadable as long as its `length` says; `[...…]` iterates one so.
    expect(spending(1, { [Symbol.isConcatSpreadable]: true, length: many })).toThrow(RangeError);
    expect(spending(1, { [Symbol.iterator]: values, length: String(many) })).toThrow(RangeError);
    expect(spending(1, { [Symbol.isConcatSpreadable]: true, length: 2 })).not.toThrow();
    // An entry of the data named `length` is no array's: its value is all it holds.
    expect(spending(1, { length: many })).not.toThrow();
    expect(spending(1, { [Symbol.isConcatSpreadable]: true, length: -many })).not.toThrow();
  });

  it.each([Symbol.iterator, Symbol.isConcatSpreadable])(
    'measures unused %s accessors without calling them',
    (key) => {
      let calls = 0;
      const value = Object.defineProperty({ value: 'ok' }, key, {
        get: () => {
          calls += 1;
          throw new Error('The expression did not read this symbol.');
        },
      });

      expect(withinSteps(() => counted(value).value)).toBe('ok');
      expect(calls).toBe(0);
      expect((): unknown => Reflect.get(value, key)).toThrow(
        'The expression did not read this symbol.',
      );
      expect(calls).toBe(1);
    },
  );

  it('does not read an unused length getter of a spreadable object', () => {
    let calls = 0;
    const value = {
      [Symbol.isConcatSpreadable]: true,
      get length() {
        calls += 1;
        throw new Error('The expression did not read length.');
      },
      value: 'ok',
    };

    expect(withinSteps(() => counted(value).value)).toBe('ok');
    expect(calls).toBe(0);
  });

  it('does not coerce a stored length through application code while measuring', () => {
    let calls = 0;
    const value = {
      [Symbol.isConcatSpreadable]: true,
      length: {
        valueOf() {
          calls += 1;
          throw new Error('The expression did not convert length.');
        },
      },
      value: 'ok',
    };

    expect(withinSteps(() => counted(value).value)).toBe('ok');
    expect(calls).toBe(0);
  });

  it('counts array data inherited through a callable prototype', () => {
    const prototype = Object.defineProperties(() => 0, {
      [Symbol.iterator]: { value: Array.prototype.values },
      length: { value: VIEW_LIMITS.steps + 1 },
    });
    const value: unknown = Object.create(prototype);

    expect(spending(1, value)).toThrow(RangeError);
  });

  it('keeps an inherited accessor shadow without reading through a callable prototype', () => {
    let calls = 0;
    const prototype = Object.defineProperties(() => 0, {
      [Symbol.iterator]: {
        get() {
          calls += 1;
          throw new Error('The expression did not read the inherited iterator.');
        },
      },
      length: { value: VIEW_LIMITS.steps + 1 },
    });
    Object.setPrototypeOf(prototype, { [Symbol.iterator]: Array.prototype.values });
    const value: unknown = Object.create(prototype);

    expect(spending(1, value)).not.toThrow();
    expect(calls).toBe(0);
  });

  it.each([null, 2])('keeps inherited primitive length %s on a callable prototype', (length) => {
    const prototype = Object.defineProperties(() => 0, {
      [Symbol.iterator]: { value: Array.prototype.values },
      length: { value: length },
    });
    const value: unknown = Object.create(prototype);

    expect(spending(1, value)).not.toThrow();
  });

  it('refuses a method of the language’s held apart from what it is of, and no function of the application’s', () => {
    const [join, padStart, values]: unknown[] = [
      Reflect.get(Array.prototype, 'join'),
      Reflect.get(String.prototype, 'padStart'),
      Reflect.get(Array.prototype, 'values'),
    ];

    // `[].join` called as an object's own joins that object as an array as long as it says.
    expect(spending(1, { join, length: 1 })).toThrow(TypeError);
    expect(spending(1, [padStart])).toThrow(TypeError);
    expect(spending(1, values)).toThrow(TypeError);
    expect(spending(1, { format: formatted })).not.toThrow();
  });

  it('refuses an integer of `bigint`, which an operator makes as large as another says at once', () => {
    expect(spending(1, 1n)).toThrow(TypeError);
    expect(spending(1, [1, 2n])).toThrow(TypeError);
    expect(spending(1, { count: 3n })).toThrow(TypeError);
    expect(spending(1, 1)).not.toThrow();
  });

  it('refuses a key the code computes that reaches what made a value, and answers any other as it is', () => {
    expect(() => member('constructor')).toThrow(TypeError);
    expect(() => member('__proto__')).toThrow(TypeError);
    expect(() => member(['constructor'])).toThrow(TypeError);
    expect(member('title')).toBe('title');
    expect(member(0)).toBe(0);
    // What made a value, held by what the code makes, would reach its own functions by their names.
    expect(spending(1, { text: String })).toThrow(TypeError);
  });

  it('counts what holds itself once on the way, a cycle, and reads what nests however deep', () => {
    const cyclic: Record<string, unknown> = { id: 'x' };
    cyclic['self'] = cyclic;
    let deep: unknown[] = [];
    for (let level = 0; level < 50_000; level += 1) {
      deep = [deep];
    }

    expect(spending(1, cyclic)).not.toThrow();
    expect(spending(1, [cyclic, { inner: cyclic }])).not.toThrow();
    expect(spending(1, deep)).not.toThrow();
  });

  it('counts an object shared by what it holds each time it reaches it', () => {
    const shared = { text: 'x'.repeat(1024) };

    // Reached by each of 512 elements: 512 times its 1024 characters, past the steps.
    expect(
      spending(
        1,
        Array.from({ length: 512 }, () => shared),
      ),
    ).toThrow(RangeError);
  });

  it('counts an array shared by what it answers each time it answers it', () => {
    const ids = Array.from({ length: 1024 }, (_, index) => index);

    // `ids.flatMap(() => ids)`, as the program writes it: 1024 answers of 1024 elements.
    expect(() => withinSteps(() => ids.flatMap(() => counted(ids)))).toThrow(RangeError);
  });

  it('makes no code of text while a site’s function runs, however the code spells what makes it', () => {
    const name = ['con', 'structor'].join('');
    const made = (): unknown => {
      const maker = Reflect.get(Reflect.get(Number, name) as () => unknown, name) as (
        source: string,
      ) => () => unknown;
      return maker('return 1')();
    };

    expect(() => withinSteps(made)).toThrow(EvalError);
    // As it was once the call is done.
    expect(made()).toBe(1);
    expect(Reflect.get(Number, name)).toBe(Function);
  });

  it('calls neither `eval` nor `Function` while a site’s function runs, however the code reaches them, and both as they were outside one', () => {
    expect(() => withinSteps(calling('eval', '1 + 1'))).toThrow(EvalError);
    expect(() => withinSteps(calling('Function', 'return 1'))).toThrow(EvalError);
    expect(() => withinSteps(making)).toThrow(EvalError);
    expect(calling('eval', '1 + 1')()).toBe(2);
    expect(making()).toBeTypeOf('function');
  });

  it('seals what makes code of text for good: a direct `eval` within a call is refused, and a prototype a call freezes keeps it sealed past the call no more', () => {
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const script = [
      `const { withinSteps } = await import(${JSON.stringify(steps)});`,
      'const tried = (made) => {',
      '  try {',
      '    return String(made());',
      '  } catch (error) {',
      '    return error.name;',
      '  }',
      '};',
      "console.log(tried(() => withinSteps(() => eval('1 + 1'))));",
      'console.log(tried(() => withinSteps(() => Object.isFrozen(Object.freeze(Function.prototype)))));',
      'console.log(tried(() => (() => 0).constructor === Function));',
      "console.log(tried(() => eval('1 + 1')));",
      'console.log(tried(() => withinSteps(() => (() => 0).constructor)));',
      'console.log(tried(() => withinSteps(() => 3)));',
    ].join('\n');

    const ran = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
    });

    expect(ran.stdout.trim().split('\n')).toStrictEqual([
      'EvalError',
      'true',
      'true',
      '2',
      'EvalError',
      '3',
    ]);
  });

  it('runs no site’s function where what makes code of text cannot be sealed — the application froze it — the next call no more than the first', () => {
    const steps = fileURLToPath(new URL('../src/authority/steps.ts', import.meta.url));
    const script = [
      'Object.freeze(Function.prototype);',
      `const { withinSteps } = await import(${JSON.stringify(steps)});`,
      'for (const call of [1, 2]) {',
      '  try {',
      '    withinSteps(() => call);',
      "    console.log('ran');",
      '  } catch (error) {',
      '    console.log(error.name);',
      '  }',
      '}',
    ].join('\n');

    const ran = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
    });

    expect(ran.stdout.trim().split('\n')).toStrictEqual(['EvalError', 'EvalError']);
  });

  it('starts each call of a site’s function from nothing spent, and counts nothing outside one', () => {
    const many = spending(VIEW_LIMITS.steps, true);

    expect(many).not.toThrow();
    expect(many).not.toThrow();
    expect(() => {
      for (let index = 0; index <= VIEW_LIMITS.steps; index += 1) {
        counted(true);
      }
    }).not.toThrow();
  });
});
