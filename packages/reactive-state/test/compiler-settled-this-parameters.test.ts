import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** The `settled.ts` refusal for writing the kept module binding `counter`. */
const COUNTER_REFUSAL = 'keeps what a function of its writes between calls, `counter`';

const CASES = [
  {
    expected: undefined,
    id: 'typed-this-does-not-shift-a-fresh-object-onto-the-written-parameter',
    source:
      'const source = { n: 1 }; function copy(this: void, out: { n: number }, input: { n: number }) { out.n = input.n; return out.n; } export function read() { return copy({ n: 0 }, source); }',
  },
  {
    expected: COUNTER_REFUSAL,
    id: 'typed-this-does-not-hide-the-written-first-argument',
    source:
      'const counter = { n: 0 }; function bump(this: void, out: { n: number }) { out.n++; } export function next() { bump(counter); return counter.n; }',
  },
  {
    expected: COUNTER_REFUSAL,
    id: 'typed-this-second-argument-reaches-the-written-parameter',
    source:
      "const counter = { n: 0 }; function put(this: void, label: string, out: { n: number }) { out.n = label.length; } export function next() { put('a', counter); return counter.n; }",
  },
  {
    expected: COUNTER_REFUSAL,
    id: 'typed-this-call-reaches-the-written-parameter',
    source:
      'const counter = { n: 0 }; function bump(this: object, out: { n: number }) { out.n++; } export function next() { bump.call({}, counter); return counter.n; }',
  },
  {
    expected: COUNTER_REFUSAL,
    id: 'typed-this-apply-reaches-the-written-parameter',
    source:
      'const counter = { n: 0 }; function bump(this: object, out: { n: number }) { out.n++; } export function next() { bump.apply({}, [counter]); return counter.n; }',
  },
  {
    expected: undefined,
    id: 'typed-this-before-an-unwritten-parameter-pin',
    source:
      'const source = { n: 1 }; function read(this: void, input: { n: number }) { return input.n; } export function f() { return read(source); }',
  },
  {
    expected: undefined,
    id: 'typed-this-argument-in-the-unwritten-position-pin',
    source:
      'const counter = { n: 0 }; function put(this: void, label: { n: number }, out: { n: number }) { out.n = label.n; } export function next() { const fresh = { n: 0 }; put(counter, fresh); return fresh.n; }',
  },
  {
    expected: COUNTER_REFUSAL,
    id: 'parameter-without-a-typed-this-pin',
    source:
      'const counter = { n: 0 }; function bump(out: { n: number }) { out.n++; } export function next() { bump(counter); return counter.n; }',
  },
  {
    expected: COUNTER_REFUSAL,
    id: 'constructor-parameter-pin',
    source:
      'const counter = { n: 0 }; class Mutator { constructor(target: { n: number }) { target.n = 1; } } export function next() { new Mutator(counter); return counter.n; }',
  },
] as const;

describe('a typed `this` is no argument of a call', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module passing kept state to a helper typed of `this`. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'settled-this-parameters.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
