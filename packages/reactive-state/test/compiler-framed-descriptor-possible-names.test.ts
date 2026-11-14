import { type Expression, isObjectLiteralExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedDescriptorEntries } from '../src/compiler/framed-descriptor-entries.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The entries a written descriptor holds under a name are what its last entry of that name wrote.
 * A computed name that only may name it — `[flag ? 'writable' : 'configurable']`, or a key declared
 * as a union of names — writes it or leaves it, so what an earlier entry wrote may still stand: it
 * is kept beside the new value, and a caller that takes `writable` for `false` only where one entry
 * wrote it does not take a property that may be writable for a readonly one. A later entry that
 * names it alone replaces them all. The rows marked a pin answer the same before this change as
 * after it.
 */
const HEAD = 'declare const flag: boolean; declare const on: boolean;';

const CASES = [
  {
    id: 'a-possible-name-after-the-entry-it-may-replace',
    names: ['writable'],
    source: `${HEAD} const d = { writable: true, [flag ? 'writable' : 'configurable']: false };`,
    values: ['true', 'false'],
  },
  {
    id: 'the-selected-name-second-among-the-possible-ones',
    names: ['writable'],
    source: `${HEAD} const d = { value: 1, writable: true, [flag ? 'configurable' : 'writable']: false };`,
    values: ['true', 'false'],
  },
  {
    id: 'a-key-declared-as-a-union-of-names',
    names: ['writable'],
    source: `${HEAD} function define(key: 'writable' | 'enumerable') { return { value: 1, writable: true, [key]: on }; }`,
    values: ['true', 'on'],
  },
  {
    id: 'two-possible-names-of-one-selection',
    names: ['a'],
    source: `${HEAD} const d = { [flag ? 'a' : 'b']: 1, [flag ? 'b' : 'a']: 2 };`,
    values: ['1', '2'],
  },
  {
    id: 'a-possible-accessor-name-keeps-the-entry-it-may-replace',
    names: ['writable'],
    source: `${HEAD} const d = { writable: true, get [flag ? 'writable' : 'enumerable']() { return false; } };`,
    values: ['true'],
  },
  {
    id: 'every-name-selected-where-one-is-possible',
    names: undefined,
    source: `${HEAD} const d = { value: 1, writable: true, [flag ? 'writable' : 'configurable']: false };`,
    values: ['1', 'true', 'false', 'false'],
  },
  {
    id: 'a-possible-name-alone-pin',
    names: ['writable'],
    source: `${HEAD} const d = { [flag ? 'writable' : 'configurable']: false };`,
    values: ['false'],
  },
  {
    id: 'a-later-entry-that-names-it-alone-replaces-them-pin',
    names: ['writable'],
    source: `${HEAD} const d = { writable: true, [flag ? 'writable' : 'configurable']: false, writable: false };`,
    values: ['false'],
  },
  {
    id: 'a-later-computed-entry-that-names-it-alone-replaces-them-pin',
    names: ['writable'],
    source: `${HEAD} const d = { [flag ? 'writable' : 'configurable']: false, ['writable']: true };`,
    values: ['true'],
  },
  {
    id: 'a-possible-name-that-cannot-name-the-selection-pin',
    names: ['writable'],
    source: `${HEAD} const d = { writable: true, [flag ? 'enumerable' : 'configurable']: false };`,
    values: ['true'],
  },
  {
    id: 'a-possible-name-beside-another-selection-pin',
    names: ['value'],
    source: `${HEAD} const d = { value: 1, writable: true, [flag ? 'writable' : 'configurable']: false };`,
    values: ['1'],
  },
  {
    id: 'a-computed-name-of-one-constant-replaces-pin',
    names: ['writable'],
    source: `${HEAD} const d = { writable: true, ['writable']: false };`,
    values: ['false'],
  },
  {
    id: 'a-key-declared-as-one-name-replaces-pin',
    names: ['writable'],
    source: `${HEAD} function define(key: 'writable') { return { writable: true, [key]: false }; }`,
    values: ['false'],
  },
  {
    id: 'every-name-selected-where-none-is-possible-pin',
    names: undefined,
    source: `${HEAD} const d = { value: 1, writable: false };`,
    values: ['1', 'false'],
  },
  {
    id: 'a-spread-is-not-told-pin',
    names: ['writable'],
    source: `${HEAD} const d = { writable: true, ...{ writable: false } };`,
    values: undefined,
  },
] as const;

/** The first object literal of `source`: the descriptor the row reads. */
function descriptorOf(root: Node): Expression {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isObjectLiteralExpression(node)) return node;
    node.forEachChild((child) => {
      pending.unshift(child);
    });
  }
  throw new Error('No object literal.');
}

describe('the entries of a written descriptor under a computed name', () => {
  it.each(CASES)('$id', ({ names, source, values }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'descriptor-possible-names.ts', source);

    const entries = framedDescriptorEntries(descriptorOf(parsed.sourceFile), names);

    expect(entries?.map((each) => each.getText(parsed.sourceFile))).toStrictEqual(values);
  });
});
