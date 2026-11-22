import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Formats the `settled.ts` refusal message for mutating a kept module binding `name`. */
function keptRefusal(name: string): string {
  return `keeps what a function of its writes between calls, \`${name}\``;
}

/**
 * `held-methods.ts` answers each method name with every function that may run under it, a list; the
 * receiver paths of `settled-receivers.ts` read them as a method table, and `settled-calls.ts` and
 * `settled-writes.ts` read the table to follow a borrowed call and a helper's receiver.
 */
const CASES = [
  {
    expected: keptRefusal('counter'),
    id: 'static-method-dot-call-mutates-kept-argument',
    source:
      'const counter = { n: 0 }; class Util { static fill(target: { n: number }) { target.n = 1; } } export function next() { Util.fill.call(null, counter); return counter.n; }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'static-method-reflect-apply-mutates-kept-argument',
    source:
      'const counter = { n: 0 }; class Util { static fill(target: { n: number }) { target.n = 1; } } export function next() { Reflect.apply(Util.fill, null, [counter]); return counter.n; }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'static-method-bind-mutates-kept-argument',
    source:
      'const counter = { n: 0 }; class Util { static fill(target: { n: number }) { target.n = 1; } } export function next() { Util.fill.bind(null, counter)(); return counter.n; }',
  },
  {
    expected: undefined,
    id: 'static-readonly-method-dot-call-pin',
    source:
      'const counter = { n: 0 }; class Util { static read(target: { n: number }) { return target.n; } } export function next() { return Util.read.call(null, counter); }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'object-method-dot-call-mutates-kept-argument',
    source:
      'const counter = { n: 0 }; const helpers = { fill(target: { n: number }) { target.n = 1; } }; export function next() { helpers.fill.call(null, counter); return counter.n; }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'object-function-property-dot-call-mutates-kept-argument',
    source:
      'const counter = { n: 0 }; const helpers = { fill: function (target: { n: number }) { target.n = 1; } }; export function next() { helpers.fill.call(null, counter); return counter.n; }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'instance-method-dot-call-mutates-kept-argument',
    source:
      'const counter = { n: 0 }; class Util { fill(target: { n: number }) { target.n = 1; } } const util = new Util(); export function next() { util.fill.call(null, counter); return counter.n; }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'factory-mutating-branch-dot-call-mutates-kept-argument',
    source:
      'const counter = { n: 0 }; const make = (flag: boolean) => flag ? { fill(target: { n: number }) { return target.n; } } : { fill(target: { n: number }) { target.n = 1; } }; const helpers = make(true); export function next() { helpers.fill.call(null, counter); return counter.n; }',
  },
  {
    expected: undefined,
    id: 'factory-readonly-branches-dot-call-pin',
    source:
      'const counter = { n: 0 }; const make = (flag: boolean) => flag ? { fill(target: { n: number }) { return target.n; } } : { fill(target: { n: number }) { return target.n + 1; } }; const helpers = make(true); export function next() { return helpers.fill.call(null, counter); }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'inherited-method-dot-call-mutates-kept-argument',
    source:
      'const counter = { n: 0 }; class Base { fill(target: { n: number }) { target.n = 1; } } class Util extends Base {} const util = new Util(); export function next() { util.fill.call(null, counter); return counter.n; }',
  },
  {
    expected: undefined,
    id: 'overridden-readonly-method-dot-call-pin',
    source:
      'const counter = { n: 0 }; class Base { fill(target: { n: number }) { target.n = 1; } } class Util extends Base { fill(target: { n: number }) { return target.n; } } const util = new Util(); export function next() { return util.fill.call(null, counter); }',
  },
  {
    expected: keptRefusal('store'),
    id: 'helper-parameter-receiver-method-writes-this',
    source:
      'const store = { counter: { n: 0, bump() { return ++this.n; } } }; function advance(target: typeof store) { return target.counter.bump(); } export function next() { return advance(store); }',
  },
  {
    expected: undefined,
    id: 'helper-parameter-receiver-readonly-method-pin',
    source:
      'const store = { counter: { n: 0, read() { return this.n; } } }; function peek(target: typeof store) { return target.counter.read(); } export function next() { return peek(store); }',
  },
  {
    expected: keptRefusal('store'),
    id: 'helper-parameter-receiver-class-method-writes-this',
    source:
      'class Inner { n = 0; bump() { return ++this.n; } } const store = { counter: new Inner() }; function advance(target: typeof store) { return target.counter.bump(); } export function next() { return advance(store); }',
  },
  {
    expected: keptRefusal('store'),
    id: 'nested-kept-derived-class-method-writes-this',
    source:
      'class Base { n = 0; bump() { return ++this.n; } } class Inner extends Base {} const store = { counter: new Inner() }; export function next() { return store.counter.bump(); }',
  },
  {
    expected: undefined,
    id: 'nested-kept-derived-class-readonly-override-pin',
    source:
      'class Base { n = 0; bump() { return ++this.n; } } class Inner extends Base { bump() { return this.n; } } const store = { counter: new Inner() }; export function next() { return store.counter.bump(); }',
  },
  {
    expected: keptRefusal('counter'),
    id: 'constructor-installed-method-beside-readonly-method-writes-this',
    source:
      'class Counter { n = 0; constructor() { this.bump = () => ++this.n; } bump() { return this.n; } } const counter = new Counter(); export function next() { return counter.bump(); }',
  },
] as const;

describe('method tables read as lists of the functions that may run under each name', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a module whose kept bindings are called through method tables. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'settled-candidate-method-lists.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
