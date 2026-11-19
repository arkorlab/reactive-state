import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when an exported value or callable result can expose a `Proxy`. */
const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/**
 * Non-dominating parameter writes must retain incoming argument and default initializer origins
 * alongside unshadowed parameter assignments and hoisted `var` initializers, while excluding
 * shadowed inner lexical bindings and nested function `var` declarations.
 */
const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'conditional-write-preserves-proxy-default',
    source:
      'export function make(flag: boolean, value: Record<string, unknown> = new Proxy({}, {})) { if (flag) { value = {}; } return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'conditional-write-preserves-arrow-proxy-default',
    source:
      'export const make = (flag: boolean, value: Record<string, unknown> = new Proxy({}, {})) => { if (flag) { value = { ok: 1 }; } return value; };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'conditional-write-preserves-passed-proxy-argument',
    source:
      'function maybeReset(flag: boolean, value: Record<string, unknown>) { if (flag) { value = {}; } return value; } export const result = maybeReset(false, new Proxy({}, {}));',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'nullish-assignment-to-parameter-detects-proxy',
    source:
      'export function make(value?: Record<string, unknown>) { value ??= new Proxy({}, {}); return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'conditional-hoisted-var-initializer-detects-proxy',
    source:
      'export function make(flag: boolean, value: Record<string, unknown>) { if (flag) { var value: Record<string, unknown> = new Proxy({}, {}); } return value; }',
  },
  {
    expected: undefined,
    id: 'shadowed-block-const-excluded-after-conditional-write',
    source:
      'export function make(flag: boolean, value: Record<string, unknown>) { if (flag) { value = {}; } { const value = new Proxy({}, {}); void value; } return value; }',
  },
  {
    expected: undefined,
    id: 'shadowed-block-let-and-reassignment-excluded',
    source:
      'export function make(flag: boolean, value: Record<string, unknown>) { if (flag) { value = {}; } { let value: Record<string, unknown> = new Proxy({}, {}); value = new Proxy({}, {}); void value; } return value; }',
  },
  {
    expected: undefined,
    id: 'shadowed-for-initializer-let-excluded',
    source:
      'export function make(flag: boolean, value: Record<string, unknown>) { if (flag) { value = {}; } for (let value: Record<string, unknown> = new Proxy({}, {}); false; ) { void value; } return value; }',
  },
  {
    expected: undefined,
    id: 'shadowed-for-of-const-pin',
    source:
      'export function make(flag: boolean, value: Record<string, unknown>) { if (flag) { value = {}; } for (const value of [new Proxy({}, {})]) { void value; } return value; }',
  },
  {
    expected: undefined,
    id: 'nested-function-var-excluded-after-conditional-write',
    source:
      'export function make(flag: boolean, value: Record<string, unknown>) { if (flag) { value = {}; } const helper = () => { var value = new Proxy({}, {}); return value; }; void helper; return value; }',
  },
  {
    expected: undefined,
    id: 'definite-replacement-overrides-proxy-default-pin',
    source:
      'export function make(value: Record<string, unknown> = new Proxy({}, {})) { value = { ok: 1 }; return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'conditional-proxy-write-still-refused-pin',
    source:
      'export function make(flag: boolean, value: Record<string, unknown>) { if (flag) { value = new Proxy({}, {}); } return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'closure-write-to-outer-parameter-still-refused-pin',
    source:
      'export function make(value: Record<string, unknown>) { const assign = () => { value = new Proxy({}, {}); }; assign(); return value; }',
  },
  {
    expected: undefined,
    id: 'plain-default-with-conditional-plain-write-pin',
    source:
      'export function make(flag: boolean, value: Record<string, unknown> = { ok: 1 }) { if (flag) { value = { ok: 2 }; } return value; }',
  },
] as const;

describe('reassigned and shadowed parameter bindings in proxy origin checks', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a module returning conditionally reassigned parameters. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-reassigned-parameters.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
