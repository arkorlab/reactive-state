import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when an exported value or callable result can expose a `Proxy`. */
const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/**
 * Unconditional destructuring and single-entry or guaranteed-non-empty loop-header writes replace
 * incoming/default parameter origins while still tracing Proxies written by those patterns and
 * retaining incoming origins across empty or possibly-empty iterables.
 */
const CASES = [
  {
    expected: undefined,
    id: 'array-destructuring-reassignment-overrides-proxy-default',
    source:
      'export function make(value: Record<string, unknown> = new Proxy({}, {})) { [value] = [{ ok: 1 }]; return value; }',
  },
  {
    expected: undefined,
    id: 'object-shorthand-destructuring-overrides-proxy-default',
    source:
      'export function make(value: Record<string, unknown> = new Proxy({}, {})) { ({ value } = { value: { ok: 1 } }); return value; }',
  },
  {
    expected: undefined,
    id: 'object-aliased-destructuring-overrides-passed-proxy-argument',
    source:
      'function reset(value: unknown) { ({ safe: value } = { safe: { ok: 1 } }); return value; } export const result = reset(new Proxy({}, {}));',
  },
  {
    expected: undefined,
    id: 'hoisted-var-destructuring-overrides-proxy-default',
    source:
      'export function make(value: Record<string, unknown> = new Proxy({}, {})) { var { value } = { value: { ok: 1 } }; return value; }',
  },
  {
    expected: undefined,
    id: 'for-initializer-reassignment-overrides-proxy-default',
    source:
      'export function make(value: Record<string, unknown> = new Proxy({}, {})) { for (value = { ok: 1 }; false; ) { void value; } return value; }',
  },
  {
    expected: undefined,
    id: 'non-empty-for-of-reassignment-overrides-proxy-default',
    source:
      'export function make(value: Record<string, unknown> = new Proxy({}, {})) { for (value of [{ ok: 1 }]) { void value; } return value; }',
  },
  {
    expected: undefined,
    id: 'for-of-body-read-uses-loop-header-reassignment',
    source:
      'export function make(items: Record<string, unknown>[], value: Record<string, unknown> = new Proxy({}, {})) { for (value of items) { return value; } return { ok: 1 }; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'array-destructuring-assigning-proxy-is-refused',
    source: 'export function make(value: unknown) { [value] = [new Proxy({}, {})]; return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'object-destructuring-assigning-proxy-is-refused',
    source:
      'export function make(value: unknown) { ({ p: value } = { p: new Proxy({}, {}) }); return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'for-of-header-assigning-proxy-is-refused',
    source:
      'export function make(value: unknown) { for (value of [new Proxy({}, {})]) { void value; } return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'empty-for-of-iterable-retains-proxy-default-pin',
    source:
      'export function make(value: Record<string, unknown> = new Proxy({}, {})) { for (value of []) { void value; } return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'unknown-for-of-iterable-after-loop-retains-proxy-default-pin',
    source:
      'export function make(items: Record<string, unknown>[], value: Record<string, unknown> = new Proxy({}, {})) { for (value of items) { void value; } return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'conditional-destructuring-reassignment-retains-proxy-default-pin',
    source:
      'export function make(flag: boolean, value: Record<string, unknown> = new Proxy({}, {})) { if (flag) { [value] = [{ ok: 1 }]; } return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'self-referential-destructuring-reassignment-retains-proxy-default-pin',
    source:
      'export function make(value: Record<string, unknown> = new Proxy({}, {})) { [value] = [value]; return value; }',
  },
] as const;

describe('destructuring and loop-header parameter reassignments in proxy origin checks', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a module reassigning parameters via patterns or loop headers. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-parameter-destructuring.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
