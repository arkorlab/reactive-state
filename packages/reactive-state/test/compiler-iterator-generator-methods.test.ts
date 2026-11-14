import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isIterator } from '../src/compiler/iterators.ts';

/**
 * A generator the code writes answers an iterator when it is called, whatever it is named: `source.map()`
 * of `const source = { *map() { yield 1; } }` calls a generator, and is an iterator, though `map` is
 * also what a helper of an iterator is called. Where `isGenerator` says a call calls a generator it
 * is asked before the call is read as a helper of the iterator it is called on, which it is not; a
 * call it says no generator of is read as a helper as before, `values().map(…)`.
 */

const CASES = [
  {
    iterator: true,
    source: 'const source = { *map() { yield 1; } };\nsource.map();',
    what: 'a generator method named `map`',
  },
  {
    iterator: true,
    source: 'const source = { *filter() { yield 1; } };\nsource.filter();',
    what: 'a generator method named `filter`',
  },
  {
    iterator: true,
    source: 'const source = { *take() { yield 1; } };\nsource.take(1);',
    what: 'a generator method named `take`, given an argument',
  },
  {
    iterator: true,
    source: 'const source = { *drop() { yield 1; } };\nsource.drop(1);',
    what: 'a generator method named `drop`',
  },
  {
    iterator: true,
    source: 'const source = { *flatMap() { yield 1; } };\nsource.flatMap();',
    what: 'a generator method named `flatMap`',
  },
  {
    iterator: true,
    source: "const source = { *map() { yield 1; } };\nsource['map']();",
    what: 'a generator method named `map`, read by text in brackets',
  },
  {
    iterator: true,
    source: 'const source = { *produce() { yield 1; } };\nsource.produce();',
    what: 'a generator method of another name',
  },
  {
    iterator: true,
    source: 'const source = { *map() { yield 1; } };\nsource.map().map((value) => value);',
    what: 'a helper called on a generator method named `map`',
  },
  {
    iterator: true,
    source:
      'const source = { *map() { yield 1; } };\nconst made = source.map();\nmade.filter((value) => value);',
    what: 'a helper called on a name that holds the call of a generator method named `map`',
  },
  {
    iterator: true,
    source: '[1].values().map((value) => value);',
    what: 'a helper called on an iterator a method answers',
  },
  {
    iterator: true,
    source: 'Iterator.from([1]).filter((value) => value);',
    what: 'a helper called on what `Iterator.from` made',
  },
  {
    iterator: false,
    source: 'const source = { map() { return 1; } };\nsource.map();',
    what: 'a method named `map` that is no generator',
  },
  {
    iterator: false,
    source: 'const source = { *produce() { yield 1; } };\nsource.map();',
    what: 'a method named `map` where only another is a generator',
  },
  {
    iterator: false,
    source: '[1].map((value) => value);',
    what: 'the `map` of an array',
  },
  {
    iterator: false,
    source: 'Object.keys({}).map((key) => key);',
    what: 'the `map` of what `Object.keys` answers',
  },
] as const;

describe('a call of a generator method named like a helper of an iterator', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `isIterator` says the last statement of `source`, an expression, is an iterator. */
  function isIteratorLast(source: string): boolean {
    using parsed = api.createSourceFile('iterators.ts', `${source}\n`);
    const { sourceFile } = parsed;
    const names = new Map<string, Expression>();
    const generators = new Set<string>();
    const visit = (node: Node): void => {
      if (
        isVariableDeclaration(node) &&
        isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        names.set(node.name.text, node.initializer);
      }
      if (
        isMethodDeclaration(node) &&
        node.asteriskToken !== undefined &&
        isIdentifier(node.name)
      ) {
        generators.add(node.name.text);
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    const reach = (node: Expression): Expression => {
      const named = isIdentifier(node) ? names.get(node.text) : undefined;
      return named ?? node;
    };
    const isGenerator = (call: CallExpression): boolean => {
      const callee = call.expression;
      const method = isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      const key =
        method ?? callee.getText(sourceFile).replace(/^.*\[['"](?<name>\w+)['"]\]$/u, '$<name>');
      return generators.has(key);
    };
    const last = sourceFile.statements.at(-1);
    const expression =
      last !== undefined && isExpressionStatement(last) ? last.expression : undefined;
    if (expression === undefined || !isCallExpression(expression)) {
      throw new Error('The last statement is no call.');
    }
    return isIterator(expression, reach, isGenerator);
  }

  it.each(CASES)('reads $what', ({ iterator, source }) => {
    expect(isIteratorLast(source)).toBe(iterator);
  });
});
