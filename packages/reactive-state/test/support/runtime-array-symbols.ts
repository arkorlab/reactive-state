import { describe, expect, it } from 'vitest';

import { toJson } from '../../src/runtime/json.ts';

/** Fresh prototypes keep each inherited iterator override local to its test case. */
function arrayClass<T>() {
  return class Values extends Array<T> {};
}

/** Identical strict array-copy cases in Node and actual Workers. */
export function runtimeArraySymbols(): void {
  /** Browser JSON copying refuses array metadata before reading an iterator. */
  describe('array symbol keys at the JSON copy boundary', () => {
    it.each([true, false])('refuses an own symbol with enumerable=%s', (enumerable) => {
      const value = ['original'];
      Object.defineProperty(value, Symbol('extra'), { enumerable, value: 'metadata' });

      expect(() => toJson(value)).toThrow('symbol keys');
    });

    it.each(['data', 'getter'] as const)(
      'refuses an own iterator %s before executing it',
      (kind) => {
        const calls: string[] = [];
        const value = ['original'];
        function* iterator() {
          calls.push('iterate');
          yield 'changed';
        }
        Object.defineProperty(
          value,
          Symbol.iterator,
          kind === 'data'
            ? { value: iterator }
            : {
                get() {
                  calls.push('get iterator');
                  return iterator;
                },
              },
        );

        expect(() => toJson(value)).toThrow('symbol keys');
        expect(calls).toStrictEqual([]);
      },
    );

    it('also refuses a symbol-bearing nested array', () => {
      const nested = ['original'];
      Object.defineProperty(nested, Symbol('extra'), { value: 0 });

      expect(() => toJson({ nested })).toThrow('symbol keys');
    });

    it('keeps ordinary JSON copies and their normalization', () => {
      const original = [{ omitted: undefined, value: -0 }];

      const copy = toJson(original);

      expect(copy).toStrictEqual([{ value: 0 }]);
      expect(copy).not.toBe(original);
      expect(Object.is((copy as { value: number }[])[0]?.value, -0)).toBe(false);
    });

    it('keeps array holes refused', () => {
      const value: unknown[] = [];
      value.length = 1;

      expect(() => toJson(value)).toThrow('undefined');
    });

    it('keeps React development metadata accepted', () => {
      const value = ['original'];
      Object.defineProperty(value, '_debugInfo', { value: [], writable: true });

      expect(toJson(value)).toStrictEqual(['original']);
    });

    it('keeps an accessor element refused without reading it', () => {
      const calls: string[] = [];
      const value: unknown[] = [];
      Object.defineProperty(value, '0', {
        enumerable: true,
        get() {
          calls.push('get element');
          return 'changed';
        },
      });

      expect(() => toJson(value)).toThrow('an array with an entry');
      expect(calls).toStrictEqual([]);
    });

    it('keeps symbol-bearing records refused', () => {
      expect(() => toJson({ [Symbol('extra')]: 0 })).toThrow('symbol keys');
    });

    it('copies indexed values without invoking an inherited iterator', () => {
      const calls: string[] = [];
      const value = ['original'];
      const prototype = Object.create(Array.prototype) as Readonly<Record<string, unknown>>;
      Object.defineProperty(prototype, Symbol.iterator, {
        *value() {
          calls.push('iterate');
          yield 'changed';
          yield 'extra';
        },
      });
      Object.setPrototypeOf(value, prototype);
      const text = JSON.stringify(value);
      const expected: unknown = JSON.parse(text);

      const copied = toJson(value);

      expect(copied).toStrictEqual(expected);
      expect(copied).toHaveLength(value.length);
      expect(Object.getPrototypeOf(copied)).toBe(Array.prototype);
      expect(calls).toStrictEqual([]);
    });

    it('never reads a throwing inherited iterator getter', () => {
      const calls: string[] = [];
      const value = ['original'];
      const prototype = Object.create(Array.prototype) as Readonly<Record<string, unknown>>;
      Object.defineProperty(prototype, Symbol.iterator, {
        get() {
          calls.push('get iterator');
          throw new Error('Iterator lookup must not execute.');
        },
      });
      Object.setPrototypeOf(value, prototype);
      const text = JSON.stringify(value);
      const expected: unknown = JSON.parse(text);

      expect(toJson(value)).toStrictEqual(expected);
      expect(calls).toStrictEqual([]);
    });

    it('copies a subclass by its stored indices rather than its iterator', () => {
      const calls: string[] = [];
      const Values = arrayClass<string>();
      Object.defineProperty(Values.prototype, Symbol.iterator, {
        *value() {
          calls.push('iterate');
          yield 'changed';
        },
      });
      const value = new Values('original');
      const text = JSON.stringify(value);
      const expected: unknown = JSON.parse(text);

      expect(toJson(value)).toStrictEqual(expected);
      expect(calls).toStrictEqual([]);
    });

    it('refuses a subclass hole even when its iterator would fill it', () => {
      const calls: string[] = [];
      const Values = arrayClass<string>();
      Object.defineProperty(Values.prototype, Symbol.iterator, {
        *value() {
          calls.push('iterate');
          yield 'filled';
        },
      });
      const value = new Values(1);

      expect(JSON.stringify(value)).toBe('[null]');
      expect(() => toJson(value)).toThrow('undefined');
      expect(calls).toStrictEqual([]);
    });

    it('keeps a normal subclass copy and its JSON normalization', () => {
      const Values = arrayClass<{ readonly value: number; readonly omitted?: undefined }>();
      const value = new Values({ value: -0, omitted: undefined });
      const copied = toJson(value);
      const text = JSON.stringify(value);
      const expected: unknown = JSON.parse(text);

      expect(copied).toStrictEqual(expected);
      expect(copied).not.toBe(value);
      expect(Object.getPrototypeOf(copied)).toBe(Array.prototype);
    });

    it('keeps a subclass indexed getter refused without reading it', () => {
      const calls: string[] = [];
      const Values = arrayClass<string>();
      const value = new Values(1);
      Object.defineProperty(value, '0', {
        enumerable: true,
        get() {
          calls.push('get index');
          return 'changed';
        },
      });

      expect(() => toJson(value)).toThrow('an array with an entry');
      expect(calls).toStrictEqual([]);
    });

    it('keeps the existing nested-array depth boundary', () => {
      const depthLimit = 64;
      let value: unknown = 0;
      for (let depth = 0; depth < depthLimit; depth += 1) {
        value = [value];
      }

      expect(toJson(value)).toStrictEqual(value);
      expect(() => toJson([value])).toThrow('nested more than 64 levels');
    });
  });

  /** Sparse slots remain invalid even where an array prototype would manufacture a value. */
  describe('own array slots at the strict JSON copy boundary', () => {
    it('refuses a hole without reading an inherited index that native property access dispatches', () => {
      let reads = 0;
      const value: unknown[] = [];
      value.length = 1;
      const prototype = Object.create(Array.prototype) as Readonly<Record<string, unknown>>;
      Object.defineProperty(prototype, '0', {
        get() {
          reads += 1;
          return 'manufactured';
        },
      });
      Object.setPrototypeOf(value, prototype);

      expect(Reflect.get(value, '0')).toBe('manufactured');
      expect(reads).toBe(1);

      reads = 0;

      expect(() => toJson(value, 'Input')).toThrow('Input[0] is undefined');
      expect(reads).toBe(0);
      expect(Object.hasOwn(value, 0)).toBe(false);
    });

    it('reports a hole instead of executing a throwing inherited index getter', () => {
      let reads = 0;
      const value: unknown[] = [];
      value.length = 1;
      const prototype = Object.create(Array.prototype) as Readonly<Record<string, unknown>>;
      Object.defineProperty(prototype, '0', {
        get() {
          reads += 1;
          throw new Error('An inherited index must not execute.');
        },
      });
      Object.setPrototypeOf(value, prototype);

      expect(() => toJson(value, 'Input')).toThrow('Input[0] is undefined');
      expect(reads).toBe(0);
    });

    it('refuses a nested subclass hole without accepting its inherited indexed value', () => {
      let reads = 0;
      const Values = arrayClass<string>();
      Object.defineProperty(Values.prototype, '1', {
        get() {
          reads += 1;
          return 'manufactured';
        },
      });
      const value = new Values('original');
      value.length = 2;

      expect(() => toJson({ rows: value }, 'Inputs')).toThrow('Inputs.rows[1] is undefined');
      expect(reads).toBe(0);
      expect(Object.hasOwn(value, 1)).toBe(false);
    });

    it('keeps a hole invalid when an inherited data entry would fill it too', () => {
      const value: unknown[] = [];
      value.length = 1;
      const prototype = Object.create(Array.prototype) as Readonly<Record<string, unknown>>;
      Object.defineProperty(prototype, '0', { value: 'manufactured' });
      Object.setPrototypeOf(value, prototype);

      expect(() => toJson(value, 'Input')).toThrow('Input[0] is undefined');
      expect(Object.hasOwn(value, 0)).toBe(false);
    });

    it('copies dense own values that shadow an inherited getter', () => {
      let reads = 0;
      const value = [{ omitted: undefined, value: -0 }];
      const prototype = Object.create(Array.prototype) as Readonly<Record<string, unknown>>;
      Object.defineProperty(prototype, '0', {
        get() {
          reads += 1;
          throw new Error('The own index shadows this getter.');
        },
      });
      Object.setPrototypeOf(value, prototype);

      expect(toJson(value)).toStrictEqual([{ value: 0 }]);
      expect(reads).toBe(0);
    });

    it('keeps own undefined refused without falling through to an inherited getter', () => {
      let reads = 0;
      const value = [undefined];
      const prototype = Object.create(Array.prototype) as Readonly<Record<string, unknown>>;
      Object.defineProperty(prototype, '0', {
        get() {
          reads += 1;
          return 'manufactured';
        },
      });
      Object.setPrototypeOf(value, prototype);

      expect(() => toJson(value, 'Input')).toThrow('Input[0] is undefined');
      expect(reads).toBe(0);
      expect(Object.hasOwn(value, 0)).toBe(true);
    });
  });
}
