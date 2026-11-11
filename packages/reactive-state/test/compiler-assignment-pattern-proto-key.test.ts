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
 * A pattern that selects `__proto__` reads the source's prototype through the accessor every object
 * inherits, not an own entry of that name. An object literal's `__proto__:` sets its prototype and
 * holds no own property, so `({ __proto__: e = new Error() } = { __proto__: null })` reads nothing and
 * assigns `e` the `Error`. A shorthand `__proto__`, a computed `['__proto__']`, a method or an accessor
 * of that name is an own entry, which the read finds before the accessor, wherever it is written.
 * A `null` prototype holds nothing, so a default beside it runs; the object a prototype literal or
 * name gives is the value read, and a number the literal ignores stays a value that is no error.
 * The accessor belongs to `Object.prototype`, so that a chain which ends in `null` without it reads
 * nothing, `{ __proto__: { __proto__: null } }`, a property named `__proto__` along the chain is the
 * value read instead, and a chain the reader cannot see stays open. Each row is the sources
 * `assignmentPatternSources` gives `e` from the assignment, as written.
 */
const CASES = [
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: null })",
    sources: ["new Error('ours')"],
    what: 'a null prototype, beside a default',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { '__proto__': null })",
    sources: ["new Error('ours')"],
    what: 'a null prototype named by a string, beside a default',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: 1 })",
    sources: ['1'],
    what: 'a prototype that is a number, ignored by the literal',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: (null) })",
    sources: ["new Error('ours')"],
    what: 'a null prototype in parentheses, beside a default',
  },
  { assignment: '({ __proto__: e } = { __proto__: null })', sources: [], what: 'a null prototype' },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { f: 1 })",
    sources: ["new Error('ours')"],
    what: 'no prototype entry, which reads Object.prototype that no source stands for',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: { e: 0 } })",
    sources: ['{ e: 0 }'],
    what: 'a prototype literal, the object read',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: base })",
    sources: ['base', "new Error('ours')"],
    what: 'a prototype the reader cannot see, beside a default',
  },
  {
    assignment: "({ __proto__: e } = { __proto__: new Error('ours') })",
    sources: ["new Error('ours')"],
    what: 'a prototype that is an error',
  },
  {
    assignment: "({ __proto__: { e } } = { __proto__: { e: new Error('ours') } })",
    sources: ["new Error('ours')"],
    what: 'a pattern of the prototype',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: { __proto__: null } })",
    sources: ["new Error('ours')"],
    what: 'a prototype whose own prototype is null, which has no accessor',
  },
  {
    assignment:
      "({ __proto__: e = new Error('ours') } = { __proto__: { __proto__: { __proto__: null } } })",
    sources: ["new Error('ours')"],
    what: 'a chain of prototypes that ends in null',
  },
  {
    assignment: '({ __proto__: e } = { __proto__: { __proto__: null } })',
    sources: [],
    what: 'a prototype whose own prototype is null',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: { ['__proto__']: 0 } })",
    sources: ['0'],
    what: 'a prototype with a property of that name, which shadows the accessor',
  },
  {
    assignment:
      "({ __proto__: e = new Error('ours') } = { __proto__: { __proto__: null, ['__proto__']: 0 } })",
    sources: ['0'],
    what: 'a prototype with a property of that name, and a null prototype',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: { __proto__: { f: 1 } } })",
    sources: ['{ __proto__: { f: 1 } }'],
    what: 'a prototype whose own prototype is an object, which holds the accessor',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: { __proto__: 1 } })",
    sources: ['{ __proto__: 1 }'],
    what: 'a prototype whose own prototype is a number, which the literal ignores',
  },
  {
    assignment:
      "({ __proto__: e = new Error('ours') } = { __proto__: { __proto__: new Error('inner') } })",
    sources: ["{ __proto__: new Error('inner') }"],
    what: 'a prototype whose own prototype is a construction',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: [] })",
    sources: ['[]'],
    what: 'a prototype that is an array',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: { __proto__: base } })",
    sources: [
      '{ __proto__: base }',
      '{ __proto__: { __proto__: base } }.__proto__',
      "new Error('ours')",
    ],
    what: 'a prototype whose own prototype the reader cannot see',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: { __proto__: [] } })",
    sources: ['{ __proto__: [] }'],
    what: 'a prototype whose own prototype is an array',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: { [String(base)]: 0 } })",
    sources: [
      '{ [String(base)]: 0 }',
      '{ __proto__: { [String(base)]: 0 } }.__proto__',
      "new Error('ours')",
    ],
    what: 'a prototype with a computed name the reader cannot see',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: { ...base } })",
    sources: ['{ ...base }', '{ __proto__: { ...base } }.__proto__', "new Error('ours')"],
    what: 'a prototype with a spread, which may hold an own property of that name',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: { __proto__() {} } })",
    sources: ['{ __proto__: { __proto__() {} } }.__proto__', "new Error('ours')"],
    what: 'a prototype with a method of that name, which shadows the accessor',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__, __proto__: null })",
    sources: ['__proto__', "new Error('ours')"],
    what: 'a shorthand name before the prototype',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: null, __proto__ })",
    sources: ['__proto__', "new Error('ours')"],
    what: 'a shorthand name after the prototype',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { ['__proto__']: 0, __proto__: null })",
    sources: ['0'],
    what: 'a computed name before the prototype',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__: null, ['__proto__']: 0 })",
    sources: ['0'],
    what: 'a computed name after the prototype',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { ['__proto__']: 0 })",
    sources: ['0'],
    what: 'a computed name alone',
  },
  {
    assignment: "({ __proto__: e = new Error('ours') } = { __proto__() {}, __proto__: null })",
    sources: ['{ __proto__() {}, __proto__: null }.__proto__', "new Error('ours')"],
    what: 'a method of that name beside the prototype',
  },
  {
    assignment:
      "({ __proto__: e = new Error('ours') } = { get __proto__() { return 1; }, __proto__: null })",
    sources: ['{ get __proto__() { return 1; }, __proto__: null }.__proto__', "new Error('ours')"],
    what: 'an accessor of that name beside the prototype',
  },
] as const;

describe('an assignment pattern selecting __proto__ from an object literal', () => {
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
      'pattern-proto-key.ts',
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
