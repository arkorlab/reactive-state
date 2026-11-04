import { describe, expect, it } from 'vitest';

import { frozenJson, isCarriedJson, isJson } from '../../src/authority/canonical.ts';
import { itemsWithin } from '../../src/authority/items.ts';
import { functionsOf } from '../../src/authority/render.ts';
import { rootOf } from '../../src/authority/requests.ts';
import { counted } from '../../src/authority/steps.ts';
import type { Json } from '../../src/program.ts';

const LIMITS = { depth: 64, sparse: 524_288 } as const;

/** An inherited entries override is finite so a broken serializer cannot stall the test. */
function arrayWithEntries(kind: 'changed' | 'throw' | 'getter' = 'changed') {
  const calls: string[] = [];
  class Values extends Array<Json> {}
  const value = new Values('stored');
  Object.defineProperty(
    Values.prototype,
    'entries',
    kind === 'getter'
      ? {
          get() {
            calls.push('get entries');
            throw new Error('Application entries getter');
          },
        }
      : {
          value() {
            calls.push('call entries');
            if (kind === 'throw') {
              throw new Error('Application entries method');
            }
            return [
              [0, 'changed'],
              [1, 'extra'],
            ].values();
          },
        },
  );
  return { calls, value };
}

function root(list: unknown) {
  return { build: 'test', component: 'test/root', props: { list } };
}

/** The production list scope ends before itemsWithin freezes its already-validated item. */
function listed(value: readonly Json[]) {
  const functions = functionsOf({
    inputs: [],
    each: () => counted([{ item: { nested: value }, key: 'row', render: () => value[0] }]),
  });
  if (functions.each === undefined) {
    throw new Error('The fixture defines a list.');
  }
  return itemsWithin('rows', functions.each, {});
}

/** Metadata is rejected during validation without reading source indices or traversal methods. */
function withMetadata(kind: string) {
  const { calls, value } = arrayWithEntries('getter');
  if (kind === 'accessor') {
    Object.defineProperty(value, '0', {
      enumerable: true,
      get() {
        calls.push('get own index');
        return 'changed';
      },
    });
  } else if (kind === 'nonenumerable') {
    Object.defineProperty(value, '0', { enumerable: false });
  } else {
    Object.defineProperty(value, kind === 'symbol' ? Symbol('extra') : 'extra', { value: 1 });
  }
  return { calls, value };
}

/** Identical authority traversal cases in Node and actual Workers. */
export function carriedArrayTraversal(): void {
  /** Authority serialization reads the validated array's own indices without application traversal. */
  describe('carried array traversal after validation', () => {
    it.each(['changed', 'throw', 'getter'] as const)(
      'copies stored nested values without a prototype entries %s',
      (kind) => {
        const { calls, value } = arrayWithEntries(kind);

        expect(isJson({ nested: value })).toBe(true);
        expect(JSON.stringify({ nested: value })).toBe('{"nested":["stored"]}');
        expect(calls).toStrictEqual([]);

        const copied = frozenJson({ nested: value });

        expect(copied).toStrictEqual({ nested: ['stored'] });
        expect(Object.isFrozen(copied.nested)).toBe(true);
        expect(Object.getPrototypeOf(copied.nested)).toBe(Array.prototype);
        expect(calls).toStrictEqual([]);
      },
    );

    it('keeps a generated list item equal to the stored values its render reads', () => {
      const { calls, value } = arrayWithEntries();
      const checked = listed(value);

      expect(checked?.[0]?.item).toStrictEqual({ nested: ['stored'] });
      expect(checked?.[0]?.render()).toBe('stored');
      expect(calls).toStrictEqual([]);
    });

    it('normalizes carried holes without reading their inherited values or entries method', () => {
      const { calls, value } = arrayWithEntries();
      value.length = 0;
      value.length = 2;
      value[1] = 'stored';
      Object.defineProperty(Object.getPrototypeOf(value), '0', {
        get() {
          calls.push('get index');
          throw new Error('A carried hole has no own value.');
        },
      });

      expect(isJson(value)).toBe(false);
      expect(isCarriedJson(value)).toBe(true);
      expect(frozenJson(value)).toStrictEqual([null, 'stored']);
      expect(calls).toStrictEqual([]);
    });

    it('keeps root request props and their subsequent frozen copy on the same indexed JSON', () => {
      const { calls, value } = arrayWithEntries('getter');

      const request = rootOf(root(value));
      const copied = frozenJson(request.props);

      expect(request.props['list']).toStrictEqual(['stored']);
      expect(copied['list']).toStrictEqual(['stored']);
      expect(Object.isFrozen(copied['list'])).toBe(true);
      expect(calls).toStrictEqual([]);
    });

    it('keeps normal nested data, own proto text and signed zero normalization', () => {
      const value = [{ ['__proto__']: 'data', number: -0 }];

      const copied = frozenJson({ value });

      expect(copied).toStrictEqual({ value: [{ ['__proto__']: 'data', number: 0 }] });
      expect(copied.value).not.toBe(value);
      expect(Object.isFrozen(copied.value[0])).toBe(true);
      expect(Object.hasOwn(copied.value[0] ?? {}, '__proto__')).toBe(true);
      expect(Object.is(copied.value[0]?.number, -0)).toBe(false);
    });

    it('keeps own undefined slots carried as null and refused by strict validation', () => {
      const value = [undefined, 'stored'];

      expect(isJson(value)).toBe(false);
      expect(isCarriedJson(value)).toBe(true);
      expect(frozenJson(value as unknown as Json)).toStrictEqual([null, 'stored']);
    });

    it.each(['accessor', 'nonenumerable', 'symbol', 'named'])(
      'keeps array %s metadata refused before serializing',
      (kind) => {
        const { calls, value } = withMetadata(kind);

        expect(isCarriedJson(value)).toBe(false);
        expect(() => rootOf(root(value))).toThrow('props as a JSON object');
        expect(calls).toStrictEqual([]);
      },
    );

    it('keeps the nesting limit before copying a request', () => {
      let value: unknown = null;
      for (let depth = 0; depth < LIMITS.depth; depth += 1) {
        value = [value];
      }

      expect(isCarriedJson(value)).toBe(true);
      expect(isCarriedJson([value])).toBe(false);
    });

    it('keeps oversized carried holes refused before entries or inherited index dispatch', () => {
      const { calls, value } = arrayWithEntries('getter');
      value.length = LIMITS.sparse;

      expect(isCarriedJson(value)).toBe(false);
      expect(() => rootOf(root(value))).toThrow('props as a JSON object');
      expect(calls).toStrictEqual([]);
    });
  });
}
