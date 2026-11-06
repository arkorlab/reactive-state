import { describe, expect, it } from 'vitest';

import { counted, withinSteps } from '../src/authority/steps.ts';
import { VIEW_LIMITS } from '../src/program.ts';
import {
  cyclicCollections,
  oversizedCollections,
  oversizedMap,
  proxyCollections,
  unsafeCollections,
} from './support/collection-budget.ts';

/** The same collection-slot witnesses run in Node and actual workerd. */
describe('native collection slots at the measurement boundary', () => {
  it.each(oversizedCollections())('counts $name before later site work', ({ make }) => {
    const value = make();

    expect(() => withinSteps(() => counted(value))).toThrow(RangeError);
  });

  it.each(unsafeCollections())('refuses $name held in internal slots', ({ make }) => {
    expect(() => withinSteps(() => counted(make()))).toThrow(TypeError);
  });

  it.each(proxyCollections())('refuses a Proxy $name without inspecting its traps', ({ make }) => {
    const { value, calls } = make();

    expect(() => withinSteps(() => counted(value))).toThrow('Proxy intermediate');
    expect(calls).toStrictEqual([]);
  });

  it.each(cyclicCollections())('terminates a $name and preserves identity', ({ make }) => {
    const value = make();

    expect(withinSteps(() => counted(value))).toBe(value);
  });

  it.each(['Map', 'Set'] as const)('ignores %s size and iteration overrides', (kind) => {
    const calls: string[] = [];
    const value = kind === 'Map' ? new Map([[0, 'ok']]) : new Set(['ok']);
    const descriptors: PropertyDescriptorMap = {};
    for (const key of ['size', 'forEach', 'entries', 'values', Symbol.iterator]) {
      descriptors[key] = {
        get() {
          calls.push(String(key));
          throw new Error('application getter');
        },
      };
    }
    Object.defineProperties(value, descriptors);

    expect(withinSteps(() => counted(value))).toBe(value);
    expect(calls).toStrictEqual([]);
  });

  it.each(['Map', 'Set'] as const)('also counts extra own data on a %s', (kind) => {
    const value = kind === 'Map' ? new Map([[0, 'ok']]) : new Set(['ok']);
    Object.defineProperty(value, 'extra', { value: 'x'.repeat(VIEW_LIMITS.steps) });

    expect(() => withinSteps(() => counted(value))).toThrow(RangeError);
  });

  it('rejects excessive slots before an application spread iterator starts', () => {
    const value = oversizedMap();
    let calls = 0;
    Object.defineProperty(value, Symbol.iterator, {
      value() {
        calls += 1;
        return [][Symbol.iterator]();
      },
    });

    expect(() => withinSteps(() => [...counted(value)])).toThrow(RangeError);
    expect(calls).toBe(0);
  });

  it('keeps ordinary collection identity and does not inspect slots outside a site', () => {
    const values = [new Map([[0, 'ok']]), new Set(['ok']), new Map([[0, new Proxy({}, {})]])];

    for (const value of values) {
      expect(counted(value)).toBe(value);
    }

    expect(withinSteps(() => counted(values[0]))).toBe(values[0]);
    expect(withinSteps(() => counted(values[1]))).toBe(values[1]);
  });
});
