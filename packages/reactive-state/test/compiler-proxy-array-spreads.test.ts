import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when an exported value or callable result can expose a `Proxy`. */
const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/**
 * Object spreads of array literals, unmutated array constants, and rest arrays copy present
 * numeric indices as own enumerable string keys, so later properties overwrite matching indices
 * while unexcluded elements and mutated arrays still surface `Proxy` origins.
 */
const CASES = [
  {
    expected: undefined,
    id: 'overwritten-numeric-property-after-inline-array-spread',
    source: 'export const result = { ...[new Proxy({}, {})], 0: 1 };',
  },
  {
    expected: undefined,
    id: 'overwritten-string-key-after-inline-array-spread',
    source: "export const result = { ...[new Proxy({}, {})], '0': 1 };",
  },
  {
    expected: undefined,
    id: 'overwritten-computed-numeric-key-after-inline-array-spread',
    source: "export const result = { ...[new Proxy({}, {}), { ok: 1 }], [0]: 'safe' };",
  },
  {
    expected: undefined,
    id: 'overwritten-after-object-spread-key-on-array-spread',
    source: 'export const result = { ...[new Proxy({}, {})], ...{ 0: 1 } };',
  },
  {
    expected: undefined,
    id: 'overwritten-sparse-hole-index-one-after-array-spread',
    source: "export const result = { ...[, new Proxy({}, {})], 1: 'safe' };",
  },
  {
    expected: undefined,
    id: 'overwritten-nested-tuple-spread-inside-object-spread',
    source: "export const result = { ...[...[new Proxy({}, {})], 'safe'], 0: 1 };",
  },
  {
    expected: undefined,
    id: 'overwritten-unmutated-const-array-in-object-spread',
    source: 'const items = [new Proxy({}, {})]; export const result = { ...items, 0: 1 };',
  },
  {
    expected: undefined,
    id: 'overwritten-conditional-array-in-object-spread',
    source:
      'export function make(flag: boolean) { return { ...(flag ? [new Proxy({}, {})] : [{ ok: 1 }]), 0: 1 }; }',
  },
  {
    expected: undefined,
    id: 'overwritten-helper-returned-array-in-object-spread',
    source:
      'function tuple() { return [new Proxy({}, {})]; } export const result = { ...tuple(), 0: 1 };',
  },
  {
    expected: undefined,
    id: 'overwritten-rest-parameter-in-object-spread',
    source:
      'function pack(...items: unknown[]) { return { ...items, 0: 1 }; } export const result = pack(new Proxy({}, {}));',
  },
  {
    expected: undefined,
    id: 'overwritten-field-on-indexed-rest-parameter-spread',
    source:
      'function pack(...items: Record<string, unknown>[]) { return { ...items[0], p: 1 }; } export const result = pack({ p: new Proxy({}, {}) });',
  },
  {
    expected: undefined,
    id: 'earlier-numeric-proxy-overwritten-by-later-inline-array-spread',
    source: 'export const result = { 0: new Proxy({}, {}), ...[1] };',
  },
  {
    expected: undefined,
    id: 'empty-string-key-on-object-spread-array-is-not-index-zero',
    source: "export const result = ({ ...[new Proxy({}, {})] } as Record<string, unknown>)[''];",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'mutated-rest-array-shifted-before-object-spread',
    source:
      "function pack(...items: unknown[]) { items.unshift('safe'); return { ...items, 0: 1 }; } export const result = pack(new Proxy({}, {}));",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'unoverwritten-array-spread-still-refused-pin',
    source: 'export const result = { ...[new Proxy({}, {})] };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'second-element-survives-when-only-zero-overwritten-pin',
    source: "export const result = { ...['safe', new Proxy({}, {})], 0: 1 };",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'sparse-hole-at-zero-leaves-proxy-at-one-surviving-pin',
    source: 'export const result = { ...[, new Proxy({}, {})], 0: 1 };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'mutated-const-array-shifted-before-object-spread-refused-pin',
    source:
      "export function make() { const items: unknown[] = [new Proxy({}, {})]; items.unshift('safe'); return { ...items, 0: 1 }; }",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'escaped-const-array-handed-to-callee-before-object-spread-refused-pin',
    source:
      'export function make(step: (list: unknown[]) => void) { const items: unknown[] = [new Proxy({}, {})]; step(items); return { ...items, 0: 1 }; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'shared-const-array-excluded-once-still-refused-when-exported-whole-pin',
    source:
      'const items = [new Proxy({}, {})]; export const safe = { ...items, 0: 1 }; export const raw = items;',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'nested-proxy-property-inside-surviving-array-element-refused-pin',
    source: 'export const result = { ...[{ p: new Proxy({}, {}) }], 1: 1 };',
  },
  {
    expected: undefined,
    id: 'unspread-getter-inside-surviving-array-element-not-invoked-pin',
    source: 'export const result = { ...[{ get p() { return new Proxy({}, {}); } }] };',
  },
] as const;

describe('proxy origin detection across array object spreads', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a module spreading arrays into object literals. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-array-spreads.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
