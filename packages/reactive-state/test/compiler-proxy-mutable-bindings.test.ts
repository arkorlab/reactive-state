import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'let-assigned-a-proxy-in-a-branch',
    source:
      'export function make(wrap: boolean) { let result = {}; if (wrap) result = new Proxy(result, {}); return result; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-initialised-with-a-proxy',
    source: 'export function make() { let p = new Proxy({}, {}); return p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'var-initialised-with-a-proxy',
    source: 'export function make() { var p = new Proxy({}, {}); return p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-declared-then-assigned-a-proxy',
    source: 'export function make() { let p: object; p = new Proxy({}, {}); return p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-assigned-through-a-logical-assignment',
    source: 'export function make(v?: object) { let p = v; p ??= new Proxy({}, {}); return p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'module-let-assigned-a-proxy-and-read-by-a-function',
    source: 'let p: object = {}; p = new Proxy({}, {}); export function get() { return p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-assigned-in-a-closure-the-function-calls',
    source:
      'let p: object = {}; function set() { p = new Proxy({}, {}); } export function get() { set(); return p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-reassigned-in-a-loop',
    source:
      'export function make(keys: string[]) { let r: object = {}; for (const key of keys) { void key; r = new Proxy(r, {}); } return r; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-held-by-a-container',
    source: 'export function make() { let p = new Proxy({}, {}); return { p }; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-object-member-read',
    source: 'export function make() { let box = { p: new Proxy({}, {}) }; return box.p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-in-a-helper-whose-result-is-exported',
    source: 'function mk() { let p = new Proxy({}, {}); return p; } export const result = mk();',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'const-initialised-with-a-proxy-pin',
    source: 'export function make() { const p = new Proxy({}, {}); return p; }',
  },
  {
    expected: undefined,
    id: 'let-of-plain-objects-pin',
    source: 'export function make() { let p = { a: 1 }; p = { a: 2 }; return p; }',
  },
  {
    expected: undefined,
    id: 'let-of-numbers-pin',
    source: 'export function make(step: number) { let n = 1; n += step; n = n * 2; return n; }',
  },
  {
    expected: undefined,
    id: 'let-counter-in-a-loop-pin',
    source:
      'export function total(values: number[]) { let sum = 0; for (const value of values) { sum += value; } return sum; }',
  },
] as const;

describe('a `let` or `var` binding holds each value it is initialised or assigned', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module returning what a mutable binding holds. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-mutable-bindings.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
