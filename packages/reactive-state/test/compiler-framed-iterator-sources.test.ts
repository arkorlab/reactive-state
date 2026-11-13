import { type CallExpression, isCallExpression, isNewExpression, type Node } from 'typescript/ast';
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
] as const;

describe('the argument a collection source is built from', () => {
  it.each(SOURCES)('$id', ({ source, quiet }) => {
    const program = `declare const list: any; declare const entries: any; function frames() { const held = ${source}; const iterator = held[Symbol.iterator](); return iterator.next(); }`;

    expect(boundaryQuiet(program)).toBe(quiet);
  });
});

function boundaryQuiet(program: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'iterator-sources.ts', program);
  const created = find(parsed.sourceFile, (node): node is Node => isNewExpression(node));
  if (!isNewExpression(created)) throw new Error('no new expression');
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
