import { describe, expect, it } from 'vitest';

import { isCarriedJson, isJson } from '../../src/authority/canonical.ts';
import {
  fieldOperationOf,
  operationCallOf,
  rootOf,
  viewRequestOf,
} from '../../src/authority/requests.ts';

const OVERSIZED_SPARSE_LENGTH = 524_288;

/** A request array can inherit values while keeping no own value at its missing index. */
function inheritedArray(read: () => unknown, length = 1): unknown[] {
  const list: unknown[] = [];
  list.length = length;
  const prototype = Object.create(Array.prototype) as unknown[];
  Object.defineProperty(prototype, '0', { configurable: true, get: read });
  Object.setPrototypeOf(list, prototype);
  return list;
}

function root(list: unknown) {
  return { build: 'test', component: 'test/root', props: { list } };
}

function field(list: unknown) {
  return {
    binding: 'binding',
    operationId: 'op:1',
    updaterId: 'update',
    captures: { list },
  };
}

function operation(list: unknown) {
  return {
    args: [{ json: { list } }],
    build: 'test',
    module: 'domain/actions',
    name: 'save',
    operationId: 'op:1',
  };
}

const REQUESTS: readonly {
  readonly name: string;
  readonly read: (list: unknown) => unknown;
  readonly expected?: unknown;
}[] = [
  { name: 'root props', read: (list: unknown) => rootOf(root(list)).props['list'] },
  {
    name: 'view inputs',
    read: (list: unknown) => {
      return viewRequestOf({
        subscription: 'frame',
        view: { part: { rows: { list } } },
      }).view['part']?.['rows']?.['list'];
    },
  },
  {
    name: 'captured values',
    read: (list: unknown) => fieldOperationOf(field(list)).captures?.['list'],
  },
  {
    name: 'operation arguments',
    read: (list: unknown) => operationCallOf(operation(list)).args,
    expected: [{ json: { list: [null] } }],
  },
];

/** Identical transport checks registered in each native test runtime. */
export function carriedArrayPrototypeChecks(): void {
  describe('own array entries in carried request validation', () => {
    it('does not dispatch an inherited index that native every would read', () => {
      let reads = 0;
      const list = inheritedArray(() => {
        reads += 1;
        throw new Error('inherited index');
      });

      expect(Object.hasOwn(list, 0)).toBe(false);
      expect(() => Array.prototype.every.call(list, () => true)).toThrow('inherited index');
      expect(reads).toBe(1);

      reads = 0;

      expect(isCarriedJson(list)).toBe(true);
      expect(reads).toBe(0);
    });

    it.each(REQUESTS)(
      'normalizes a hole in $name without invoking its inherited getter',
      ({ read, expected }) => {
        let reads = 0;
        const list = inheritedArray(() => {
          reads += 1;
          throw new Error('inherited request index');
        });

        expect(read(list)).toStrictEqual(expected ?? [null]);
        expect(reads).toBe(0);
        expect(Object.hasOwn(list, 0)).toBe(false);
      },
    );

    it('ignores a non-JSON inherited value that is absent from the array itself', () => {
      let reads = 0;
      const list = inheritedArray(() => {
        reads += 1;
        return 1n;
      });

      expect(rootOf(root(list)).props['list']).toStrictEqual([null]);
      expect(reads).toBe(0);
    });

    it('keeps later own entries unchanged instead of executing an earlier inherited getter', () => {
      let reads = 0;
      const list = inheritedArray(() => {
        reads += 1;
        list[1] = 'changed';
        return null;
      }, 2);
      list[1] = 'original';

      expect(rootOf(root(list)).props['list']).toStrictEqual([null, 'original']);
      expect(list[1]).toBe('original');
      expect(reads).toBe(0);
    });

    it('does not select an inherited every method as the request validator', () => {
      const list: unknown[] = [];
      list.length = 1;
      const prototype = Object.create(Array.prototype) as unknown[];
      Object.defineProperty(prototype, 'every', {
        value() {
          throw new Error('inherited every');
        },
      });
      Object.setPrototypeOf(list, prototype);

      expect(isCarriedJson(list)).toBe(true);
      expect(rootOf(root(list)).props['list']).toStrictEqual([null]);
    });

    it('validates an own data entry that shadows an inherited getter', () => {
      let reads = 0;
      const list = inheritedArray(() => {
        reads += 1;
        throw new Error('shadowed getter');
      });
      Object.defineProperty(list, '0', { enumerable: true, value: { nested: [true] } });

      expect(isJson(list)).toBe(true);
      expect(rootOf(root(list)).props['list']).toStrictEqual([{ nested: [true] }]);
      expect(reads).toBe(0);
    });

    it('keeps strict sparse arrays refused before inspecting inherited indices', () => {
      let reads = 0;
      const list = inheritedArray(() => {
        reads += 1;
        throw new Error('strict inherited index');
      });

      expect(isJson(list)).toBe(false);
      expect(reads).toBe(0);
    });

    it('keeps an own accessor refused without executing it', () => {
      let reads = 0;
      const list: unknown[] = [];
      Object.defineProperty(list, '0', {
        enumerable: true,
        get() {
          reads += 1;
          return null;
        },
      });

      expect(isCarriedJson(list)).toBe(false);
      expect(() => rootOf(root(list))).toThrow('props as a JSON object');
      expect(reads).toBe(0);
    });

    it('keeps oversized hole expansion refused before reading inherited indices', () => {
      let reads = 0;
      const list = inheritedArray(() => {
        reads += 1;
        throw new Error('oversized inherited index');
      }, OVERSIZED_SPARSE_LENGTH);

      expect(isCarriedJson(list)).toBe(false);
      expect(() => rootOf(root(list))).toThrow('props as a JSON object');
      expect(reads).toBe(0);
    });
  });
}
