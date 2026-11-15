import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when a parameter initializer's `Proxy` can reach an exported result. */
const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/** Shared unexported wrapper whose parameter default constructs a `Proxy`. */
const WRAP = 'function wrap(value: unknown = new Proxy({}, {})) { return value; }';

/**
 * JavaScript evaluates a parameter initializer whenever the supplied argument is `undefined`
 * (including `void 0`, aliases, conditional branches, unknown values, or unknown spreads),
 * whereas `null` and guaranteed defined values bypass the default.
 */
const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'explicit-undefined-argument',
    source: `${WRAP} export const result = wrap(undefined);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'void-zero-argument',
    source: `${WRAP} export const result = wrap(void 0);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'const-undefined-alias-argument',
    source: `${WRAP} const missing = undefined; export const result = wrap(missing);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'conditional-undefined-branch-argument',
    source: `${WRAP} export function run(flag: boolean) { return wrap(flag ? undefined : { ok: 1 }); }`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'possibly-undefined-parameter-argument',
    source: `${WRAP} export function run(input: unknown) { return wrap(input); }`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'unknown-spread-argument',
    source: `${WRAP} export function run(args: unknown[]) { return wrap(...args); }`,
  },
  {
    expected: undefined,
    id: 'object-literal-bypasses-default-pin',
    source: `${WRAP} export const result = wrap({ ok: 1 });`,
  },
  {
    expected: undefined,
    id: 'null-bypasses-default-pin',
    source: `${WRAP} export const result = wrap(null);`,
  },
  {
    expected: undefined,
    id: 'defined-conditional-branches-bypass-default-pin',
    source: `${WRAP} export function run(flag: boolean) { return wrap(flag ? { a: 1 } : { b: 2 }); }`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'omitted-argument-triggers-default-pin',
    source: `${WRAP} export const result = wrap();`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'defined-proxy-argument-forwarded-pin',
    source:
      'function plain(value: unknown = { ok: 1 }) { return value; } export const result = plain(new Proxy({}, {}));',
  },
] as const;

describe('proxy parameter defaults across undefined and possibly undefined arguments', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a module calling helpers with defaulted parameters. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-default-arguments.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
