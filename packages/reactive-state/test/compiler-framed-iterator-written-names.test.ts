import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
  type PropertyAccessExpression,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedIteratorResult } from '../src/compiler/framed-collection-iterators.ts';
import { DEFAULT_ITERATOR, iteratorBoundaryQuiet } from '../src/compiler/framed-iterator-guards.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A collection that is built from a name iterates what the name holds as it is built, which may run
 * application code, so a name as its argument is work to the guard of an iterator's first step. Where
 * the reader of a collection's default iterator has followed the name, through whole constant aliases,
 * to a list written out that nothing touches before the construction, the list is data the constructor
 * reads, and the name is quiet as the list is where it is written in place. Without that, the reader
 * dropped every `const input = [error]; new Set(input)[Symbol.iterator]().next().value.stack`, and
 * the words of the `Error` it yields were not read.
 */
const BOUNDARIES = [
  {
    id: 'a-name-followed-to-a-list',
    program: 'const input = [1, 2]; const held = new Set(input);',
    construct: 'new Set(input)',
    followed: true,
    quiet: true,
  },
  {
    id: 'a-name-followed-to-entries',
    program: "const input = [['key', 1]]; const held = new Map(input);",
    construct: 'new Map(input)',
    followed: true,
    quiet: true,
  },
  {
    id: 'a-name-followed-to-an-empty-list',
    program: 'const input = []; const held = new Set(input);',
    construct: 'new Set(input)',
    followed: true,
    quiet: true,
  },
  {
    id: 'a-name-followed-for-a-map-of-names',
    program: "const pair = ['key', 1]; const input = [pair]; const held = new Map(input);",
    construct: 'new Map(input)',
    followed: true,
    quiet: false,
  },
  {
    id: 'a-name-not-followed-for-a-set',
    program: 'const held = new Set(list);',
    construct: 'new Set(list)',
    followed: false,
    quiet: false,
  },
  {
    id: 'a-name-not-followed-for-a-map',
    program: 'const held = new Map(entries);',
    construct: 'new Map(entries)',
    followed: false,
    quiet: false,
  },
  {
    id: 'a-name-not-followed-though-a-list-is-written',
    program: 'const input = [1, 2]; const held = new Set(input);',
    construct: 'new Set(input)',
    followed: false,
    quiet: false,
  },
  {
    id: 'a-second-name-beside-the-followed-one',
    program: 'const input = [1, 2]; const held = new Set(input, list);',
    construct: 'new Set(input, list)',
    followed: true,
    quiet: false,
  },
  {
    id: 'a-followed-name-and-work-before-the-iterator',
    program: 'const input = [1, 2]; const held = new Set(input); hooks();',
    construct: 'new Set(input)',
    followed: true,
    quiet: false,
  },
  {
    id: 'a-list-written-in-place',
    program: 'const held = new Set([1, 2]);',
    construct: 'new Set([1, 2])',
    followed: false,
    quiet: true,
  },
] as const;

describe('the argument a collection source is built from, where its name is followed', () => {
  it.each(BOUNDARIES)('$id', ({ program, followed, quiet }) => {
    const source = `declare const hooks: any; declare const list: any; declare const entries: any; function frames() { ${program} const iterator = held[Symbol.iterator](); return iterator.next(); }`;

    expect(boundaryQuiet(source, followed)).toBe(quiet);
  });
});

/**
 * What the reader of the first value a collection's default iterator yields answers for the words of
 * an `Error` the function was given. A name is followed only to a list that is written out, is a
 * constant, and is touched by nothing before the construction; any other name stays unread by that
 * reader. An input the compile cannot read is read as what the declared type admits
 * (`framedUnreadInput`: a Set's element, a Map's key or value), so for such a name (a list the
 * function was given, a name that is not a constant, a list written to or given to a call before
 * the construction or by a closure, a Map's entry that is a name) the rows below read the words of
 * the `Error` and expect `true`, and the program is refused.
 */
const READS = [
  {
    id: 'a-set-built-from-a-name',
    body: 'const input = [error]; return new Set(input)[Symbol.iterator]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-set-built-from-a-name-and-a-constructor-alias',
    body: 'const Collection = Set; const input = [error]; return new Collection(input)[Symbol.iterator]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-set-built-from-a-name-through-an-alias',
    body: 'const input = [error]; const again = input; return new Set(again)[Symbol.iterator]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-set-built-from-an-asserted-name',
    body: 'const input = [error]; return new Set((input as Error[]))[Symbol.iterator]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-set-built-from-a-name-and-a-symbol-alias',
    body: 'const iterate = Symbol.iterator; const input = [error]; return new Set(input)[iterate]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-map-built-from-a-name-reads-its-value-slot',
    body: "const entries: [string, Error][] = [['key', error]]; return new Map(entries)[Symbol.iterator]().next().value![1].stack;",
    read: true,
  },
  {
    id: 'a-set-built-from-a-written-list',
    body: 'return new Set([error])[Symbol.iterator]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-map-built-from-written-entries',
    body: "return new Map([['key', error]])[Symbol.iterator]().next().value![1].stack;",
    read: true,
  },
  {
    id: 'a-set-built-from-a-name-and-read-by-values',
    body: 'const input = [error]; return new Set(input).values().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-set-whose-first-value-is-not-the-error',
    body: 'const input = [1, error]; return new Set(input)[Symbol.iterator]().next().value!.stack;',
    read: false,
  },
  {
    id: 'a-list-the-function-was-given',
    params: 'error: Error, input: Error[]',
    body: 'return new Set(input)[Symbol.iterator]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-name-that-is-not-a-constant',
    body: 'let input = [error]; return new Set(input)[Symbol.iterator]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-list-written-to-before-the-construction',
    body: 'const input = [error]; input.unshift(new Error("made")); return new Set(input)[Symbol.iterator]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-list-given-to-a-call-before-the-construction',
    body: 'const input = [error]; hooks(input); return new Set(input)[Symbol.iterator]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-list-written-to-by-a-closure-the-construction-may-follow',
    body: 'const input = [error]; const reverse = () => { input.reverse(); }; reverse(); return new Set(input)[Symbol.iterator]().next().value!.stack;',
    read: true,
  },
  {
    id: 'a-call-between-the-list-and-the-construction',
    body: 'const input = [error]; hooks(); return new Set(input)[Symbol.iterator]().next().value!.stack;',
    read: false,
  },
  {
    id: 'a-call-between-the-construction-and-the-iterator',
    body: 'const input = [error]; const held = new Set(input); hooks(); return held[Symbol.iterator]().next().value!.stack;',
    read: false,
  },
  {
    id: 'a-map-whose-entry-is-a-name',
    body: "const pair: [string, Error] = ['key', error]; const entries = [pair]; return new Map(entries)[Symbol.iterator]().next().value![1].stack;",
    read: true,
  },
  {
    id: 'a-weak-set-has-no-iterator',
    body: 'const input = [error]; return new WeakSet(input)[Symbol.iterator]().next().value!.stack;',
    read: false,
  },
] as const;

describe('the first value of the default iterator of a collection built from a name', () => {
  it.each(READS)('$id', (row) => {
    const params = 'params' in row ? row.params : 'error: Error';
    const source = `declare const hooks: any; function frames(${params}) { ${row.body} }`;

    expect(firstValueRead(source)).toBe(row.read);
  });
});

/** Whether `iteratorBoundaryQuiet` takes the first construction, read on to its first step, as quiet. */
function boundaryQuiet(program: string, followed: boolean): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'iterator-written-names.ts', program);
  const created = find(parsed.sourceFile, (node): node is Expression => isNewExpression(node));
  const written = followed
    ? find(parsed.sourceFile, (node): node is ArrayLiteralExpression => {
        return (
          isArrayLiteralExpression(node) &&
          isVariableDeclaration(node.parent) &&
          node.parent.name.getText() === 'input'
        );
      })
    : undefined;
  return iteratorBoundaryQuiet({
    source: { value: created, bindings: new Set() },
    acquisition: call(parsed.sourceFile, 'Symbol.iterator'),
    next: call(parsed.sourceFile, 'next'),
    method: DEFAULT_ITERATOR,
    ...(written !== undefined && { written }),
  });
}

/** Whether the reader answers that the receiver of the `.stack` it finds is the function's `error`. */
function firstValueRead(program: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'iterator-written-names.ts', program);
  const read = find(
    parsed.sourceFile,
    (node): node is PropertyAccessExpression =>
      isPropertyAccessExpression(node) && node.name.text === 'stack',
  );
  return (
    framedIteratorResult(
      read.expression,
      { made: false, keys: [] },
      (each) => isIdentifier(each) && each.text === 'error',
    ) === true
  );
}

function call(root: Node, text: string): CallExpression {
  return find(
    root,
    (node): node is CallExpression =>
      isCallExpression(node) && node.expression.getText().includes(text),
  );
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
