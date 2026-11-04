import { describe, expect, it } from 'vitest';

import { viewRequestOf } from '../../src/authority/requests.ts';
import { VIEW_LIMITS } from '../../src/program.ts';

const MAX_INPUT_ARRAYS = 63;

function requested(view: unknown) {
  return viewRequestOf({ subscription: 'frame', view });
}

/** A container accessor would supply valid inputs if request traversal dispatched it. */
function accessorContainer(level: 'view' | 'part', throwing: boolean, enumerable = true) {
  const calls: string[] = [];
  const container = {};
  Object.defineProperty(container, level === 'view' ? 'part' : 'rows', {
    enumerable,
    get() {
      calls.push(level);
      if (throwing) {
        throw new Error('Application container getter');
      }
      return level === 'view' ? { rows: { text: 'stored' } } : { text: 'stored' };
    },
  });
  return { calls, view: level === 'view' ? container : { part: container } };
}

/** The same direct request validation cases run in Node and inside actual Workers. */
export function requestViewContainers(): void {
  describe('request view containers without accessor dispatch', () => {
    it.each([
      { level: 'view', throwing: false },
      { level: 'view', throwing: true },
      { level: 'part', throwing: false },
      { level: 'part', throwing: true },
    ] as const)('rejects a $level getter before reading it, throwing $throwing', (fixture) => {
      const { calls, view } = accessorContainer(fixture.level, fixture.throwing);

      expect(() => requested(view)).toThrow('Name the frame');
      expect(calls).toStrictEqual([]);
    });

    it.each(['view', 'part'] as const)('rejects a nonenumerable %s accessor unread', (level) => {
      const { calls, view } = accessorContainer(level, true, false);

      expect(() => requested(view)).toThrow('Name the frame');
      expect(calls).toStrictEqual([]);
    });

    it.each(['view', 'part'] as const)('rejects own symbol metadata on a %s container', (level) => {
      const container = { [Symbol('extra')]: 'not carried' };
      const view = level === 'view' ? container : { part: container };

      expect(() => requested(view)).toThrow('Name the frame');
    });

    it('keeps a site input accessor rejected without evaluating it', () => {
      const calls: string[] = [];
      const inputs = {
        get text() {
          calls.push('inputs');
          return 'changed';
        },
      };

      expect(() => requested({ part: { rows: inputs } })).toThrow('Name the frame');
      expect(calls).toStrictEqual([]);
    });

    it.each([null, { part: null }, { part: { rows: null } }])(
      'keeps a null container invalid: %j',
      (view) => {
        expect(() => requested(view)).toThrow('Name the frame');
      },
    );

    it.each([{}, { part: {} }])('keeps an empty requested view or part: %j', (view) => {
      expect(requested(view)).toStrictEqual({ subscription: 'frame', view });
    });

    it('normalizes nested holes without reading inherited array indices', () => {
      const calls: string[] = [];
      class Sparse extends Array<unknown> {}
      const values = new Sparse(2);
      values[1] = undefined;
      Object.defineProperty(Sparse.prototype, '0', {
        get() {
          calls.push('inherited index');
          throw new Error('Application hole getter');
        },
      });

      expect(requested({ part: { rows: { values } } }).view).toStrictEqual({
        part: { rows: { values: [null, null] } },
      });
      expect(calls).toStrictEqual([]);
      expect(Object.hasOwn(values, '0')).toBe(false);
    });

    it('keeps own proto keys, null values, omitted undefined and normalized zero', () => {
      const inputs = { ['__proto__']: { safe: true }, omitted: undefined, empty: null, zero: -0 };
      const part = Object.assign(Object.create(null) as Record<string, unknown>, { rows: inputs });
      const view = Object.assign(Object.create(null) as Record<string, unknown>, { part });

      expect(requested(view).view).toStrictEqual({
        part: { rows: { ['__proto__']: { safe: true }, empty: null, zero: 0 } },
      });
      expect(Object.hasOwn(inputs, '__proto__')).toBe(true);
      expect(Object.is(inputs.zero, -0)).toBe(true);
    });

    it('keeps the existing depth boundary measured from each site input', () => {
      let value: unknown = null;
      for (let depth = 0; depth < MAX_INPUT_ARRAYS; depth += 1) {
        value = [value];
      }
      const view = { part: { rows: { value } } };

      expect(requested(view).view).toStrictEqual(view);
      expect(() => requested({ part: { rows: { value: [value] } } })).toThrow('Name the frame');
    });

    it('keeps the complete view byte budget before normalizing it', () => {
      const overhead = JSON.stringify({ part: { rows: { text: '' } } }).length;
      const text = 'x'.repeat(VIEW_LIMITS.bytes - overhead);
      const view = { part: { rows: { text } } };

      expect(requested(view).view).toStrictEqual(view);
      expect(() => requested({ part: { rows: { text: `${text}x` } } })).toThrow('Name the frame');
    });
  });
}
