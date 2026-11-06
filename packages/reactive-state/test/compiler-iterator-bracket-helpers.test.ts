import { type Expression, isVariableStatement } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { isIterator } from '../src/compiler/iterators.ts';

/**
 * An iterator's helper read by text in brackets, `items.values()['map'](…)`, answers another
 * iterator, as the same helper read by its name does: `isIterator` follows what it is called on
 * either way, and still reads an array's `map` as an array's, and a key the code computes as none.
 */

const CASES = [
  { iterates: true, source: "[1, 2].values()['map']((each) => each)", what: 'map by text' },
  {
    iterates: true,
    source: '[1, 2].values()[`filter`]((each) => each > 1)',
    what: 'filter by a template',
  },
  {
    iterates: true,
    source: "[1, 2].values().map((each) => each)['take'](1)",
    what: 'take after map',
  },
  { iterates: true, source: '[1, 2].values().map((each) => each)', what: 'map by its name' },
  { iterates: false, source: "[1, 2]['map']((each) => each)", what: "an array's map" },
  { iterates: false, source: '[1, 2].values()[key]((each) => each)', what: 'a key it computes' },
] as const;

describe('an iterator helper read by text in brackets', () => {
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

  it.each(CASES)('$what', ({ iterates, source }) => {
    expect(readsIterator(source)).toBe(iterates);
  });
});
