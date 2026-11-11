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
 * first, and an object pattern on the rest reads the positions it names, `[...{ 0: e }]`. The rest's
 * other properties are the fresh array's, not the sources': its `length` is a number, so that a
 * default beside it never runs, and a name no element holds is `undefined`, so that its default
 * does, `[a, ...{ foo: e = new Error() }] = [0]`. What the array inherits, `constructor` or
 * `toString`, is present as `length` is, and a pattern written on such a value still reads its
 * properties, `[...{ length: { foo: e = new Error() } }]`. Each row is the sources
 * `assignmentPatternSources` gives `e` from the assignment, as written; a rest written as a name
 * holds no element.
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
    assignment: "[...{ length: e = new Error('fallback') }] = []",
    sources: [],
    what: 'the length of the rest, beside a default',
  },
  {
    assignment: "[a, ...{ length: e = new Error('fallback') }] = [0]",
    sources: [],
    what: 'the length of the rest, after a position',
  },
  {
    assignment: "[...{ length: e }] = [new Error('ours')]",
    sources: [],
    what: 'the length of the rest, not an element of the sources',
  },
  {
    assignment: "[a, ...{ foo: e = new Error('fallback') }] = [0]",
    sources: ["new Error('fallback')"],
    what: 'a name no element holds, after a position',
  },
  {
    assignment: "[...{ foo: e = new Error('fallback') }] = [0]",
    sources: ["new Error('fallback')"],
    what: 'a name no element holds',
  },
  {
    assignment: "[...{ e = new Error('fallback') }] = [new Error('ours')]",
    sources: ["new Error('fallback')"],
    what: 'a shorthand name no element holds',
  },
  {
    assignment: "[...{ '01': e = new Error('fallback') }] = [0, 1]",
    sources: ["new Error('fallback')"],
    what: 'a name that is no canonical position',
  },
  {
    assignment: "[...{ constructor: e = new Error('fallback') }] = []",
    sources: [],
    what: 'a name the array inherits, beside a default',
  },
  {
    assignment: "[a, ...{ toString: e = new Error('fallback') }] = [0]",
    sources: [],
    what: 'a name the array inherits, after a position',
  },
  {
    assignment: "[...{ hasOwnProperty: e = new Error('fallback') }] = []",
    sources: [],
    what: 'a name every object inherits',
  },
  {
    assignment: "[...{ __proto__: e = new Error('fallback') }] = []",
    sources: [],
    what: 'the prototype of the rest',
  },
  {
    assignment: "[...{ charAt: e = new Error('fallback') }] = []",
    sources: ["new Error('fallback')"],
    what: 'a name only text inherits',
  },
  {
    assignment: "[...{ length: { foo: e = new Error('fallback') } }] = []",
    sources: ["new Error('fallback')"],
    what: 'a pattern read from the length of the rest',
  },
  {
    assignment: "[...{ toString: { foo: e = new Error('fallback') } }] = []",
    sources: ["new Error('fallback')"],
    what: 'a pattern read from a name the array inherits',
  },
  {
    assignment: "[...{ constructor: e }] = [new Error('ours')]",
    sources: [],
    what: 'a name the array inherits, not an element of the sources',
  },
  {
    assignment: "[...{ foo: e }] = [new Error('ours')]",
    sources: [],
    what: 'a name no element holds, without a default',
  },
  {
    assignment: "[a, ...{ 1: e = new Error('fallback') }] = [0, 1, 2]",
    sources: ['2'],
    what: 'a position the rest holds, beside a default',
  },
  {
    assignment: "[a, ...{ 1: e = new Error('fallback') }] = [0]",
    sources: ["new Error('fallback')"],
    what: 'a position the rest does not reach, beside a default',
  },
  {
    assignment: "[e, ...[a]] = [new Error('ours'), 0]",
    sources: ["new Error('ours')"],
    what: 'a position before the rest',
  },
] as const;

/** A name written as a shorthand beside a default, which binds the variable of that name. */
const SHORTHANDS = [
  {
    assignment: "[...{ length = new Error('fallback') }] = []",
    name: 'length',
    sources: [],
    what: 'a shorthand name of the length of the rest',
  },
  {
    assignment: "[...{ constructor = new Error('fallback') }] = []",
    name: 'constructor',
    sources: [],
    what: 'a shorthand name the array inherits',
  },
  {
    assignment: "[...{ foo = new Error('fallback') }] = []",
    name: 'foo',
    sources: ["new Error('fallback')"],
    what: 'a shorthand name no element holds',
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
    assignment: "[...{ length: values[0] = new Error('fallback') }] = []",
    sources: [],
    what: 'the length of the rest as an element default',
  },
  {
    assignment: "[a, ...{ foo: values[0] = new Error('fallback') }] = [0]",
    sources: ["new Error('fallback')"],
    what: 'a name no element holds as an element default',
  },
  {
    assignment: "[...{ constructor: values[0] = new Error('fallback') }] = []",
    sources: [],
    what: 'a name the array inherits as an element default',
  },
  {
    assignment: "[...{ length: { foo: values[0] = new Error('fallback') } }] = []",
    sources: ["new Error('fallback')"],
    what: 'a pattern read from the length of the rest as an element default',
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

  /** The assignment `assignment` writes in a function, and the `variable` the function returns. */
  function written(
    assignment: string,
    variable = 'e',
  ): {
    readonly assigned: BinaryExpression;
    readonly read: Identifier;
    readonly dispose: () => void;
  } {
    const parsed = api.createSourceFile(
      'pattern-rests.ts',
      `function frames() { let ${variable}: unknown = 0; let a: unknown = 0; const values: unknown[] = [0]; ${assignment}; return ${variable}; }\n`,
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

  it.each(SHORTHANDS)('assigns $what', ({ assignment, name, sources }) => {
    const { assigned, read, dispose } = written(assignment, name);
    try {
      const declared = frameDeclarationOf(read);
      if (declared === undefined) throw new Error(`No declaration of ${name} in ${assignment}.`);
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
