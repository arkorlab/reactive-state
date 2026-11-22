import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'let-object-gets-a-proxy-member',
    source:
      'export function make() { let box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-object-gets-a-proxy-at-a-computed-key',
    source:
      'export function make(key: string) { let box: Record<string, unknown> = {}; box[key] = new Proxy({}, {}); return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-array-gets-a-proxy-by-push',
    source:
      'export function make() { let items: unknown[] = []; items.push(new Proxy({}, {})); return items; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-array-gets-a-proxy-by-splice',
    source:
      'export function make() { let items: unknown[] = [1]; items.splice(0, 0, new Proxy({}, {})); return items; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'let-array-gets-a-proxy-by-index',
    source:
      'export function make() { let items: unknown[] = []; items[0] = new Proxy({}, {}); return items[0]; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'member-read-of-the-written-proxy',
    source:
      'export function make() { let box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); return box.p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'deeper-member-write-of-a-proxy',
    source:
      'export function make() { let box: { a: Record<string, unknown> } = { a: {} }; box.a.p = new Proxy({}, {}); return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-assign-of-a-proxy-into-a-let',
    source:
      'export function make() { let box: Record<string, unknown> = {}; Object.assign(box, { p: new Proxy({}, {}) }); return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'var-object-gets-a-proxy-member',
    source:
      'export function make() { var box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'write-in-a-closure-the-function-calls',
    source:
      'export function make() { let box: Record<string, unknown> = {}; const set = () => { box.p = new Proxy({}, {}); }; set(); return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'logical-assignment-to-a-member',
    source:
      'export function make() { let box: Record<string, unknown> = {}; box.p ??= new Proxy({}, {}); return box; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'const-object-gets-a-proxy-member-pin',
    source:
      'export function make() { const box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); return box; }',
  },
  {
    expected: undefined,
    id: 'let-object-gets-plain-members-pin',
    source:
      'export function make() { let box: Record<string, unknown> = {}; box.p = 1; box.q = { a: 2 }; return box; }',
  },
  {
    expected: undefined,
    id: 'let-array-gets-plain-elements-pin',
    source:
      'export function make() { let items: number[] = []; items.push(1, 2); items[2] = 3; return items; }',
  },
  {
    expected: undefined,
    id: 'member-read-of-another-key-pin',
    source:
      'export function make() { let box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); box.q = 1; return box.q; }',
  },
] as const;

describe('a `let` or `var` container holds each value written into it in place', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module returning a mutable container that was written into. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-mutable-writes.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
