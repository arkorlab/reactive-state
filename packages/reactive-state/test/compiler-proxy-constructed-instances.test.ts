import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

const CASES = [
  {
    expected: PROXY_REFUSAL,
    id: 'constructor-returns-a-proxy-of-this',
    source:
      'class Model { constructor() { return new Proxy(this, {}); } } export function make() { return new Model(); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'constructed-constant-of-a-proxy-returning-class',
    source:
      'class Model { constructor() { return new Proxy(this, {}); } } export const model = new Model();',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'constructor-returns-its-argument',
    source:
      'class Wrap { constructor(value: object) { return value; } } export function make() { return new Wrap(new Proxy({}, {})); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'derived-class-inherits-a-proxy-returning-constructor',
    source:
      'class Base { constructor() { return new Proxy(this, {}); } } class Derived extends Base {} export function make() { return new Derived(); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'class-expression-held-by-a-constant',
    source:
      'const Model = class { constructor() { return new Proxy(this, {}); } }; export function make() { return new Model(); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'field-initializer-holds-a-proxy',
    source: 'class Model { p = new Proxy({}, {}); } export function make() { return new Model(); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'constructor-assigns-a-proxy-to-a-field',
    source:
      'class Model { p: object; constructor() { this.p = new Proxy({}, {}); } } export function make() { return new Model(); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'member-read-of-the-proxy-field',
    source:
      'class Model { p = new Proxy({}, {}); } export function make() { return new Model().p; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'inherited-field-holds-a-proxy',
    source:
      'class Base { p = new Proxy({}, {}); } class Derived extends Base {} export function make() { return new Derived(); }',
  },
  {
    expected: undefined,
    id: 'member-read-of-a-plain-field-pin',
    source:
      'class Model { p = new Proxy({}, {}); q = 1; } export function make() { return new Model().q; }',
  },
  {
    expected: undefined,
    id: 'class-without-a-return-or-a-proxy-pin',
    source: 'class Model { x = 1; } export function make() { return new Model(); }',
  },
  {
    expected: undefined,
    id: 'constructor-returns-a-plain-object-pin',
    source:
      'class Model { constructor() { return { a: 1 }; } } export function make() { return new Model(); }',
  },
  {
    expected: undefined,
    id: 'constructor-sets-plain-fields-pin',
    source:
      'class Model { n: number; constructor(n: number) { this.n = n; } } export function make() { return new Model(1); }',
  },
  {
    expected: undefined,
    id: 'method-that-builds-a-proxy-is-not-run-by-the-constructor-pin',
    source:
      'class Model { x = 1; wrap() { return new Proxy(this, {}); } } export function make() { return new Model(); }',
  },
] as const;

describe('a local class is constructed to what its constructor returns and its fields hold', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module that constructs a local class. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'proxy-constructed-instances.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
