import {
  isBinaryExpression,
  isIdentifier,
  SyntaxKind,
  type BinaryExpression,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assignmentPatternDefault } from '../src/compiler/framed-assignment-patterns.ts';

/**
 * A default written in the pattern of a `for … of` header is evaluated by the value each iteration
 * selects, as one written in an assignment's pattern is, and the iteration's selection decides
 * whether it runs: `for ([e = new Error()] of [[0], []])` runs it for the empty array alone. It is
 * no assignment of its own, in an array, an object entry, a rest, or beneath `for await`. What
 * stands elsewhere in the statement is one: the iterated expression, a `for` header that is no
 * `of`, and a `for … in`, whose keys the module does not select from. Each row is whether the
 * assignment to `e` is a default.
 */
const CASES = [
  {
    statement: "for ([e = new Error('ours')] of [[0]]) {}",
    isDefault: true,
    what: 'an array element of the header',
  },
  {
    statement: "for ({ f: e = new Error('ours') } of [{ f: 0 }]) {}",
    isDefault: true,
    what: 'an entry of the header',
  },
  {
    statement: "for ([a, ...[e = new Error('ours')]] of [[0, 1]]) {}",
    isDefault: true,
    what: 'an element in the pattern of a rest of the header',
  },
  {
    statement: "for ([[e = new Error('ours')]] of [[[0]]]) {}",
    isDefault: true,
    what: 'a pattern within a pattern of the header',
  },
  {
    statement: "for ({ f: [e = new Error('ours')] } of [{ f: [0] }]) {}",
    isDefault: true,
    what: 'an element within an entry of the header',
  },
  {
    statement: "for await ([e = new Error('ours')] of [[0]]) {}",
    isDefault: true,
    what: 'an element of a for await header',
  },
  {
    statement: "for (const x of (e = new Error('ours'), [1])) {}",
    isDefault: false,
    what: 'an assignment in the iterated expression',
  },
  {
    statement: "for (const x of [[e = new Error('ours')]]) {}",
    isDefault: false,
    what: 'an assignment in a literal the loop iterates',
  },
  {
    statement: "for (e = new Error('ours'); false; ) {}",
    isDefault: false,
    what: 'an assignment in the header of a plain for',
  },
  {
    statement: "for ([e = new Error('ours')] in { a: 0 }) {}",
    isDefault: false,
    what: 'an element of the header of a for … in',
  },
  {
    statement: "for (const x of [0]) { e = new Error('ours'); }",
    isDefault: false,
    what: 'an assignment in the body',
  },
] as const;

describe('a default written in the header of a for … of', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `assignmentPatternDefault` takes the assignment to `e` in `statement` for a default. */
  function defaultOfE(statement: string): boolean {
    using parsed = api.createSourceFile(
      'forof-defaults.ts',
      `async function frames() { let e: unknown = 0; let a: unknown = 0; ${statement} return e; }\n`,
    );
    let found: BinaryExpression | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (
        isBinaryExpression(at) &&
        at.operatorToken.kind === SyntaxKind.EqualsToken &&
        isIdentifier(at.left) &&
        at.left.text === 'e'
      )
        found = at;
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    if (found === undefined) throw new Error(`No assignment to e is written in ${statement}.`);
    return assignmentPatternDefault(found);
  }

  it.each(CASES)('reads $what', ({ statement, isDefault }) => {
    expect(defaultOfE(statement)).toBe(isDefault);
  });
});
