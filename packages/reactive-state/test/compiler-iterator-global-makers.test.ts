import { type Expression, isVariableStatement } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { isIterator } from '../src/compiler/iterators.ts';

/**
 * What a call of a global's function makes, where it makes an iterator: each function of `Iterator`
 * that makes one — `concat`, `zip` and `zipKeyed` as well as `from` — and a method of a prototype
 * that answers one, called on the prototype or on what `call` or `apply` is given first. Any other
 * function of a global still answers what it is: `Object.keys(…)`, `Array.from(…)` an array.
 */

const CASES = [
  { iterates: true, source: 'Iterator.concat([1], [2])', what: 'Iterator.concat' },
  {
    iterates: true,
    source: 'globalThis.Iterator.concat([1])',
    what: 'Iterator.concat of globalThis',
  },
  { iterates: true, source: 'Iterator.zip([[1], [2]])', what: 'Iterator.zip' },
  { iterates: true, source: 'Iterator.zipKeyed({ a: [1] })', what: 'Iterator.zipKeyed' },
  { iterates: true, source: 'Array.prototype.values.call([1, 2])', what: 'values called on items' },
  {
    iterates: true,
    source: 'Array.prototype.entries.apply([1, 2])',
    what: 'entries applied to items',
  },
  {
    iterates: true,
    source: 'Map.prototype.keys.call(new Map())',
    what: "a map's keys called on one",
  },
  {
    iterates: true,
    source: "String.prototype.matchAll.call('ab', /a/gu)",
    what: 'matchAll called on text',
  },
  {
    iterates: true,
    source: 'Iterator.prototype.map.call([1].values(), (each) => each)',
    what: "an iterator's map called on one",
  },
  { iterates: true, source: 'Array.prototype.values()', what: 'values of the prototype itself' },
  { iterates: true, source: 'Iterator.from([1])', what: 'Iterator.from' },
  { iterates: false, source: 'Object.keys({ a: 1 })', what: 'Object.keys, an array' },
  { iterates: false, source: 'Object.entries({ a: 1 })', what: 'Object.entries, an array' },
  { iterates: false, source: 'Array.from([1].values())', what: 'Array.from, an array' },
  {
    iterates: false,
    source: 'Array.prototype.map.call([1], (each) => each)',
    what: "an array's map called on one",
  },
  {
    iterates: false,
    source: 'Iterator.prototype.toArray.call([1].values())',
    what: "an iterator's toArray called on one",
  },
  { iterates: false, source: 'Object.prototype.toString.call([])', what: 'toString called on one' },
] as const;

describe('a global function that makes an iterator', () => {
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
