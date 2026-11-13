import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isNewExpression,
  isObjectLiteralExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ITERATOR, iteratorBoundaryQuiet } from '../src/compiler/framed-iterator-guards.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A collection that is built from an argument iterates it as it is built: a name the argument is
 * given by may hold an object with an iterator of its own, which runs application code, so the
 * source is quiet only where the argument is written out.
 */
const SOURCES = [
  { id: 'no-argument', source: 'new Set()', quiet: true },
  { id: 'a-written-list', source: 'new Set([1, 2])', quiet: true },
  { id: 'written-entries', source: "new Map([['key', 1]])", quiet: true },
  { id: 'a-name-for-the-list', source: 'new Set(list)', quiet: false },
  { id: 'a-name-for-the-entries', source: 'new Map(entries)', quiet: false },
  { id: 'a-name-in-a-written-list', source: 'new Set([list])', quiet: true },
  { id: 'a-call', source: 'new Set(list.slice())', quiet: false },
  { id: 'a-name-as-an-entry', source: 'new Map([entry])', quiet: false },
  { id: 'a-name-as-a-later-entry', source: "new Map([['key', 1], entry])", quiet: false },
  { id: 'an-object-as-an-entry', source: "new Map([{ 0: 'key', 1: 1 }])", quiet: false },
  { id: 'a-name-as-an-entry-of-a-weak-map', source: 'new WeakMap([entry])', quiet: false },
  { id: 'a-spread-as-an-entry', source: 'new Map([...entries])', quiet: false },
  { id: 'names-in-a-written-entry-pin', source: 'new Map([[key, value]])', quiet: true },
  { id: 'a-name-as-an-element-of-a-set-pin', source: 'new Set([entry])', quiet: true },
  {
    id: 'an-object-with-a-prototype-for-a-set',
    source: 'new Set({ __proto__: entries })',
    quiet: false,
  },
  {
    id: 'an-object-with-a-prototype-for-a-map',
    source: 'new Map({ __proto__: entries })',
    quiet: false,
  },
  {
    id: 'an-object-with-a-prototype-for-a-weak-set',
    source: 'new WeakSet({ __proto__: entries })',
    quiet: false,
  },
  {
    id: 'an-object-with-a-prototype-for-a-weak-map',
    source: 'new WeakMap({ __proto__: entries })',
    quiet: false,
  },
  {
    id: 'an-object-with-a-list-prototype-for-a-set',
    source: 'new Set({ __proto__: [] })',
    quiet: false,
  },
  { id: 'an-empty-object-for-a-set', source: 'new Set({})', quiet: false },
  { id: 'an-empty-object-for-a-map', source: 'new Map({})', quiet: false },
  {
    id: 'a-parenthesized-object-for-a-set',
    source: 'new Set(({ __proto__: entries }))',
    quiet: false,
  },
  {
    id: 'an-object-for-a-set-after-a-cast',
    source: 'new Set({ __proto__: entries } as any)',
    quiet: false,
  },
  { id: 'a-number-for-a-set', source: 'new Set(1)', quiet: false },
  { id: 'a-text-for-a-map', source: "new Map('ab')", quiet: false },
  { id: 'a-text-for-a-set-pin', source: "new Set('ab')", quiet: true },
  { id: 'a-template-for-a-set-pin', source: 'new Set(`ab`)', quiet: true },
  { id: 'null-for-a-set-pin', source: 'new Set(null)', quiet: true },
  { id: 'null-for-a-map-pin', source: 'new Map(null)', quiet: true },
  { id: 'entries-written-for-a-weak-map-pin', source: 'new WeakMap([[key, value]])', quiet: true },
  {
    id: 'an-object-as-an-element-of-a-set-pin',
    source: 'new Set([{ __proto__: entries }])',
    quiet: true,
  },
  {
    id: 'an-object-as-a-key-of-a-map-pin',
    source: 'new Map([[{ __proto__: entries }, 1]])',
    quiet: true,
  },
  {
    id: 'an-object-for-another-constructor-pin',
    source: 'new Array({ __proto__: entries })',
    quiet: true,
  },
] as const;

describe('the argument a collection source is built from', () => {
  it.each(SOURCES)('$id', ({ source, quiet }) => {
    const program = `declare const list: any; declare const entries: any; declare const entry: any; declare const key: any; declare const value: any; function frames() { const held = ${source}; const iterator = held[Symbol.iterator](); return iterator.next(); }`;

    expect(boundaryQuiet(program)).toBe(quiet);
  });
});

/** An object written out has no iterator of its own: it inherits the one its prototype has, or none. */
const OBJECTS = [
  { id: 'an-object-with-a-prototype', source: '{ __proto__: entries }', quiet: false },
  { id: 'an-empty-object', source: '{}', quiet: false },
  { id: 'an-object-with-fields', source: '{ key: 1 }', quiet: false },
] as const;

describe('an object written out as the source of an iterator', () => {
  it.each(OBJECTS)('$id', ({ source, quiet }) => {
    const program = `declare const entries: any; function frames() { const held = ${source}; const iterator = held[Symbol.iterator](); return iterator.next(); }`;

    expect(boundaryQuiet(program, isObjectLiteralExpression)).toBe(quiet);
  });
});

function boundaryQuiet(
  program: string,
  matches: (node: Node) => node is Expression = isNewExpression,
): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'iterator-sources.ts', program);
  const created = find(parsed.sourceFile, matches);
  return iteratorBoundaryQuiet({
    source: { value: created, bindings: new Set() },
    acquisition: call(parsed.sourceFile, 'Symbol.iterator'),
    next: call(parsed.sourceFile, 'next'),
    method: DEFAULT_ITERATOR,
  });
}

function call(root: Node, text: string): CallExpression {
  const found = find(
    root,
    (node): node is CallExpression =>
      isCallExpression(node) && node.expression.getText().includes(text),
  );
  return found;
}

function find<T extends Node>(root: Node, matches: (node: Node) => node is T): T {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (matches(node)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no such node');
}
