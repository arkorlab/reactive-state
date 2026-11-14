import {
  isBinaryExpression,
  isExpression,
  isIdentifier,
  isReturnStatement,
  type BinaryExpression,
  type Identifier,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assignmentPatternSources } from '../src/compiler/framed-assignment-patterns.ts';
import { frameDeclarationOf } from '../src/compiler/framed-bindings.ts';

/**
 * A destructuring reads an inherited property as an own one, and an object literal's `__proto__:`
 * sets its prototype, so that `({ e } = { __proto__: { e: new Error() } })` assigns `e` the `Error`.
 * An own entry, wherever it is written, still wins over the prototype's; a prototype the reader
 * cannot see keeps the selection opaque, and one that is no object, `null` or a number, holds
 * nothing. A computed `['__proto__']` or a shorthand `__proto__` is an own entry, not a prototype.
 * Each row is the sources `assignmentPatternSources` gives `e` from the assignment, as written.
 */
const CASES = [
  {
    assignment: "({ e } = { __proto__: { e: new Error('ours') } })",
    sources: ["new Error('ours')"],
    what: 'a prototype literal that holds the key',
  },
  {
    assignment: "({ e } = { __proto__: { __proto__: { e: new Error('ours') } } })",
    sources: ["new Error('ours')"],
    what: 'a prototype of a prototype',
  },
  {
    assignment: "({ e } = { '__proto__': { e: new Error('ours') } })",
    sources: ["new Error('ours')"],
    what: 'a prototype named by a string',
  },
  {
    assignment: "({ e } = { e: 0, __proto__: { e: new Error('ours') } })",
    sources: ['0'],
    what: 'an own entry before the prototype',
  },
  {
    assignment: "({ e } = { __proto__: { e: new Error('ours') }, e: 0 })",
    sources: ['0'],
    what: 'an own entry after the prototype',
  },
  {
    assignment: '({ e } = { __proto__: base })',
    sources: ['base.e'],
    what: 'a prototype the reader cannot see',
  },
  {
    assignment: "({ e = new Error('ours') } = { __proto__: { e: 0 } })",
    sources: ['0'],
    what: 'a prototype that holds the key, beside a default',
  },
  {
    assignment: "({ e = new Error('ours') } = { __proto__: { f: 1 } })",
    sources: ["new Error('ours')"],
    what: 'a prototype without the key, beside a default',
  },
  {
    assignment: "({ e = new Error('ours') } = { __proto__: null })",
    sources: ["new Error('ours')"],
    what: 'a null prototype, beside a default',
  },
  {
    assignment: "({ e = new Error('ours') } = { __proto__: 1 })",
    sources: ["new Error('ours')"],
    what: 'a prototype that is a number, beside a default',
  },
  {
    assignment: "({ e } = { ['__proto__']: { e: new Error('ours') } })",
    sources: [],
    what: 'a computed name, an own entry',
  },
  {
    assignment: '({ e } = { __proto__, e: 0 })',
    sources: ['0'],
    what: 'a shorthand name, an own entry',
  },
  { assignment: '({ e } = { e: 0 })', sources: ['0'], what: 'an own entry alone' },
  { assignment: '({ e } = {})', sources: [], what: 'no entry at all' },
] as const;

describe('an assignment pattern selecting from an object literal with a prototype', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The sources `assignmentPatternSources` gives `e` from `assignment`, as written. */
  function assigned(assignment: string): readonly string[] {
    using parsed = api.createSourceFile(
      'pattern-prototypes.ts',
      `declare const base: { e: Error };\nfunction frames() { let e: unknown = 0; const __proto__ = 1; ${assignment}; return e; }\n`,
    );
    let written: BinaryExpression | undefined;
    let read: Identifier | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (written === undefined && isBinaryExpression(at) && isExpression(at.left)) written = at;
      if (isReturnStatement(at) && at.expression !== undefined && isIdentifier(at.expression))
        read = at.expression;
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    const declared = read === undefined ? undefined : frameDeclarationOf(read);
    if (written === undefined || read === undefined || declared === undefined) {
      throw new Error(`No assignment is written in ${assignment}.`);
    }
    return assignmentPatternSources(written.left, written.right, read, declared).map((source) =>
      [source.value.getText(), ...source.keys].join('.'),
    );
  }

  it.each(CASES)('$what', ({ assignment, sources }) => {
    expect(assigned(assignment)).toStrictEqual(sources);
  });
});
