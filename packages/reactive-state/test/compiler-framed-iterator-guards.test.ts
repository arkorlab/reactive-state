import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isNewExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { iteratorPrefixQuiet } from '../src/compiler/framed-iterator-guards.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Between the creation of an iterator source and the acquisition of its iterator, any work that runs
 * application code (a getter, an iterator, a coercion) may change the source: the window is quiet
 * only where nothing in it does.
 */
const WINDOWS = [
  {
    id: 'nothing-between',
    between: '',
    quiet: true,
  },
  {
    id: 'a-literal-constant',
    between: 'const label = 1;',
    quiet: true,
  },
  {
    id: 'a-call',
    between: 'hooks();',
    quiet: false,
  },
  {
    id: 'a-property-read',
    between: 'hooks.x;',
    quiet: false,
  },
  {
    id: 'an-object-destructuring',
    between: 'const { x } = hooks;',
    quiet: false,
  },
  {
    id: 'an-array-destructuring',
    between: 'const [first] = other;',
    quiet: false,
  },
  {
    id: 'a-template-coercion',
    // eslint-disable-next-line no-template-curly-in-string
    between: 'const text = `${hooks}`;',
    quiet: false,
  },
  {
    id: 'a-for-of-loop',
    between: 'for (const each of other) { void each; }',
    quiet: false,
  },
  {
    id: 'a-for-in-loop',
    between: 'for (const each in hooks) { void each; }',
    quiet: false,
  },
] as const;

describe('the work between a source and its iterator', () => {
  it.each(WINDOWS)('$id', ({ between, quiet }) => {
    const source = `declare const hooks: any; declare const other: any; function frames() { const set = new Set([1, 2]); ${between} return set[Symbol.iterator](); }`;

    expect(windowQuiet(source)).toBe(quiet);
  });

  it('a spread attribute of an element', () => {
    const between = 'const view = <Widget {...hooks} />;';
    const source = `declare const hooks: any; declare const Widget: any; function frames() { const set = new Set([1, 2]); ${between} return set[Symbol.iterator](); }`;

    expect(windowQuiet(source, 'iterator-guards.tsx')).toBe(false);
  });

  it('an element with no spread attribute', () => {
    const between = 'const view = <Widget label="x" />;';
    const source = `declare const Widget: any; function frames() { const set = new Set([1, 2]); ${between} return set[Symbol.iterator](); }`;

    expect(windowQuiet(source, 'iterator-guards.tsx')).toBe(true);
  });
});

function windowQuiet(source: string, file = 'iterator-guards.ts'): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, file, source);
  const created = find(parsed.sourceFile, (node): node is Expression => isNewExpression(node));
  const acquisition = find(
    parsed.sourceFile,
    (node): node is CallExpression =>
      isCallExpression(node) && node.getText().includes('Symbol.iterator'),
  );
  return iteratorPrefixQuiet(created, acquisition);
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
