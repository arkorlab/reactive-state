import {
  isBinaryExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isReturnStatement,
  type BinaryExpression,
  type Identifier,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { arrayPatternSources } from '../src/compiler/framed-array-pattern-writes.ts';
import { assignmentPatternSources } from '../src/compiler/framed-assignment-patterns.ts';
import { frameDeclarationOf } from '../src/compiler/framed-bindings.ts';

/**
 * A rest element of an array pattern is a fresh array, which binds no error identity, and its own
 * target may be a pattern that takes the elements from its place on: `[...[e]] = [new Error()]`
 * assigns `e` the `Error`, `[a, ...[e]]` the one after `a`, `[...[a, ...[e]]]` the second after the
 * first, and an object pattern on the rest reads the positions it names, `[...{ 0: e }]`. Each row
 * is the sources `assignmentPatternSources` gives `e` from the assignment, as written; a rest
 * written as a name, and a name of the rest that is no position, hold no element and pin what the change keeps.
 */
const CASES = [
  {
    assignment: "[...[e]] = [new Error('ours')]",
    sources: ["new Error('ours')"],
    what: 'a pattern of the rest',
  },
  {
    assignment: "[a, ...[e]] = [0, new Error('ours')]",
    sources: ["new Error('ours')"],
    what: 'a pattern of the rest, after a position',
  },
  {
    assignment: "[...[a, e]] = [0, new Error('ours')]",
    sources: ["new Error('ours')"],
    what: 'the second position of the rest',
  },
  {
    assignment: "[...[a, ...[e]]] = [0, new Error('ours')]",
    sources: ["new Error('ours')"],
    what: 'a rest of the rest',
  },
  {
    assignment: "[...[e]] = [0, new Error('ours')]",
    sources: ['0'],
    what: 'the first position of the rest, not the last',
  },
  {
    assignment: "[...[e = new Error('ours')]] = []",
    sources: ["new Error('ours')"],
    what: 'a default of the rest, beside no element',
  },
  {
    assignment: "[...[e = new Error('ours')]] = [0]",
    sources: ['0'],
    what: 'a default of the rest, beside an element',
  },
  {
    assignment: "[...{ 0: e }] = [new Error('ours')]",
    sources: ["new Error('ours')"],
    what: 'an object pattern of the rest',
  },
  {
    assignment: "[a, ...{ 0: e }] = [0, new Error('ours')]",
    sources: ["new Error('ours')"],
    what: 'an object pattern of the rest, after a position',
  },
  {
    assignment: "[...[[e]]] = [[new Error('ours')]]",
    sources: ["new Error('ours')"],
    what: 'a pattern within a pattern of the rest',
  },
  { assignment: "[...e] = [new Error('ours')]", sources: [], what: 'a rest written as a name' },
  {
    assignment: '[a, ...{ length: e }] = [0, 1]',
    sources: [],
    what: 'a name of the rest that is no position',
  },
  {
    assignment: "[e, ...[a]] = [new Error('ours'), 0]",
    sources: ["new Error('ours')"],
    what: 'a position before the rest',
  },
] as const;

/** An element of `values` written by a pattern's rest, selected as `arrayPatternSources` does. */
const ELEMENTS = [
  {
    assignment: "[...[values[0]]] = [new Error('ours')]",
    sources: ["new Error('ours')"],
    what: 'an element in the pattern of a rest',
  },
  {
    assignment: "[a, ...[values[0]]] = [0, new Error('ours')]",
    sources: ["new Error('ours')"],
    what: 'an element in the pattern of a rest, after a position',
  },
  {
    assignment: "[...values] = [new Error('ours')]",
    sources: [],
    what: 'the array itself as the rest',
  },
] as const;

describe('an assignment pattern whose rest holds a pattern', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The assignment `assignment` writes in a function, and the `e` the function returns. */
  function written(assignment: string): {
    readonly assigned: BinaryExpression;
    readonly read: Identifier;
    readonly dispose: () => void;
  } {
    const parsed = api.createSourceFile(
      'pattern-rests.ts',
      `function frames() { let e: unknown = 0; let a: unknown = 0; const values: unknown[] = [0]; ${assignment}; return e; }\n`,
    );
    let assigned: BinaryExpression | undefined;
    let read: Identifier | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (assigned === undefined && isBinaryExpression(at) && isExpression(at.left)) assigned = at;
      if (isReturnStatement(at) && at.expression !== undefined && isIdentifier(at.expression))
        read = at.expression;
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    if (assigned === undefined || read === undefined) {
      parsed[Symbol.dispose]();
      throw new Error(`No assignment is written in ${assignment}.`);
    }
    return {
      assigned,
      read,
      dispose: () => {
        parsed[Symbol.dispose]();
      },
    };
  }

  it.each(CASES)('assigns $what', ({ assignment, sources }) => {
    const { assigned, read, dispose } = written(assignment);
    try {
      const declared = frameDeclarationOf(read);
      if (declared === undefined) throw new Error(`No declaration of e in ${assignment}.`);
      const found = assignmentPatternSources(assigned.left, assigned.right, read, declared);

      expect(
        found.map((source) => [source.value.getText(), ...source.keys].join('.')),
      ).toStrictEqual(sources);
    } finally {
      dispose();
    }
  });

  it.each(ELEMENTS)('writes $what', ({ assignment, sources }) => {
    const { assigned, dispose } = written(assignment);
    try {
      const found = arrayPatternSources(assigned, (target) => isElementAccessExpression(target));

      expect(
        found.map((source) => [source.value.getText(), ...source.keys].join('.')),
      ).toStrictEqual(sources);
    } finally {
      dispose();
    }
  });
});
