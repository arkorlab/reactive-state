import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJson } from '../src/authority/canonical.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { targetChanged } from './support/local-write-target.ts';

/**
 * A name a loop or a destructuring binds to an element or a member of a constant holds what the
 * constant writes there, so a write through it is read as a write into that value: of an object
 * the code writes, a key is an entry — `for (const item of target) { item.done = true }`,
 * `const [first] = target; first.x = 1` are ordinary programs — and of an array, or of a value
 * the code does not show, the refusals of an array's writes stay (`canonical.ts`'s `isJson`
 * refuses a sparse array and an array with a key beside its elements).
 */

interface Case {
  readonly id: string;
  readonly body: string;
  readonly changed: boolean;
  readonly run: () => unknown;
}

const SPARSE_INDEX = 3;
const HUGE = 1e200;
const SHARED = 5;

function box<T>(value: T): T {
  return value;
}

interface Extra {
  extra?: number;
}

type Meta = Record<string, unknown> | unknown[];

const CASES: readonly Case[] = [
  {
    body: 'const target = [{ done: false }, { done: false }]; for (const item of target) { item.done = true; } return target;',
    changed: false,
    id: 'loop-variable-key-written',
    run: () => {
      const target = box([{ done: false }, { done: false }]);
      for (const item of target) {
        item.done = true;
      }
      return target;
    },
  },
  {
    body: 'const target = [{ count: 0 }, { count: 0 }]; for (const item of target) { item.count += 1; } return target;',
    changed: false,
    id: 'loop-variable-counter',
    run: () => {
      const target = box([{ count: 0 }, { count: 0 }]);
      for (const item of target) {
        item.count += 1;
      }
      return target;
    },
  },
  {
    body: 'const target = [{ count: 0 }]; for (const item of target) { item.count++; } return target;',
    changed: false,
    id: 'loop-variable-increment',
    run: () => {
      const target = box([{ count: 0 }]);
      for (const item of target) {
        item.count += 1;
      }
      return target;
    },
  },
  {
    body: 'const target: { a: number; b?: number }[] = [{ a: 1 }]; for (const item of target) { Object.assign(item, { b: 2 }); } return target;',
    changed: false,
    id: 'loop-variable-assigned-into',
    run: () => {
      const target = box<{ a: number; b?: number }[]>([{ a: 1 }]);
      for (const item of target) {
        Object.assign(item, { b: 2 });
      }
      return target;
    },
  },
  {
    body: 'const target: { a?: number; b: number }[] = [{ a: 1, b: 2 }]; for (const item of target) { delete item.a; } return target;',
    changed: false,
    id: 'loop-variable-deleted-from',
    run: () => {
      const target = box<{ a?: number; b: number }[]>([{ a: 1, b: 2 }]);
      for (const item of target) {
        delete item.a;
      }
      return target;
    },
  },
  {
    body: 'const target = [{ x: 0 }]; const [first] = target; first.x = 1; return target;',
    changed: false,
    id: 'array-destructured-element-keyed',
    run: () => {
      const target = box<[{ x: number }]>([{ x: 0 }]);
      const [first] = target;
      first.x = 1;
      return target;
    },
  },
  {
    body: 'const target = { a: { x: 0 } }; const { a } = target; a.x = 1; return target;',
    changed: false,
    id: 'object-destructured-member-keyed',
    run: () => {
      const target = box({ a: { x: 0 } });
      const { a } = target;
      a.x = 1;
      return target;
    },
  },
  {
    body: 'const target = [{ inner: { x: 0 } }]; for (const { inner } of target) { inner.x = 1; } return target;',
    changed: false,
    id: 'loop-destructured-member-keyed',
    run: () => {
      const target = box([{ inner: { x: 0 } }]);
      for (const { inner } of target) {
        inner.x = 1;
      }
      return target;
    },
  },
  {
    body: 'const target = { a: { n: 0 } }; const { a } = target; a.n += 1; return target;',
    changed: false,
    id: 'destructured-member-counter',
    run: () => {
      const target = box({ a: { n: 0 } });
      const { a } = target;
      a.n += 1;
      return target;
    },
  },
  {
    body: 'const target = [{ done: false }]; for (const item of target) { item.done = NaN; } return target;',
    changed: true,
    id: 'pin-value-written-through-a-loop-variable-still-checked',
    run: () => {
      const target = box<{ done: number | boolean }[]>([{ done: false }]);
      for (const item of target) {
        item.done = NaN;
      }
      return target;
    },
  },
  {
    body: 'const target = [[0, 1]]; for (const item of target) { (item as unknown as { extra: number }).extra = 5; } return target;',
    changed: true,
    id: 'pin-named-key-through-a-loop-variable-over-arrays',
    run: () => {
      const target = box([[0, 1]]);
      for (const item of target) {
        Object.assign(item, { extra: SHARED });
      }
      return target;
    },
  },
  {
    body: 'const target: unknown[] = [{ a: 1 }, [0]]; for (const item of target) { (item as { extra: number }).extra = 1; } return target;',
    changed: true,
    id: 'pin-named-key-through-a-loop-variable-over-mixed-elements',
    run: () => {
      const target = box<unknown[]>([{ a: 1 }, [0]]);
      for (const item of target) {
        (item as Extra).extra = 1;
      }
      return target;
    },
  },
  {
    body: 'const target = { items: [0] }; const { items } = target; items[3] = 1; return target;',
    changed: true,
    id: 'pin-hole-through-a-destructured-array',
    run: () => {
      const target = box({ items: [0] });
      const { items } = target;
      items[SPARSE_INDEX] = 1;
      return target;
    },
  },
  {
    body: 'const target = [{ n: 1e200 }]; for (const item of target) { item.n *= 1e200; } return target;',
    changed: true,
    id: 'pin-product-through-a-loop-variable-overflows',
    run: () => {
      const target = box([{ n: HUGE }]);
      for (const item of target) {
        item.n *= HUGE;
      }
      return target;
    },
  },
  {
    body: 'const target: { a: { n?: number } } = { a: {} }; const { a } = target; (a.n as number)++; return target;',
    changed: true,
    id: 'pin-counter-nothing-initializes-through-a-destructured-member',
    run: () => {
      const target = box<{ a: { n: number } }>({ a: {} as { n: number } });
      const { a } = target;
      a.n += 1;
      return target;
    },
  },
  {
    body: 'const target: { meta: object }[] = [{ meta: {} }, { meta: [] }]; for (const row of target) { Object.assign(row.meta, { extra: 1 }); } return target;',
    changed: true,
    id: 'assigned-into-a-member-of-elements-of-different-shapes',
    run: () => {
      const target = box<{ meta: Meta }[]>([{ meta: {} }, { meta: [] }]);
      for (const row of target) {
        Object.assign(row.meta, { extra: 1 });
      }
      return target;
    },
  },
  {
    body: 'const target: { meta: object }[] = [{ meta: {} }, { meta: [] }]; for (const row of target) { (row.meta as { extra?: number }).extra = 1; } return target;',
    changed: true,
    id: 'key-written-into-a-member-of-elements-of-different-shapes',
    run: () => {
      const target = box<{ meta: Meta }[]>([{ meta: {} }, { meta: [] }]);
      for (const row of target) {
        (row.meta as Extra).extra = 1;
      }
      return target;
    },
  },
  {
    body: 'const target: { meta: object }[] = [{ meta: {} }, { meta: {} }]; for (const row of target) { Object.assign(row.meta, { extra: 1 }); } return target;',
    changed: false,
    id: 'assigned-into-a-member-of-elements-of-one-shape',
    run: () => {
      const target = box<{ meta: Meta }[]>([{ meta: {} }, { meta: {} }]);
      for (const row of target) {
        Object.assign(row.meta, { extra: 1 });
      }
      return target;
    },
  },
  {
    body: 'const target = [{ meta: { a: 1 } as { a?: number; b?: number; c?: number } }, { meta: { b: 2 } }]; for (const row of target) { row.meta.c = 3; } return target;',
    changed: false,
    id: 'key-written-into-members-of-elements-that-differ-in-keys-only',
    run: () => {
      const target = box<{ meta: { a?: number; b?: number; c?: number } }[]>([
        { meta: { a: 1 } },
        { meta: { b: 2 } },
      ]);
      for (const row of target) {
        row.meta.c = 3;
      }
      return target;
    },
  },
];

describe('local writes through names a loop or a destructuring binds', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ body, changed, run }) => {
    using parsed = parseModule(api, 'bound-names.ts', `export function build() { ${body} }\n`);

    expect(isJson(run())).toBe(!changed);
    expect(targetChanged(parsed.sourceFile)).toBe(changed);
  });
});
