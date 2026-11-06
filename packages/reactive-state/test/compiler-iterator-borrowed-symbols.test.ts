import { type Expression, isVariableStatement } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { isIterator } from '../src/compiler/iterators.ts';

/**
 * A prototype's method keyed by a symbol the language knows answers an iterator, called on what
 * `call` or `apply` is given first, as the same method by its name does:
 * `Array.prototype[Symbol.iterator].call(items)` as `Array.prototype.values.call(items)`. Another
 * symbol's method, a key the code computes, and a method of a name of the module's are still none.
 */

const CASES = [
  {
    iterates: true,
    source: 'Array.prototype[Symbol.iterator].call([1])',
    what: "an array's iterator called on one",
  },
  {
    iterates: true,
    source: "RegExp.prototype[Symbol.matchAll].call(/a/gu, 'a')",
    what: "a pattern's matches called on text",
  },
  {
    iterates: true,
    source: 'Array.prototype[Symbol.iterator].apply([1])',
    what: "an array's iterator applied to one",
  },
  {
    iterates: true,
    source: 'globalThis.Array.prototype[Symbol.iterator].call([1])',
    what: 'of globalThis',
  },
  {
    iterates: true,
    source: 'Array.prototype.values.call([1])',
    what: "an array's values by name",
  },
  { iterates: true, source: 'Array.prototype[Symbol.iterator]()', what: 'called on the prototype' },
  {
    iterates: false,
    source: "Date.prototype[Symbol.toPrimitive].call(new Date(0), 'number')",
    what: "another symbol's method",
  },
  {
    iterates: false,
    source: 'Array.prototype[key].call([1])',
    what: 'a key it computes',
  },
  {
    iterates: false,
    source: 'local[Symbol.iterator].call([1])',
    what: "a method of the module's own",
  },
] as const;

describe('a symbol-keyed iterator method called on what it is given', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `isIterator` reads `source`, what a constant is declared of, as an iterator. */
  function readsIterator(source: string): boolean {
    using parsed = api.createSourceFile(
      'iterators.ts',
      `const local = [1];\nconst value = ${source};\n`,
    );
    const statement = parsed.sourceFile.statements[1];
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

  it.each(CASES)('$what', ({ iterates, source }) => {
    expect(readsIterator(source)).toBe(iterates);
  });
});
