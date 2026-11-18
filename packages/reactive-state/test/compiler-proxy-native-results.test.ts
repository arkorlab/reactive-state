import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'object-assign-copies-a-proxy-member-into-a-fresh-target',
    source: 'export function make() { return Object.assign({}, { p: new Proxy({}, {}) }); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-assign-keeps-a-proxy-member-of-its-target',
    source: 'export function make() { return Object.assign({ p: new Proxy({}, {}) }, { q: 1 }); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'member-read-of-an-object-assign-result',
    source: 'export function make() { return Object.assign({}, { p: new Proxy({}, {}) }).p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-assign-of-a-constant-source',
    source:
      'const src = { p: new Proxy({}, {}) }; export function make() { return Object.assign({}, src); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-assign-of-spread-sources-and-a-proxy-member',
    source:
      'export function make(list: object[]) { return Object.assign({}, ...list, { p: new Proxy({}, {}) }); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-constant-of-an-object-assign',
    source: 'export const result = Object.assign({}, { p: new Proxy({}, {}) });',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-assign-in-a-helper-whose-result-is-exported',
    source:
      'function merge() { return Object.assign({}, { p: new Proxy({}, {}) }); } export const result = merge();',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-freeze-gives-back-its-proxy',
    source: 'export function make() { return Object.freeze(new Proxy({}, {})); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-freeze-of-an-object-holding-a-proxy',
    source: 'export function make() { return Object.freeze({ p: new Proxy({}, {}) }); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-seal-gives-back-its-proxy',
    source: 'export function make() { return Object.seal(new Proxy({}, {})); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-set-prototype-of-gives-back-its-proxy',
    source: 'export function make() { return Object.setPrototypeOf(new Proxy({}, {}), null); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-from-entries-of-a-proxy-value',
    source: "export function make() { return Object.fromEntries([['p', new Proxy({}, {})]]); }",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'array-of-a-proxy',
    source: 'export function make() { return Array.of(new Proxy({}, {})); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'array-from-an-array-holding-a-proxy',
    source: 'export function make() { return Array.from([new Proxy({}, {})]); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-create-with-a-proxy-valued-descriptor',
    source:
      'export function make() { return Object.create(null, { p: { value: new Proxy({}, {}) } }); }',
  },
  {
    expected: undefined,
    id: 'object-assign-member-read-of-another-key-pin',
    source:
      'export function make() { return Object.assign({}, { p: new Proxy({}, {}), q: 1 }).q; }',
  },
  {
    expected: undefined,
    id: 'object-assign-of-plain-data-pin',
    source: 'export function make() { return Object.assign({}, { a: 1 }, { b: 2 }); }',
  },
  {
    expected: undefined,
    id: 'object-freeze-of-plain-data-pin',
    source: 'export function make() { return Object.freeze({ a: 1, b: [2] }); }',
  },
  {
    expected: undefined,
    id: 'object-keys-of-plain-data-pin',
    source: 'export function make() { return Object.keys({ a: 1 }); }',
  },
  {
    expected: undefined,
    id: 'math-of-numbers-pin',
    source: 'export function make(a: number, b: number) { return Math.max(a, b); }',
  },
  {
    expected: undefined,
    id: 'string-conversion-of-a-proxy-is-a-scalar-pin',
    source: 'export function make() { return String(new Proxy({}, {})); }',
  },
] as const;

describe('a native call of the global namespaces gives back what it was given', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module returning the result of a native call. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-native-results.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
