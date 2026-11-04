import { describe, expect, it } from 'vitest';

import { isCarriedJson } from '../../src/authority/canonical.ts';
import { rendered, SCOPE } from '../../src/authority/tree.ts';
import { actionRef, type Json, moduleRef, type RenderedAction } from '../../src/program.ts';

/** The production render scope keeps element and module props as carried JSON. */
function payload(kind: string, value: unknown): Json | undefined {
  const node = rendered(
    SCOPE.h(kind === 'element' ? 'div' : moduleRef('test/view', 'default'), { payload: value }),
  );
  return (node as { readonly props: Readonly<Record<string, Json>> }).props['payload'];
}

/** Finite inherited hooks expose dispatch without stalling a broken implementation. */
function inherited(kind: string) {
  const calls: string[] = [];
  class Values extends Array<Json> {}
  const value = new Values(2);
  value[1] = 'stored';
  if (kind === 'iterator') {
    Object.defineProperty(Values.prototype, Symbol.iterator, {
      value() {
        calls.push('iterator');
        return ['manufactured'].values();
      },
    });
  } else if (kind === 'toJSON') {
    Object.defineProperty(Values.prototype, 'toJSON', {
      value() {
        calls.push('toJSON');
        return ['manufactured'];
      },
    });
  } else {
    Object.defineProperty(Values.prototype, '0', {
      get() {
        calls.push('index');
        if (kind === 'throw') throw new Error('An inherited hole getter must not run.');
        return 'manufactured';
      },
    });
  }
  return { calls, value };
}

/** Identical checks run against Node and the actual Workers implementation. */
export function carriedRenderProps(): void {
  describe('carried action-bound data', () => {
    it.each(['value', 'throw', 'iterator', 'toJSON'])(
      'copies repeated sparse bound arguments without inherited %s dispatch',
      (hook) => {
        const { calls, value } = inherited(hook);
        const before = Object.getOwnPropertyDescriptors(value);
        const reference = actionRef('test/operations', 'update', [value, value, 1]);
        const node = rendered(SCOPE.h('form', { action: reference }));
        const props = (node as { readonly props: Readonly<Record<string, unknown>> }).props;
        const kept = props['action'] as RenderedAction;

        expect(kept).toStrictEqual({
          bound: [[null, 'stored'], [null, 'stored'], 1],
          kind: 'action',
          module: 'test/operations',
          name: 'update',
        });
        expect(kept.bound[0]).not.toBe(kept.bound[1]);
        expect(calls).toStrictEqual([]);
        expect(Object.getOwnPropertyDescriptors(value)).toStrictEqual(before);
      },
    );
  });

  describe.each(['element', 'module'])('carried %s props', (kind) => {
    it.each(['value', 'throw', 'iterator', 'toJSON'])(
      'copies sparse nested data without inherited %s dispatch',
      (hook) => {
        const { calls, value } = inherited(hook);
        const before = Object.getOwnPropertyDescriptors(value);

        expect(isCarriedJson({ nested: value })).toBe(true);
        expect(payload(kind, { nested: value })).toStrictEqual({ nested: [null, 'stored'] });
        expect(calls).toStrictEqual([]);
        expect(Object.getOwnPropertyDescriptors(value)).toStrictEqual(before);
      },
    );

    it('retains own data order and proto-named keys', () => {
      const value = { z: 1, a: 2, ['__proto__']: 'data' };
      const kept = payload(kind, value) as Readonly<Record<string, Json>>;

      expect(kept).toStrictEqual(value);
      expect(Object.keys(kept)).toStrictEqual(['z', 'a', '__proto__']);
      expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
      expect(Object.hasOwn(kept, '__proto__')).toBe(true);
    });

    it('keeps undefined omission, indexed null and signed-zero normalization', () => {
      const values: (Json | undefined)[] = [];
      values.length = 2;
      values[1] = undefined;

      expect(payload(kind, { gone: undefined, values, zero: -0 })).toStrictEqual({
        values: [null, null],
        zero: 0,
      });
    });

    it('still refuses nested JSON shaped as a rendered node', () => {
      expect(() => payload(kind, { nested: [{ kind: 'element' }] })).toThrow(
        'reads as something rendered',
      );
    });
  });
}
