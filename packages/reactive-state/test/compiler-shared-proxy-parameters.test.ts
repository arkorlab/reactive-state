import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when an exported callable returns a parameter replaced or defaulted to a `Proxy`. */
const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/**
 * Checking exported callables in `sharedProxyOrigin` must retain each callable's parameter frame
 * so parameter replacements and default `Proxy` initializers are detected without false positives
 * on ordinary pass-through parameters.
 */
const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'exported-function-reassigned-parameter',
    source: 'export function make(value: object) { value = new Proxy({}, {}); return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-arrow-reassigned-parameter',
    source: 'export const make = (value: object) => { value = new Proxy({}, {}); return value; };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-function-expression-reassigned-parameter',
    source:
      'export const make = function (value: object) { value = new Proxy({}, {}); return value; };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'export-default-arrow-reassigned-parameter',
    source: 'export default (value: object) => { value = new Proxy({}, {}); return value; };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'named-export-function-reassigned-parameter',
    source:
      'function make(value: object) { value = new Proxy({}, {}); return value; } export { make };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-function-default-proxy-parameter',
    source: 'export function make(value: object = new Proxy({}, {})) { return value; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-concise-arrow-default-proxy-parameter',
    source: 'export const make = (value: object = new Proxy({}, {})) => value;',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-function-reassigned-member-projection',
    source:
      'export function make(box: { nested: object }) { box = { nested: new Proxy({}, {}) }; return box.nested; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-concise-arrow-comma-reassignment',
    source: 'export const make = (value: object) => ((value = new Proxy({}, {})), value);',
  },
  {
    expected: undefined,
    id: 'exported-identity-unchanged-parameter-pin',
    source: 'export function keep(value: { ok: number }) { return value; }',
  },
  {
    expected: undefined,
    id: 'exported-reassigned-to-plain-object-pin',
    source:
      'export function reset(value: object) { if (true) { value = { ok: 1 }; } return value; }',
  },
  {
    expected: undefined,
    id: 'exported-reassigned-plain-branch-pin',
    source:
      'export function maybe(flag: boolean, value: { ok: number }) { if (flag) { value = { ok: 2 }; } return value; }',
  },
  {
    expected: undefined,
    id: 'exported-async-function-later-answer-pin',
    source: 'export async function later(value: object = new Proxy({}, {})) { return value; }',
  },
] as const;

describe('exported callable parameter frames in shared proxy checks', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a module exporting functions or arrows with parameter bindings. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'shared-proxy-parameters.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
