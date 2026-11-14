import {
  isExpression,
  isForOfStatement,
  isIdentifier,
  isReturnStatement,
  type ForOfStatement,
  type Identifier,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { iteratedAssignmentSources } from '../src/compiler/framed-assignment-patterns.ts';
import { frameDeclarationOf } from '../src/compiler/framed-bindings.ts';

/**
 * Iterated values a pattern destructures each run its default where they hold nothing at the
 * selected position — a hole, a position past an array's end, a key an object does not write —
 * however many other values hold something there: `for ({ e = new Error() } of [{ e: 0 }, {}])`
 * assigns `e` both `0` and the `Error`. The rows each value holds, or none holds, pin the selections
 * the change leaves as they were; a value that holds nothing for a pattern nested in it throws.
 */
const CASES = [
  {
    head: "{ e = new Error('ours') } of [{ e: 0 }, {}]",
    sources: ['0', "new Error('ours')"],
    what: 'an object without the key',
  },
  {
    head: "{ held: e = new Error('ours') } of [{ held: 0 }, {}]",
    sources: ['0', "new Error('ours')"],
    what: 'an object without a renamed key',
  },
  {
    head: "[e = new Error('ours')] of [[0], []]",
    sources: ['0', "new Error('ours')"],
    what: 'an array past its end',
  },
  {
    head: "[e = new Error('ours')] of [[0], [,]]",
    sources: ['0', "new Error('ours')"],
    what: 'an array with a hole',
  },
  {
    head: "[, e = new Error('ours')] of [[0, 1], [0]]",
    sources: ['1', "new Error('ours')"],
    what: 'a later position past an end',
  },
  {
    head: "[[e = new Error('ours')] = []] of [[[0]], []]",
    sources: ['0', "new Error('ours')"],
    what: "a nested pattern's own default",
  },
  {
    head: '{ e = 1 } of [{ e: 0 }, {}]',
    sources: ['0', '1'],
    what: 'a data default',
  },
  {
    head: "{ e = new Error('ours') } of [{ e: 0 }]",
    sources: ['0'],
    what: 'every object with the key',
  },
  {
    head: "{ e = new Error('ours') } of [{}]",
    sources: ["new Error('ours')"],
    what: 'no object with the key',
  },
  {
    head: "[[e = new Error('ours')]] of [[[0]], []]",
    sources: ['0'],
    what: 'a nested pattern of nothing throws',
  },
] as const;

describe('an iterated pattern default where a value holds nothing', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The sources `iteratedAssignmentSources` gives `e` from the loop, as written. */
  function assigned(head: string): readonly string[] {
    using parsed = api.createSourceFile(
      'missing-defaults.ts',
      `function frames() { let e: unknown = 0; for (${head}) {} return e; }\n`,
    );
    let loop: ForOfStatement | undefined;
    let read: Identifier | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (isForOfStatement(at)) loop = at;
      if (isReturnStatement(at) && at.expression !== undefined && isIdentifier(at.expression))
        read = at.expression;
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    const declared = read === undefined ? undefined : frameDeclarationOf(read);
    const target = loop?.initializer;
    if (
      loop === undefined ||
      read === undefined ||
      declared === undefined ||
      target === undefined ||
      !isExpression(target)
    ) {
      throw new Error(`No loop assigns a declared e in ${head}.`);
    }
    return iteratedAssignmentSources(target, loop.expression, read, declared).map((source) =>
      [source.value.getText(), ...source.keys].join('.'),
    );
  }

  it.each(CASES)('$what', ({ head, sources }) => {
    expect(assigned(head)).toStrictEqual(sources);
  });
});
