import { describe, expect, it } from 'vitest';

import { methodOf } from '../src/authority/methods.ts';
import { method } from '../src/authority/steps.ts';
import type { RenderScope } from '../src/program.ts';

/** The actual function of a method call, before arguments can run, rather than a container's snapshot. */

function carrier(kind: string): { run: typeof String.prototype.padStart } {
  const native = Reflect.get<typeof String.prototype, 'padStart'>(String.prototype, 'padStart');
  switch (kind) {
    case 'array': {
      return Object.assign(['z'], { run: native });
    }
    case 'prototype': {
      return Object.create({ run: native }) as { run: typeof native };
    }
    case 'accessor': {
      return {
        get run() {
          return native;
        },
      };
    }
    case 'proxy': {
      return new Proxy({ run: native }, { ownKeys: () => [] });
    }
    default: {
      return { run: native };
    }
  }
}

/** An application function whose result is the argument it was given. */
function formatted(given: string): string {
  return given;
}

describe('the actual function a dynamic site calls as a method', () => {
  it.each(['object', 'array', 'prototype', 'accessor', 'proxy'])(
    'refuses an aliased native function obtained through %s',
    (kind) => {
      expect(() => methodOf(carrier(kind), 'run', true)).toThrow(TypeError);
    },
  );

  it.each([
    Array.from,
    String.raw,
    Object.assign,
    Number.parseFloat,
    Boolean,
    Function,
    Math.max,
    JSON.stringify,
    Reflect.apply,
  ])(
    'refuses a native namespace function or constructor through another receiver or key: %s',
    (native) => {
      expect(() => methodOf({ run: native }, 'run', true)).toThrow(TypeError);
    },
  );

  it('refuses canonical names on values of another brand and on spoofed boxed values', () => {
    const arrayMethod = { slice: Array.prototype.slice };
    const textMethod = {
      [Symbol.toStringTag]: 'String',
      slice: Reflect.get(String.prototype, 'slice'),
    };

    expect(() => methodOf(arrayMethod, 'slice', true)).toThrow(TypeError);
    expect(() => methodOf(textMethod, 'slice', true)).toThrow(TypeError);
  });

  it('refuses a native static function on a proxy of its namespace', () => {
    expect(() => methodOf(new Proxy(Math, {}), 'max', true)).toThrow(TypeError);
  });

  it('refuses a native function held by an application function', () => {
    const callable = Object.assign(() => 1, { run: Array.from });

    expect(() => methodOf(callable, 'run', true)).toThrow(TypeError);
  });

  it('permits native methods on their proper receivers and canonical keys', () => {
    expect(methodOf('a', 'padStart', true)(2, 'x')).toBe('xa');
    expect(methodOf(1, 'toFixed', true)(1)).toBe('1.0');
    expect(methodOf([1], 'map', true)((value) => value + 1)).toStrictEqual([2]);
    expect(methodOf({ x: 1 }, 'hasOwnProperty', true)('x')).toBe(true);
    expect(methodOf(Math, 'max', true)(1, 2)).toBe(2);
    expect(methodOf(Object, 'keys', true)({ x: 1 })).toStrictEqual(['x']);
    expect(methodOf(Array, 'from', true)([1])).toStrictEqual([1]);
  });

  it('permits actual boxed primitive brands without trusting their string tags', () => {
    expect(methodOf(Reflect.construct(String, ['a']) as string, 'slice', true)(0)).toBe('a');
    expect(methodOf(Reflect.construct(Number, [1]) as number, 'toFixed', true)(1)).toBe('1.0');
    expect(methodOf(Reflect.construct(Boolean, [false]) as boolean, 'valueOf', true)()).toBe(false);
  });

  it('preserves own Object method result types before inherited fallback signatures', () => {
    const receiver = { toString: () => 1, valueOf: () => false };
    const number: number = methodOf(receiver, 'toString', true)();
    const boolean: boolean = methodOf(receiver, 'valueOf', true)();

    expect(number).toBe(1);
    expect(boolean).toBe(false);
  });

  it('preserves own Object method result types through the generated render scope', () => {
    const capture: RenderScope['method'] = method;
    const receiver = { toString: () => 1, valueOf: () => false };
    const number: number = capture(receiver, 'toString')();
    const boolean: boolean = capture(receiver, 'valueOf')();

    expect(number).toBe(1);
    expect(boolean).toBe(false);
  });

  it('permits the canonical symbol key of an array iterator', () => {
    const iterator = methodOf([1], Symbol.iterator, true)();

    expect(iterator.next()).toStrictEqual({ done: false, value: 1 });
  });

  it('converts an evaluated property key once before reading the method and its arguments', () => {
    const events: string[] = [];
    const key = {
      [Symbol.toPrimitive](hint: string) {
        events.push(hint);
        return 'run';
      },
    } as unknown as 'run';
    const receiver = {
      get run() {
        events.push('read');
        return formatted;
      },
    };
    const argument = (): string => {
      events.push('argument');
      return 'ok';
    };

    expect(methodOf(receiver, key, true)(argument())).toBe('ok');
    expect(events).toStrictEqual(['string', 'read', 'argument']);
  });

  it('reads a getter once and retains that function if a later read would return a native alias', () => {
    let reads = 0;
    const receiver = {
      value: 'application',
      get run() {
        reads += 1;
        return reads === 1
          ? function chosen(this: { value: string }) {
              return this.value;
            }
          : Reflect.get<typeof String.prototype, 'padStart'>(String.prototype, 'padStart');
      },
    };

    expect(methodOf(receiver, 'run', true)(20, 'x')).toBe('application');
    expect(reads).toBe(1);
  });

  it('captures the function before arguments run, and preserves its receiver', () => {
    const events: string[] = [];
    const receiver = {
      value: 'before',
      get run() {
        events.push('get');
        return function chosen(this: { value: string }, given: string) {
          return this.value + given;
        };
      },
    };
    const argument = (): string => {
      events.push('argument');
      receiver.value = 'after';
      return '!';
    };

    expect(methodOf(receiver, 'run', true)(argument())).toBe('after!');
    expect(events).toStrictEqual(['get', 'argument']);
  });

  it('delays a non-callable failure until its arguments have run', () => {
    const events: string[] = [];
    const call = methodOf({ run: 1 }, 'run', true) as unknown as (given: string) => unknown;
    const argument = (): string => {
      events.push('argument');
      return 'x';
    };

    expect(() => call(argument())).toThrow(TypeError);
    expect(events).toStrictEqual(['argument']);
  });

  it('throws on a null receiver before evaluating arguments', () => {
    const receiver = null as unknown as { run: (given: string) => unknown };
    const events: string[] = [];
    const argument = (): string => {
      events.push('argument');
      return 'x';
    };

    expect(() => methodOf(receiver, 'run', true)(argument())).toThrow(TypeError);
    expect(events).toStrictEqual([]);
  });

  it('does not restrict an aliased native function outside a site call', () => {
    expect(methodOf(carrier('object'), 'run', false)(20, 'x')).toBe('xxxxx[object Object]');
  });
});
