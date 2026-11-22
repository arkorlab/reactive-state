import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

const MAKE = 'function make() { return new Proxy({}, {}); }';
const IDENTITY = 'function id(value: unknown) { return value; }';

const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'call-of-a-helper-that-returns-a-proxy',
    source: `${MAKE} export const result = make.call(undefined);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'apply-of-a-helper-with-an-empty-list',
    source: `${MAKE} export const result = make.apply(undefined, []);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'apply-of-a-helper-without-a-list',
    source: `${MAKE} export const result = make.apply(undefined);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'reflect-apply-of-a-helper',
    source: `${MAKE} export const result = Reflect.apply(make, undefined, []);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'call-passes-its-argument-to-the-parameter',
    source: `${IDENTITY} export const result = id.call(undefined, new Proxy({}, {}));`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'apply-passes-its-list-to-the-parameters',
    source: `${IDENTITY} export const result = id.apply(undefined, [new Proxy({}, {})]);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'reflect-apply-passes-its-list-to-the-parameters',
    source: `${IDENTITY} export const result = Reflect.apply(id, undefined, [new Proxy({}, {})]);`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'bound-helper-called-at-once',
    source: `${MAKE} export const result = make.bind(undefined)();`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'bound-helper-called-through-a-constant',
    source: `${MAKE} const bound = make.bind(undefined); export const result = bound();`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'bound-argument-reaches-the-parameter',
    source: `${IDENTITY} export const result = id.bind(undefined, new Proxy({}, {}))();`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'apply-of-a-helper-with-a-list-the-code-cannot-read',
    source: `${MAKE} export function run(args: unknown[]) { return make.apply(undefined, args); }`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'call-with-spread-arguments-of-a-helper-that-returns-a-proxy',
    source: `${MAKE} export function run(args: unknown[]) { return make.call(undefined, ...args); }`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'call-inside-an-exported-function',
    source: `${MAKE} export function run() { return make.call(undefined); }`,
  },
  {
    expected: undefined,
    id: 'call-of-a-helper-that-returns-data-pin',
    source:
      'function plain() { return { ok: true }; } export const result = plain.call(undefined);',
  },
  {
    expected: undefined,
    id: 'call-argument-in-another-position-pin',
    source: `${IDENTITY} export const result = id.call(undefined, 1, new Proxy({}, {}));`,
  },
  {
    expected: undefined,
    id: 'apply-list-entry-in-another-position-pin',
    source: `${IDENTITY} export const result = id.apply(undefined, [1, new Proxy({}, {})]);`,
  },
  {
    expected: undefined,
    id: 'bound-argument-fills-the-parameter-pin',
    source: `${IDENTITY} export const result = id.bind(undefined, 1)(new Proxy({}, {}));`,
  },
  {
    expected: undefined,
    id: 'apply-of-a-helper-that-returns-its-parameter-without-a-proxy-pin',
    source: `${IDENTITY} export function run(args: unknown[]) { return id.apply(undefined, args); }`,
  },
] as const;

describe('a source function called through call, apply, bind or Reflect.apply returns what it returns', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module calling a helper by an indirect spelling. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-indirect-calls.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
