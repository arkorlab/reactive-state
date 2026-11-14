import {
  isElementAccessExpression,
  isForOfStatement,
  type ForOfStatement,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { arrayPatternSources } from '../src/compiler/framed-array-pattern-writes.ts';

/**
 * Iterated values an array element is destructured from each run its default where they hold
 * nothing at the selected position, as an identifier's do: `for ([values[0] = new Error()] of
 * [[0], []])` writes `values[0]` both `0` and the `Error`. The rows each value holds, or none holds,
 * and an element with no default pin the sources the change leaves as they were; a value that holds
 * nothing for a pattern nested in it throws.
 */
const CASES = [
  {
    head: "[values[0] = new Error('ours')] of [[0], []]",
    sources: ['0', "new Error('ours')"],
    what: 'an array past its end',
  },
  {
    head: "[values[0] = new Error('ours')] of [[0], [,]]",
    sources: ['0', "new Error('ours')"],
    what: 'an array with a hole',
  },
  {
    head: "[, values[0] = new Error('ours')] of [[0, 1], [0]]",
    sources: ['1', "new Error('ours')"],
    what: 'a later position past an end',
  },
  {
    head: "{ held: values[0] = new Error('ours') } of [{ held: 0 }, {}]",
    sources: ['0', "new Error('ours')"],
    what: 'an object without the key',
  },
  {
    head: "[[values[0] = new Error('ours')] = []] of [[[0]], []]",
    sources: ['0', "new Error('ours')"],
    what: "a nested pattern's own default",
  },
  {
    head: "[values[0] = new Error('ours')] of [[0], [1]]",
    sources: ['0', '1'],
    what: 'every array with the position',
  },
  {
    head: "[values[0] = new Error('ours')] of [[]]",
    sources: ["new Error('ours')"],
    what: 'no array with the position',
  },
  {
    head: "[[values[0] = new Error('ours')]] of [[[0]], []]",
    sources: ['0'],
    what: 'a nested pattern of nothing throws',
  },
  { head: '[values[0]] of [[0], []]', sources: ['0'], what: 'an element with no default' },
] as const;

describe('an iterated pattern default written to an array element where a value holds nothing', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The sources `arrayPatternSources` gives an element of `values` from the loop, as written. */
  function written(head: string): readonly string[] {
    using parsed = api.createSourceFile(
      'array-pattern-defaults.ts',
      `function frames() { const values: unknown[] = [0]; for (${head}) {} return values; }\n`,
    );
    let loop: ForOfStatement | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (isForOfStatement(at)) loop = at;
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    if (loop === undefined) throw new Error(`No loop is written in ${head}.`);
    return arrayPatternSources(loop, (target) => isElementAccessExpression(target)).map((source) =>
      [source.value.getText(), ...source.keys].join('.'),
    );
  }

  it.each(CASES)('$what', ({ head, sources }) => {
    expect(written(head).toSorted((left, right) => left.localeCompare(right))).toStrictEqual(
      [...sources].toSorted((left, right) => left.localeCompare(right)),
    );
  });
});
