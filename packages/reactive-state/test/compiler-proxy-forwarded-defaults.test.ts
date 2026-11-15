import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when an exported value or callable result can expose a `Proxy`. */
const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/** Unexported wrapper whose default parameter constructs a `Proxy` only when given `undefined`. */
const WRAP = 'function wrap(v: unknown = new Proxy({}, {})) { return v; }';

/**
 * Forwarding a known defined argument through one or more helper parameters must not trigger an
 * unreachable `Proxy` default initializer, while omitted, `undefined`, or nullish-coalesced
 * fallback paths continue to refuse.
 */
const CASES = [
  {
    expected: undefined,
    id: 'forwarded-object-literal-bypasses-proxy-default',
    source: `${WRAP} function relay(v: unknown) { return wrap(v); } export const result = relay({ ok: 1 });`,
  },
  {
    expected: undefined,
    id: 'multi-hop-forwarded-object-bypasses-proxy-default',
    source: `${WRAP} function step2(v: unknown) { return wrap(v); } function step1(v: unknown) { return step2(v); } export const result = step1({ ok: 1 });`,
  },
  {
    expected: undefined,
    id: 'forwarded-null-bypasses-proxy-default',
    source: `${WRAP} function relay(v: unknown) { return wrap(v); } export const result = relay(null);`,
  },
  {
    expected: undefined,
    id: 'forwarded-const-alias-of-parameter-bypasses-proxy-default',
    source: `${WRAP} function relay(v: unknown) { const local = v; return wrap(local); } export const result = relay('ready');`,
  },
  {
    expected: undefined,
    id: 'forwarded-conditional-defined-parameters-bypass-default',
    source: `${WRAP} function relay(flag: boolean, left: unknown, right: unknown) { return wrap(flag ? left : right); } export const result = relay(true, { a: 1 }, { b: 2 });`,
  },
  {
    expected: undefined,
    id: 'relay-defined-default-on-omitted-argument-bypasses-wrap-default',
    source: `${WRAP} function relay(v: unknown = { ok: 1 }) { return wrap(v); } export const result = relay();`,
  },
  {
    expected: undefined,
    id: 'relay-defined-default-on-undefined-argument-bypasses-wrap-default',
    source: `${WRAP} function relay(v: unknown = { ok: 1 }) { return wrap(v); } export const result = relay(undefined);`,
  },
  {
    expected: undefined,
    id: 'definite-parameter-replacement-bypasses-wrap-default',
    source: `${WRAP} function relay(v: unknown) { v = { ok: 1 }; return wrap(v); } export const result = relay(undefined);`,
  },
  {
    expected: undefined,
    id: 'forwarded-rest-array-bypasses-wrap-default',
    source: `${WRAP} function relay(...items: unknown[]) { return wrap(items); } export const result = relay();`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'forwarded-omitted-argument-triggers-proxy-pin',
    source: `${WRAP} function relay(v?: unknown) { return wrap(v); } export const result = relay();`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'forwarded-undefined-argument-triggers-proxy-pin',
    source: `${WRAP} function relay(v: unknown) { return wrap(v); } export const result = relay(undefined);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'forwarded-null-coalesced-to-undefined-triggers-proxy-pin',
    source: `${WRAP} function relay(v: unknown) { return wrap(v ?? undefined); } export const result = relay(null);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'conditionally-cleared-parameter-triggers-proxy-pin',
    source: `${WRAP} function relay(flag: boolean, v: unknown) { if (flag) { v = undefined; } return wrap(v); } export const result = relay(true, { ok: 1 });`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-relay-unknown-caller-triggers-proxy-pin',
    source: `${WRAP} export function relay(v: unknown) { return wrap(v); }`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'forwarded-proxy-argument-still-refused-pin',
    source:
      'function plain(v: unknown = { ok: 1 }) { return v; } function relay(v: unknown) { return plain(v); } export const result = relay(new Proxy({}, {}));',
  },
] as const;

describe('forwarded parameter arguments in proxy default presence checks', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a module forwarding arguments into defaulted helpers. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-forwarded-defaults.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
