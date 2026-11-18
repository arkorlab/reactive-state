import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Formats the `settled.ts` refusal message for mutating a kept module binding `name`. */
function keptRefusal(name: string): string {
  return `keeps what a function of its writes between calls, \`${name}\``;
}

const CASES = [
  {
    expected: undefined,
    id: 'rest-array-push-leaves-the-argument-alone',
    source:
      'const entry = { n: 1 }; function count(...items: unknown[]) { items.push(0); return items.length; } export function size() { return count(entry); }',
  },
  {
    expected: undefined,
    id: 'rest-array-shift-leaves-the-argument-alone',
    source:
      'const defaults = { n: 1 }; function head(...items: unknown[]) { return items.shift(); } export function first() { return head(defaults); }',
  },
  {
    expected: undefined,
    id: 'rest-array-sort-leaves-the-argument-alone',
    source:
      'const a = { n: 1 }; const b = { n: 2 }; function ordered(...items: { n: number }[]) { items.sort((x, y) => y.n - x.n); return items[0]?.n; } export function top() { return ordered(a, b); }',
  },
  {
    expected: undefined,
    id: 'rest-array-reverse-and-splice-leave-the-argument-alone',
    source:
      'const a = { n: 1 }; const b = { n: 2 }; function tail(...items: { n: number }[]) { items.reverse(); items.splice(0, 1); return items.length; } export function size() { return tail(a, b); }',
  },
  {
    expected: undefined,
    id: 'rest-array-length-and-index-assignments-leave-the-argument-alone',
    source:
      'const entry = { n: 1 }; function clear(...items: unknown[]) { items[0] = 0; items.length = 0; return items.length; } export function size() { return clear(entry); }',
  },
  {
    expected: undefined,
    id: 'rest-array-unshift-with-spread-argument',
    source:
      'const entries: { n: number }[] = []; function count(...items: unknown[]) { items.unshift(0); return items.length; } export function size() { return count(...entries); }',
  },
  {
    expected: keptRefusal('entry'),
    id: 'rest-element-property-write-pin',
    source:
      'const entry = { n: 1 }; function bump(...items: { n: number }[]) { items[0]!.n++; return items.length; } export function next() { return bump(entry); }',
  },
  {
    expected: keptRefusal('entry'),
    id: 'rest-element-alias-write-pin',
    source:
      'const entry = { n: 1 }; function bump(...items: { n: number }[]) { const first = items[0]!; first.n++; return items.length; } export function next() { return bump(entry); }',
  },
  {
    expected: keptRefusal('entry'),
    id: 'rest-element-method-call-pin',
    source:
      'const entry: number[] = []; function add(...items: number[][]) { items[0]!.push(1); return items.length; } export function next() { return add(entry); }',
  },
  {
    expected: keptRefusal('entry'),
    id: 'rest-destructured-element-write-pin',
    source:
      'const entry = { n: 1 }; function bump(...[target]: { n: number }[]) { target!.n++; return 1; } export function next() { return bump(entry); }',
  },
  {
    expected: keptRefusal('entries'),
    id: 'rest-spread-argument-element-write-pin',
    source:
      'const entries = [{ n: 1 }]; function bump(...items: { n: number }[]) { items[0]!.n++; return items.length; } export function next() { return bump(...entries); }',
  },
  {
    expected: keptRefusal('items'),
    id: 'ordinary-array-parameter-push-pin',
    source:
      'const items: number[] = []; function add(list: number[]) { list.push(1); return list.length; } export function next() { return add(items); }',
  },
  {
    expected: keptRefusal('entry'),
    id: 'rest-container-alias-write-stays-coarse-pin',
    source:
      'const entry = { n: 1 }; function count(...items: unknown[]) { const list = items; list.push(0); return list.length; } export function size() { return count(entry); }',
  },
] as const;

describe('a rest parameter is a fresh array, whose own changes do not write the arguments', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module passing kept state to a rest-parameter helper. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'settled-rest-container-writes.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
