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
 * A default written inside an assignment pattern is evaluated by the pattern's selected value, not
 * written as an assignment of its own, wherever the pattern nests it: in an array, in an object
 * entry, and in the pattern of a rest, `[...[e = new Error()]] = [0]`, which reads the fresh array
 * the rest makes. A plain assignment `e = new Error()` is no default. Each row is whether the
 * assignment to `e` is one.
 */
const CASES = [
  { assignment: "[e = new Error('ours')] = [0]", isDefault: true, what: 'an array element' },
  { assignment: "({ f: e = new Error('ours') } = { f: 0 })", isDefault: true, what: 'an entry' },
  {
    assignment: "[...[e = new Error('ours')]] = [0]",
    isDefault: true,
    what: 'an element in the pattern of a rest',
  },
  {
    assignment: "[a, ...[e = new Error('ours')]] = [0, 1]",
    isDefault: true,
    what: 'an element in the pattern of a rest, after a position',
  },
  {
    assignment: "[...[a, ...[e = new Error('ours')]]] = [0, 1]",
    isDefault: true,
    what: 'an element in the pattern of a rest of a rest',
  },
  {
    assignment: "[...{ 0: e = new Error('ours') }] = [0]",
    isDefault: true,
    what: 'an entry in the pattern of a rest',
  },
  {
    assignment: "[...[{ f: e = new Error('ours') }]] = [{ f: 0 }]",
    isDefault: true,
    what: 'an entry within the pattern of a rest',
  },
  { assignment: "e = new Error('ours')", isDefault: false, what: 'a plain assignment' },
] as const;

describe('a default written in the pattern of a rest', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `assignmentPatternDefault` takes the assignment to `e` in `assignment` for a default. */
  function defaultOfE(assignment: string): boolean {
    using parsed = api.createSourceFile(
      'pattern-rest-defaults.ts',
      `function frames() { let e: unknown = 0; let a: unknown = 0; ${assignment}; return e; }\n`,
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
    if (found === undefined) throw new Error(`No assignment to e is written in ${assignment}.`);
    return assignmentPatternDefault(found);
  }

  it.each(CASES)('reads $what', ({ assignment, isDefault }) => {
    expect(defaultOfE(assignment)).toBe(isDefault);
  });
});
