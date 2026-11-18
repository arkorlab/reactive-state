import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJson } from '../src/authority/canonical.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { targetChanged } from './support/local-write-target.ts';

/**
 * An object the code builds under keys it reads from a page's values — a lookup by id, a count by
 * word — is an ordinary program. Which key a page's value is, is not something the compile tells:
 * the authority refuses an object whose prototype a key `__proto__` set where it meets it. A key
 * the code names, a slot of an array, a container the code replaced, and a value no JSON holds are
 * still refused.
 */

interface Item {
  readonly id: string;
  readonly price: number;
}

interface Inputs {
  readonly index: number;
  readonly items: readonly Item[];
  readonly key: string;
}

interface Case {
  readonly id: string;
  readonly body: string;
  readonly changed: boolean;
  readonly run: (inputs: Inputs) => unknown;
}

const INPUTS: Inputs = {
  index: 7,
  items: [
    { id: 'a', price: 1 },
    { id: 'b', price: 2 },
    { id: 'a', price: 3 },
  ],
  key: 'x',
};

function box<T>(value: T): T {
  return value;
}

const CASES: readonly Case[] = [
  {
    body: 'const target: Record<string, Item> = {}; for (const item of items) { target[item.id] = item; } return target;',
    changed: false,
    id: 'lookup-by-id',
    run: ({ items }) => {
      const target = box<Record<string, Item>>({});
      for (const item of items) {
        target[item.id] = item;
      }
      return target;
    },
  },
  {
    body: 'const target: Record<string, number> = {}; for (const item of items) { target[item.id] = (target[item.id] ?? 0) + 1; } return target;',
    changed: false,
    id: 'count-by-key',
    run: ({ items }) => {
      const target = box<Record<string, number>>({});
      for (const item of items) {
        target[item.id] = (target[item.id] ?? 0) + 1;
      }
      return target;
    },
  },
  {
    body: 'const target: Record<string, number[]> = {}; for (const item of items) { (target[item.id] ||= []).push(item.price); } return target;',
    changed: false,
    id: 'group-by-key',
    run: ({ items }) => {
      const target = box<Record<string, number[]>>({});
      for (const item of items) {
        const bucket = target[item.id] ?? [];
        bucket.push(item.price);
        target[item.id] = bucket;
      }
      return target;
    },
  },
  {
    body: 'const target: Record<number, number> = {}; target[index] = 1; return target;',
    changed: false,
    id: 'number-key',
    run: ({ index }) => {
      const target = box<Record<number, number>>({});
      target[index] = 1;
      return target;
    },
  },
  {
    body: "const target: Record<string, number> = {}; target['k' + index] = 1; return target;",
    changed: false,
    id: 'text-key-made-of-a-page-value',
    run: ({ index }) => {
      const target = box<Record<string, number>>({});
      target[`k${String(index)}`] = 1;
      return target;
    },
  },
  {
    body: 'const target = { byId: {} as Record<string, number> }; target.byId[key] = 1; return target;',
    changed: false,
    id: 'nested-lookup',
    run: ({ key }) => {
      const target = box<{ byId: Record<string, number> }>({ byId: {} });
      target.byId[key] = 1;
      return target;
    },
  },
  {
    body: 'const target: Record<string, number> = { a: 1 }; target[key] = NaN; return target;',
    changed: true,
    id: 'pin-value-of-a-dynamic-key-still-checked',
    run: ({ key }) => {
      const target = box<Record<string, number>>({ a: 1 });
      target[key] = NaN;
      return target;
    },
  },
  {
    body: 'const target = [0]; target[index] = 1; return target;',
    changed: true,
    id: 'pin-dynamic-index-of-an-array',
    run: ({ index }) => {
      const target = box([0]);
      target[index] = 1;
      return target;
    },
  },
  {
    body: 'const target = { rows: [0] }; target.rows[index] = 1; return target;',
    changed: true,
    id: 'pin-dynamic-index-of-a-nested-array',
    run: ({ index }) => {
      const target = box({ rows: [0] });
      target.rows[index] = 1;
      return target;
    },
  },
  {
    body: 'const target: { rows: Record<string, number> | number[] } = { rows: {} }; target.rows = []; (target.rows as number[])[index] = 1; return target;',
    changed: true,
    id: 'pin-dynamic-index-of-a-replaced-container',
    run: ({ index }) => {
      const target = box<{ rows: Record<string, number> | number[] }>({ rows: {} });
      target.rows = [];
      target.rows[index] = 1;
      return target;
    },
  },
  {
    body: "const target: Record<string, unknown> = {}; target['__proto__'] = { a: 1 }; return target;",
    changed: true,
    id: 'pin-key-proto-named',
    run: () => {
      const target = box<Record<string, unknown>>({});
      const proto = '__proto__';
      target[proto] = { a: 1 };
      return target;
    },
  },
  {
    body: 'const target: Record<string, number> = {}; target[key] += 1; return target;',
    changed: true,
    id: 'pin-compound-write-of-a-slot-nothing-initializes',
    run: ({ key }) => {
      const target = box<Record<string, number>>({});
      target[key] = NaN;
      return target;
    },
  },
  {
    body: 'const target: Record<PropertyKey, number> = {}; target[Symbol.iterator] = 1; return target;',
    changed: true,
    id: 'symbol-key-well-known',
    run: () => {
      const target = box<Record<PropertyKey, number>>({});
      target[Symbol.iterator] = 1;
      return target;
    },
  },
  {
    body: "const target: Record<PropertyKey, number> = {}; target[Symbol('x')] = 1; return target;",
    changed: true,
    id: 'symbol-key-made-by-the-code',
    run: () => {
      const target = box<Record<PropertyKey, number>>({});
      target[Symbol('x')] = 1;
      return target;
    },
  },
  {
    body: "const key = Symbol.for('k'); const target: Record<PropertyKey, number> = {}; target[key] = 1; return target;",
    changed: true,
    id: 'symbol-key-held-by-a-constant',
    run: () => {
      const key = Symbol.for('k');
      const target = box<Record<PropertyKey, number>>({});
      target[key] = 1;
      return target;
    },
  },
];

describe('local writes under keys read from a page’s values', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ body, changed, run }) => {
    using parsed = parseModule(
      api,
      'dictionary-keys.ts',
      `interface Item { readonly id: string; readonly price: number }\nexport function build(items: readonly Item[], key: string, index: number) { ${body} }\n`,
    );

    expect(isJson(run(INPUTS))).toBe(!changed);
    expect(targetChanged(parsed.sourceFile)).toBe(changed);
  });
});
