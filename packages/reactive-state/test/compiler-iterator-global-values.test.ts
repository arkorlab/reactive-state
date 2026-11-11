import { type Expression, isVariableStatement } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { isIterator } from '../src/compiler/iterators.ts';

/**
 * A method of a value a global holds, `process.argv.values()`, is a method of a value as `items.values()`
 * is: it answers an iterator by its name, whatever the path of the global it is read through. What a
 * function of the global `Object` answers by the same names, `Object.keys(…)`, `Object.values(…)`,
 * `Object.entries(…)`, is an array, and a method that answers an array is none.
 */

const CASES = [
  { iterates: true, source: 'process.argv.values()', what: 'values of an array a global holds' },
  {
    iterates: true,
    source: 'navigator.languages.entries()',
    what: 'entries of an array a global holds',
  },
  {
    iterates: true,
    source: 'globalThis.process.argv.keys()',
    what: 'keys of an array a global holds, past the global object',
  },
  { iterates: true, source: "process.argv['values']()", what: 'values by text in brackets' },
  {
    iterates: true,
    source: '(<any>process.argv.values)()',
    what: 'values past a cast in angle brackets',
  },
  {
    iterates: true,
    source: 'process.argv.values().map((each) => each)',
    what: 'a helper of an iterator of an array a global holds',
  },
  {
    iterates: true,
    source: 'process.argv[Symbol.iterator]()',
    what: "an array a global holds, by the language's symbol",
  },
  { iterates: true, source: 'Iterator.from(process.argv)', what: 'Iterator.from of one' },
  { iterates: false, source: 'Object.keys(process.env)', what: 'Object.keys, an array' },
  { iterates: false, source: 'Object.values(process.env)', what: 'Object.values, an array' },
  { iterates: false, source: 'Object.entries(process.env)', what: 'Object.entries, an array' },
  {
    iterates: false,
    source: 'Object.keys.call(null, process.env)',
    what: 'Object.keys called with a `this`',
  },
  {
    iterates: false,
    source: 'globalThis.Object.entries(process.env)',
    what: 'Object.entries of the global object',
  },
  { iterates: false, source: 'process.argv.map((each) => each)', what: 'map of an array' },
  { iterates: false, source: 'process.argv.slice(1)', what: 'slice of an array' },
  { iterates: false, source: 'Array.from(process.argv)', what: 'Array.from, an array' },
  { iterates: false, source: 'process.cwd()', what: 'a function of a global that answers text' },
] as const;

describe('a method of a value a global holds that answers an iterator', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `isIterator` reads `source`, what a constant is declared of, as an iterator. */
  function readsIterator(source: string): boolean {
    using parsed = api.createSourceFile('iterators.ts', `const value = ${source};\n`);
    const [statement] = parsed.sourceFile.statements;
    const initializer =
      statement !== undefined && isVariableStatement(statement)
        ? statement.declarationList.declarations[0]?.initializer
        : undefined;
    if (initializer === undefined) {
      throw new Error(`No constant is declared of ${source}.`);
    }
    return isIterator(
      initializer,
      (node: Expression) => unwrapped(node),
      () => false,
    );
  }

  it.each(CASES)('reads an iterator of $what', ({ iterates, source }) => {
    expect(readsIterator(source)).toBe(iterates);
  });
});
