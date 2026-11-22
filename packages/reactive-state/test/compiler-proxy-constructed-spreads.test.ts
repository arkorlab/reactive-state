import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

const MODEL = 'class Model { p = new Proxy({}, {}); q = 1; }';

const CASES = [
  {
    expected: undefined,
    id: 'later-key-overwrites-the-proxy-field-of-a-spread-instance',
    source: `${MODEL} export function make() { return { ...new Model(), p: 1 }; }`,
  },
  {
    expected: undefined,
    id: 'later-key-overwrites-a-constructor-assigned-field',
    source:
      'class Model { p: object; constructor() { this.p = new Proxy({}, {}); } } export function make() { return { ...new Model(), p: 1 }; }',
  },
  {
    expected: undefined,
    id: 'later-key-overwrites-an-inherited-field',
    source:
      'class Base { p = new Proxy({}, {}); } class Derived extends Base {} export function make() { return { ...new Derived(), p: 1 }; }',
  },
  {
    expected: undefined,
    id: 'later-key-overwrites-a-member-written-into-a-let',
    source:
      'export function make() { let box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); return { ...box, p: 1 }; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'spread-instance-keeps-the-proxy-field',
    source: `${MODEL} export function make() { return { ...new Model() }; }`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'later-key-is-another-than-the-proxy-field',
    source: `${MODEL} export function make() { return { ...new Model(), q: 2 }; }`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'spread-after-the-key-wins',
    source: `${MODEL} export function make() { return { p: 1, ...new Model() }; }`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'later-computed-key-may-be-any',
    source: `${MODEL} export function make(key: string) { return { ...new Model(), [key]: 1 }; }`,
  },
  {
    expected: PROXY_REFUSAL,
    id: 'spread-let-container-keeps-the-proxy-member',
    source:
      'export function make() { let box: Record<string, unknown> = {}; box.p = new Proxy({}, {}); return { ...box }; }',
  },
] as const;

describe('a key written after a spread instance hides the field it overwrites', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module that spreads an instance or a container. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-constructed-spreads.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
