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
  {
    expected: keptRefusal('store'),
    id: 'recursive-factory-nested-kept-method-writes-this',
    source:
      'function make(n: number): { count: number; bump(): number } { if (n === 0) { return { count: 0, bump() { return ++this.count; } }; } return make(n - 1); } const store = { counter: make(2) }; export function next() { return store.counter.bump(); }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'mutually-recursive-factory-kept-method-writes-this',
    source:
      'function makeA(n: number): { count: number; bump(): number } { return n <= 0 ? { count: 0, bump() { return ++this.count; } } : makeB(n - 1); } function makeB(n: number): { count: number; bump(): number } { return makeA(n - 1); } const counter = makeA(2); export function next() { return counter.bump(); }',
  },
  {
    expected: undefined,
    id: 'recursive-factory-readonly-method-terminates-pin',
    source:
      'function make(n: number): { read(): number } { if (n === 0) { return { read() { return 1; } }; } return make(n - 1); } const store = { reader: make(2) }; export function next() { return store.reader.read(); }',
  },
  {
    expected: keptRefusal('store'),
    id: 'nested-kept-array-after-empty-spread-method-writes-this',
    source:
      'const empty: { n: number; bump(): number }[] = []; const store = { counters: [...empty, { n: 0, bump() { return ++this.n; } }] }; export function next() { return store.counters[0]!.bump(); }',
  },
  {
    expected: keptRefusal('state'),
    id: 'helper-function-dot-call-mutates-kept-object',
    source:
      'const state = { n: 0 }; function bump(x: { n: number }) { x.n++; } export function next() { bump.call(null, state); return state.n; }',
  },
  {
    expected: keptRefusal('state'),
    id: 'helper-function-dot-apply-mutates-kept-object',
    source:
      'const state = { n: 0 }; function bump(x: { n: number }) { x.n += 1; } export function next() { bump.apply(null, [state]); return state.n; }',
  },
  {
    expected: keptRefusal('state'),
    id: 'reflect-apply-helper-mutates-kept-object',
    source:
      'const state = { n: 0 }; function bump(x: { n: number }) { x.n = 1; } export function next() { Reflect.apply(bump, null, [state]); return state.n; }',
  },
  {
    expected: keptRefusal('state'),
    id: 'helper-dot-apply-dynamic-array-mutates-kept-object',
    source:
      'const state = { n: 0 }; function bump(x: { n: number }) { x.n++; } export function next(flag: boolean) { const args = flag ? [state] : [{ n: 0 }]; bump.apply(null, args); return state.n; }',
  },
  {
    expected: keptRefusal('state'),
    id: 'outer-helper-forwards-via-dot-call-to-mutating-inner',
    source:
      'const state = { n: 0 }; function inner(x: { n: number }) { x.n++; } function outer(y: { n: number }) { inner.call(null, y); } export function next() { outer(state); return state.n; }',
  },
  {
    expected: keptRefusal('state'),
    id: 'borrowed-function-dot-call-mutates-kept-this-receiver',
    source:
      'const state = { n: 0 }; function bump(this: { n: number }) { this.n++; } export function next() { bump.call(state); return state.n; }',
  },
  {
    expected: undefined,
    id: 'borrowed-readonly-helper-dot-call-and-apply-pin',
    source:
      'const state = { n: 4 }; function read(a: number, x: { n: number }) { return a + x.n; } export function next() { return read.call(null, 1, state) + read.apply(null, [2, state]) + Reflect.apply(read, null, [3, state]); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-for-of-loop-assigned-proxy',
    source: 'export let result: unknown; for (result of [new Proxy({}, {})]) { void result; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-for-of-destructured-loop-assigned-proxy',
    source:
      'export let result: unknown; for ({ a: result } of [{ a: new Proxy({}, {}) }]) { void result; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-for-of-destructured-default-proxy',
    source:
      'export let result: unknown; for ({ a: result = new Proxy({}, {}) } of [{} as { a?: unknown }]) { void result; }',
  },
  {
    expected: undefined,
    id: 'exported-let-destructured-assignment-ignores-unexported-sibling-proxy-pin',
    source:
      'export let count = 0; const source = { count: 1, internal: new Proxy({}, {}) }; ({ count } = source);',
  },
  {
    expected: undefined,
    id: 'exported-let-array-destructured-assignment-ignores-unexported-element-proxy-pin',
    source:
      'export let count = 0; const source: [unknown, number] = [new Proxy({}, {}), 1]; [, count] = source;',
  },
  {
    expected: undefined,
    id: 'exported-let-for-of-destructured-ignores-unexported-sibling-proxy-pin',
    source:
      'export let count = 0; for ({ count } of [{ count: 1, internal: new Proxy({}, {}) }]) { void count; }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-destructured-assignment-catches-getter-returning-proxy',
    source:
      'export let count: unknown = 0; const source = { get count() { return new Proxy({}, {}); }, internal: 1 }; ({ count } = source);',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-object-rest-assignment-catches-remaining-proxy',
    source:
      'export let rest: Record<string, unknown> = {}; let count = 0; const source = { count: 1, internal: new Proxy({}, {}) }; ({ count, ...rest } = source);',
  },
  {
    expected: undefined,
    id: 'exported-let-object-rest-assignment-excludes-stripped-proxy-pin',
    source:
      'export let rest: Record<string, unknown> = {}; let internal: unknown; const source = { count: 1, internal: new Proxy({}, {}) }; ({ internal, ...rest } = source);',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-destructured-revocable-proxy-member',
    source: 'export let proxy: unknown; const rev = Proxy.revocable({}, {}); ({ proxy } = rev);',
  },
  {
    expected: undefined,
    id: 'exported-let-destructured-revocable-revoke-member-pin',
    source: 'export let revoke: unknown; const rev = Proxy.revocable({}, {}); ({ revoke } = rev);',
  },
  {
    expected: keptRefusal('store'),
    id: 'nested-factory-readonly-branch-before-mutating-branch',
    source:
      'function make(flag: boolean) { if (flag) return { bump() { return 0; } }; return { n: 0, bump() { return ++this.n; } }; } const store = { counter: make(false) }; export function next() { return store.counter.bump(); }',
  },
  {
    expected: keptRefusal('store'),
    id: 'nested-factory-mutating-branch-before-readonly-branch',
    source:
      'function make(flag: boolean) { if (flag) return { n: 0, bump() { return ++this.n; } }; return { bump() { return 0; } }; } const store = { counter: make(true) }; export function next() { return store.counter.bump(); }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'direct-factory-readonly-branch-before-mutating-branch',
    source:
      'function make(flag: boolean) { if (flag) return { bump() { return 0; } }; return { n: 0, bump() { return ++this.n; } }; } const counter = make(false); export function next() { return counter.bump(); }',
  },
  {
    expected: undefined,
    id: 'nested-factory-all-readonly-branches-pin',
    source:
      'function make(flag: boolean) { if (flag) return { bump() { return 0; } }; return { n: 1, bump() { return this.n; } }; } const store = { counter: make(false) }; export function next() { return store.counter.bump(); }',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-nested-array-rest-pattern-catches-proxy',
    source: 'export let result: unknown; [...[result]] = [new Proxy({}, {})];',
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-offset-nested-array-rest-pattern-catches-proxy',
    source:
      "export let result: unknown; let a: unknown; [a, ...[result]] = ['ok', new Proxy({}, {})];",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-offset-nested-object-in-rest-pattern-catches-proxy',
    source:
      "export let result: unknown; let a: unknown; [a, ...{ 0: result }] = ['ok', new Proxy({}, {})];",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-doubly-nested-rest-pattern-catches-proxy',
    source:
      "export let result: unknown; let a: unknown; let b: unknown; [a, ...[b, ...[result]]] = ['x', 'y', new Proxy({}, {})];",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'exported-let-nested-object-rest-in-array-rest-catches-proxy',
    source:
      "export let rest: Record<string, unknown> = {}; let a: unknown; let b: unknown; [a, ...{ 0: b, ...rest }] = ['x', 'y', new Proxy({}, {})];",
  },
  {
    expected: undefined,
    id: 'exported-let-nested-object-rest-in-array-rest-ignores-stripped-prefix-proxies-pin',
    source:
      "export let rest: Record<string, unknown> = {}; let a: unknown; let b: unknown; [a, ...{ 0: b, ...rest }] = [new Proxy({}, {}), new Proxy({}, {}), 'safe'];",
  },
  {
    expected: undefined,
    id: 'exported-let-nested-array-rest-pattern-ignores-unselected-tail-proxy-pin',
    source: "export let result: unknown; [...[result]] = ['ok', new Proxy({}, {})];",
  },
  {
    expected: undefined,
    id: 'exported-let-offset-nested-array-rest-pattern-ignores-prefix-proxy-pin',
    source:
      "export let result: unknown; let a: unknown; [a, ...[result]] = [new Proxy({}, {}), 'ok'];",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'destructured-parameter-nested-rest-pattern-catches-proxy',
    source:
      'function pick([first, ...[{ inner }]]: [{ inner?: unknown }, { inner: unknown }]) { void first; return inner; } export const result = pick([{}, { inner: new Proxy({}, {}) }]);',
  },
  {
    expected: undefined,
    id: 'destructured-parameter-nested-rest-pattern-ignores-unselected-tail-proxy-pin',
    source:
      "function pick([...[first]]: unknown[]) { return first; } export const result = pick(['ok', new Proxy({}, {})]);",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'rest-parameter-nested-pattern-catches-selected-proxy',
    source:
      'function pick(...[first, ...[{ inner }]]: [{ inner?: unknown }, { inner: unknown }]) { void first; return inner; } const box = { inner: new Proxy({}, {}) }; export const result = pick({}, box);',
  },
  {
    expected: undefined,
    id: 'rest-parameter-nested-pattern-ignores-unselected-argument-proxy-pin',
    source:
      "function pick(...[...[first]]: unknown[]) { return first; } export const result = pick('ok', new Proxy({}, {}));",
  },
  {
    expected: undefined,
    id: 'rest-parameter-object-pattern-ignores-unselected-argument-proxy-pin',
    source:
      "function pick(...{ 0: first }: unknown[]) { return first; } export const result = pick('ok', new Proxy({}, {}));",
  },
  {
    expected: PROXY_REFUSAL,
    id: 'helper-mutation-through-nested-rest-parameter-catches-proxy',
    source:
      'function put([, ...[target]]: Record<string, unknown>[]) { target.x = new Proxy({}, {}); } export function read() { const a: Record<string, unknown> = {}; const b: Record<string, unknown> = {}; put([a, b]); return b.x; }',
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
