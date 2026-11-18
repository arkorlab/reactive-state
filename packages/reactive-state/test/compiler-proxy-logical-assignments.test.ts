import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'nullish-assignment-result-holds-the-assigned-proxy',
    source: 'export function make(value?: object) { return (value ??= new Proxy({}, {})); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'or-assignment-result-holds-the-assigned-proxy',
    source: 'export function make(value?: object) { return (value ||= new Proxy({}, {})); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'and-assignment-result-holds-the-assigned-proxy',
    source: 'export function make(value?: object) { return (value &&= new Proxy({}, {})); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'and-assignment-result-holds-the-kept-left-proxy',
    source:
      'export function make(value: object = new Proxy({}, {})) { return (value &&= { ok: true }); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'member-nullish-assignment-result',
    source: 'export function make(box: { v?: object }) { return (box.v ??= new Proxy({}, {})); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'local-or-assignment-result',
    source:
      'export function make() { let v: object | undefined; return (v ||= new Proxy({}, {})); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-constant-of-a-nullish-assignment',
    source: 'let v: object | undefined; export const result = (v ??= new Proxy({}, {}));',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'logical-assignment-inside-a-called-helper',
    source:
      'function lazy(value?: object) { return (value ??= new Proxy({}, {})); } export const result = lazy();',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'plain-assignment-result-pin',
    source: 'export function make(value?: object) { return (value = new Proxy({}, {})); }',
  },
  {
    expected: undefined,
    id: 'nullish-assignment-of-plain-data-pin',
    source: 'export function make(value?: number) { return (value ??= 1); }',
  },
  {
    expected: undefined,
    id: 'or-assignment-of-an-object-literal-pin',
    source: 'export function make(value?: object) { return (value ||= { ok: true }); }',
  },
  {
    expected: undefined,
    id: 'logical-assignment-statement-then-plain-return-pin',
    source: 'export function make(value?: number) { value ??= 1; return value; }',
  },
] as const;

describe('the value of a logical assignment is its left or its assigned right operand', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module returning the value of a logical assignment. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-logical-assignments.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
