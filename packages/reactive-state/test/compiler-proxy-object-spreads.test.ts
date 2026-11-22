import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when an exported value or helper result exposes a source `Proxy`. */
const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/**
 * Object spreads copy enumerable spread entries (invoking spread getters) while leaving earlier
 * properties intact whenever the spread does not overwrite their keys.
 */
const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'earlier-proxy-before-unrelated-spread',
    source: 'export const result = { p: new Proxy({}, {}), ...{ extra: 1 } };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'proxy-inside-inline-spread',
    source: 'export const result = { ...{ p: new Proxy({}, {}) } };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'proxy-inside-const-spread',
    source: 'const base = { p: new Proxy({}, {}) }; export const result = { ...base };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'earlier-proxy-before-unknown-spread',
    source:
      'export function make(extra: Record<string, number>) { return { p: new Proxy({}, {}), ...extra }; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'selected-member-before-unrelated-spread',
    source: 'export const result = ({ p: new Proxy({}, {}), ...{ extra: 1 } }).p;',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'selected-member-from-spread-source',
    source: 'export const result = ({ ...{ p: new Proxy({}, {}) } }).p;',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'getter-invoked-by-object-spread',
    source: 'export const result = { ...{ get p() { return new Proxy({}, {}); } } };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'earlier-proxy-before-dynamic-computed-key',
    source: 'export function make(key: string) { return { p: new Proxy({}, {}), [key]: 1 }; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'spreading-proxy-directly',
    source: 'export const result = { ...new Proxy({}, {}) };',
  },
  {
    expected: undefined,
    id: 'earlier-proxy-overwritten-by-spread-pin',
    source: 'export const result = { p: new Proxy({}, {}), ...{ p: 1 } };',
  },
  {
    expected: undefined,
    id: 'spread-proxy-overwritten-by-later-key-pin',
    source: 'export const result = { ...{ p: new Proxy({}, {}) }, p: 1 };',
  },
  {
    expected: undefined,
    id: 'selected-member-overwritten-by-spread-pin',
    source: 'export const result = ({ p: new Proxy({}, {}), ...{ p: 1 } }).p;',
  },
  {
    expected: undefined,
    id: 'unknown-spread-without-source-proxy-pin',
    source: 'export function make(extra: Record<string, number>) { return { ...extra, ok: 1 }; }',
  },
  {
    expected: undefined,
    id: 'unspread-getter-not-invoked-pin',
    source: 'export const result = { ok: 1, get p() { return new Proxy({}, {}); } };',
  },
] as const;

describe('proxy origin detection across object spreads', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a module exporting object-spread expressions. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-object-spreads.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
