import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/** Formats the `settled.ts` refusal message for mutating a kept module binding `name`. */
function keptRefusal(name: string): string {
  return `keeps what a function of its writes between calls, \`${name}\``;
}

const CASES = [
  {
    expected: keptRefusal('counter'),
    id: 'source-call-mutates-kept-object-property',
    source:
      'const counter = { n: 0 }; function bump(value: { n: number }) { value.n++; } export function next() { bump(counter); return counter.n; }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'nested-source-call-chain-mutates-kept-object',
    source:
      'const counter = { n: 0 }; function inner(value: { n: number }) { value.n += 1; } function outer(value: { n: number }) { inner(value); } export function next() { outer(counter); return counter.n; }',
  },
  {
    expected: keptRefusal('items'),
    id: 'source-call-pushes-into-kept-array',
    source:
      'const items: number[] = []; const record = (list: number[]) => { list.push(1); }; export function next() { record(items); return items.length; }',
  },
  {
    expected: keptRefusal('store'),
    id: 'source-call-destructured-parameter-mutates-nested-kept-field',
    source:
      'const store = { counter: { n: 0 } }; function bump({ counter }: { counter: { n: number } }) { counter.n++; } export function next() { bump(store); return store.counter.n; }',
  },
  {
    expected: keptRefusal('store'),
    id: 'source-call-mutates-projected-kept-member',
    source:
      'const store = { counter: { n: 0 } }; function bump(value: { n: number }) { value.n++; } export function next() { bump(store.counter); return store.counter.n; }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'local-constructor-mutates-kept-argument',
    source:
      'const counter = { n: 0 }; class Mutator { constructor(target: { n: number }) { target.n = 1; } } export function next() { new Mutator(counter); return counter.n; }',
  },
  {
    expected: keptRefusal('state'),
    id: 'prefix-increment-as-cast-kept-member',
    source:
      'const state: unknown = { n: 0 }; export function next() { return ++(state as { n: number }).n; }',
  },
  {
    expected: keptRefusal('state'),
    id: 'assignment-angle-bracket-cast-kept-member',
    source:
      'const state: unknown = { n: 0 }; export function next() { (<{ n: number }>state).n = 1; return 1; }',
  },
  {
    expected: keptRefusal('state'),
    id: 'postfix-increment-satisfies-kept-member',
    source:
      'const state = { n: 0 }; export function next() { return (state satisfies { n: number }).n++; }',
  },
  {
    expected: keptRefusal('state'),
    id: 'destructuring-assignment-cast-kept-member',
    source:
      'const state: unknown = { n: 0 }; export function next() { [(state as { n: number }).n] = [1]; return 1; }',
  },
  {
    expected: keptRefusal('store'),
    id: 'nested-kept-object-method-writes-this',
    source:
      'const store = { counter: { n: 0, bump() { return ++this.n; } } }; export function next() { return store.counter.bump(); }',
  },
  {
    expected: keptRefusal('store'),
    id: 'nested-kept-bracket-member-method-writes-this',
    source:
      "const store = { counter: { n: 0, bump() { this.n += 1; return this.n; } } }; export function next() { return store['counter'].bump(); }",
  },
  {
    expected: keptRefusal('store'),
    id: 'nested-kept-array-element-method-writes-this',
    source:
      'const store = { counters: [{ n: 0, bump() { return ++this.n; } }] }; export function next() { return store.counters[0]!.bump(); }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'angle-bracket-cast-kept-receiver-method-writes-this',
    source:
      'const counter = { n: 0, bump() { return ++this.n; } }; export function next() { return (<typeof counter>counter).bump(); }',
  },
  {
    expected: keptRefusal('store'),
    id: 'kept-class-instance-field-method-writes-this',
    source:
      'class Inner { n = 0; bump() { return ++this.n; } } class Store { counter = new Inner(); } const store = new Store(); export function next() { return store.counter.bump(); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-without-initializer-assigned-proxy',
    source: 'export let result: unknown; result = new Proxy({}, {});',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-plain-initializer-reassigned-proxy',
    source: 'export let result: Record<string, unknown> = {}; result = new Proxy({}, {});',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'local-let-assigned-proxy-then-named-export',
    source: 'let result: unknown; result = new Proxy({}, {}); export { result };',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-destructured-assignment-proxy',
    source: 'export let result: unknown; ({ result } = { result: new Proxy({}, {}) });',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-const-object-mutated-with-proxy-property',
    source: 'export const box: Record<string, unknown> = {}; box.p = new Proxy({}, {});',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-destructured-const-default-proxy',
    source: 'export const { result = new Proxy({}, {}) }: { result?: unknown } = {};',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-callable-reassigned-to-proxy-factory',
    source: 'export let make = (): unknown => ({}); make = () => new Proxy({}, {});',
  },
  {
    expected: undefined,
    id: 'helper-mutates-fresh-per-call-object-pin',
    source:
      'function bump(value: { n: number }) { value.n++; return value.n; } export function next() { return bump({ n: 0 }); }',
  },
  {
    expected: undefined,
    id: 'helper-reads-kept-object-and-reassigns-own-parameter-pin',
    source:
      'const counter = { n: 1 }; function read(value: { n: number }) { const copy = value.n; value = { n: copy + 1 }; return value.n; } export function next() { return read(counter); }',
  },
  {
    expected: undefined,
    id: 'nested-kept-object-readonly-method-pin',
    source:
      'const store = { counter: { n: 3, read() { return this.n + 1; } } }; export function next() { return store.counter.read(); }',
  },
  {
    expected: undefined,
    id: 'exported-let-reassigned-plain-values-pin',
    source: 'export let result: Record<string, number> = { a: 1 }; result = { a: 2 };',
  },
] as const;

describe('kept mutations across helper calls, cast targets, nested receivers, and exported Proxy writes', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module exercising kept-write and exported-Proxy checks. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'settled-calls-and-exported-proxies.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
