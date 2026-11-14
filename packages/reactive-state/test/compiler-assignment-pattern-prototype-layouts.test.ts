import {
  isBinaryExpression,
  isExpression,
  isForOfStatement,
  isIdentifier,
  isReturnStatement,
  type BinaryExpression,
  type ForOfStatement,
  type Identifier,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type AssignedFrameSource,
  assignmentPatternSources,
  iteratedAssignmentSources,
} from '../src/compiler/framed-assignment-patterns.ts';
import { frameDeclarationOf } from '../src/compiler/framed-bindings.ts';

/**
 * A pattern that selects `__proto__` reads the source's prototype through the accessor every object
 * inherits, unless the prototype or its chain holds a property of that name, which the read finds
 * first: `const base = { ['__proto__']: new Error() }` has such an own property, so that
 * `({ __proto__: e } = { __proto__: base })` assigns `e` the `Error`, not `base`. So does an instance
 * whose class writes the field `['__proto__']`, or whose constructor defines it. A prototype the
 * reader cannot see into, a name, a call, a construction, a cast of one, therefore keeps the selection
 * open, beside the prototype itself; one it can, an array literal, a number the literal ignores, a
 * literal that holds no such entry, is the value read. Each row is the sources `assignmentPatternSources`
 * (or, for a loop, `iteratedAssignmentSources`) gives `e` from the statement, as written.
 */
const CASES = [
  {
    id: 'name',
    statement: '({ __proto__: e } = { __proto__: base })',
    sources: ['base', '{ __proto__: base }.__proto__'],
    what: 'a prototype that is a name',
  },
  {
    id: 'name-string-key',
    statement: "({ __proto__: e } = { '__proto__': base })",
    sources: ['base', "{ '__proto__': base }.__proto__"],
    what: 'a prototype set by a string key',
  },
  {
    id: 'name-parenthesized',
    statement: '({ __proto__: e } = { __proto__: (base) })',
    sources: ['(base)', '{ __proto__: (base) }.__proto__'],
    what: 'a prototype in parentheses',
  },
  {
    id: 'name-as',
    statement: '({ __proto__: e } = { __proto__: base as object })',
    sources: ['base as object', '{ __proto__: base as object }.__proto__'],
    what: 'a prototype under `as`',
  },
  {
    id: 'name-satisfies',
    statement: '({ __proto__: e } = { __proto__: base satisfies object })',
    sources: ['base satisfies object', '{ __proto__: base satisfies object }.__proto__'],
    what: 'a prototype under `satisfies`',
  },
  {
    id: 'name-non-null',
    statement: '({ __proto__: e } = { __proto__: base! })',
    sources: ['base!', '{ __proto__: base! }.__proto__'],
    what: 'a prototype under `!`',
  },
  {
    id: 'name-computed-pattern-key',
    statement: "({ ['__proto__']: e } = { __proto__: base })",
    sources: ['base', '{ __proto__: base }.__proto__'],
    what: 'a computed `__proto__` in the pattern',
  },
  {
    id: 'name-string-pattern-key',
    statement: "({ '__proto__': e } = { __proto__: base })",
    sources: ['base', '{ __proto__: base }.__proto__'],
    what: 'a string `__proto__` in the pattern',
  },
  {
    id: 'name-default',
    statement: "({ __proto__: e = new Error('ours') } = { __proto__: base })",
    sources: ['base', '{ __proto__: base }.__proto__', "new Error('ours')"],
    what: 'a prototype that is a name, beside a default',
  },
  {
    id: 'name-nested-pattern',
    statement: '({ __proto__: { e } } = { __proto__: base })',
    sources: ['base.e', '{ __proto__: base }.__proto__.e'],
    what: 'a pattern of the prototype that is a name',
  },
  {
    id: 'name-in-a-loop',
    statement: 'for ({ __proto__: e } of [{ __proto__: base }]) {}',
    sources: ['base', '{ __proto__: base }.__proto__'],
    what: 'a prototype that is a name, in a loop',
  },
  {
    id: 'call',
    statement: '({ __proto__: e } = { __proto__: make() })',
    sources: ['make()', '{ __proto__: make() }.__proto__'],
    what: 'a prototype that is a call',
  },
  {
    id: 'construction',
    statement: '({ __proto__: e } = { __proto__: new Stamp() })',
    sources: ['new Stamp()', '{ __proto__: new Stamp() }.__proto__'],
    what: 'a prototype that is a construction',
  },
  {
    id: 'construction-parenthesized',
    statement: '({ __proto__: e } = { __proto__: (new Stamp()) })',
    sources: ['(new Stamp())', '{ __proto__: (new Stamp()) }.__proto__'],
    what: 'a prototype that is a construction in parentheses',
  },
  {
    id: 'construction-as',
    statement: '({ __proto__: e } = { __proto__: new Stamp() as object })',
    sources: ['new Stamp() as object', '{ __proto__: new Stamp() as object }.__proto__'],
    what: 'a prototype that is a construction under `as`',
  },
  {
    id: 'construction-in-a-chain',
    statement: '({ __proto__: e } = { __proto__: { __proto__: new Stamp() } })',
    sources: ['{ __proto__: new Stamp() }', '{ __proto__: { __proto__: new Stamp() } }.__proto__'],
    what: 'a prototype whose own prototype is a construction',
  },
  {
    id: 'construction-default',
    statement: "({ __proto__: e = new Error('ours') } = { __proto__: new Stamp() })",
    sources: ['new Stamp()', '{ __proto__: new Stamp() }.__proto__', "new Error('ours')"],
    what: 'a prototype that is a construction, beside a default',
  },
  {
    id: 'construction-in-a-loop',
    statement: 'for ({ __proto__: e } of [{ __proto__: new Stamp() }]) {}',
    sources: ['new Stamp()', '{ __proto__: new Stamp() }.__proto__'],
    what: 'a prototype that is a construction, in a loop',
  },
  {
    id: 'array-pin',
    statement: '({ __proto__: e } = { __proto__: [] })',
    sources: ['[]'],
    what: 'a prototype that is an array literal, which writes no such property',
  },
  {
    id: 'number-pin',
    statement: '({ __proto__: e } = { __proto__: 1 })',
    sources: ['1'],
    what: 'a prototype that is a number, ignored by the literal',
  },
  {
    id: 'literal-pin',
    statement: '({ __proto__: e } = { __proto__: { f: 1 } })',
    sources: ['{ f: 1 }'],
    what: 'a prototype that is a literal without such an entry',
  },
  {
    id: 'literal-array-chain-pin',
    statement: '({ __proto__: e } = { __proto__: { __proto__: [] } })',
    sources: ['{ __proto__: [] }'],
    what: 'a prototype whose own prototype is an array literal',
  },
  {
    id: 'null-pin',
    statement: '({ __proto__: e } = { __proto__: null })',
    sources: [],
    what: 'a null prototype, which holds nothing',
  },
  {
    id: 'own-computed-pin',
    statement: "({ __proto__: e } = { __proto__: { ['__proto__']: base } })",
    sources: ['base'],
    what: 'a literal prototype with an own property of that name, the value read',
  },
  {
    id: 'other-key-pin',
    statement: '({ e } = { __proto__: base })',
    sources: ['base.e'],
    what: 'a key other than `__proto__`, which the prototype is selected for',
  },
] as const;

/** Each source as it is written, with the path selected on it. */
function pathsOf(found: readonly AssignedFrameSource[]): readonly string[] {
  return found.map((source) => [source.value.getText(), ...source.keys].join('.'));
}

describe('an assignment pattern selecting __proto__ from a prototype whose layout is unknown', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The sources the assignment or the loop of `statement` gives `e`, as written. */
  function assigned(statement: string): readonly string[] {
    using parsed = api.createSourceFile(
      'pattern-prototype-layouts.ts',
      [
        'declare const base: { e: Error };',
        'declare function make(): object;',
        "class Stamp { ['__proto__'] = new Error('field'); }",
        `function frames() { let e: unknown = 0; ${statement}; return e; }`,
        '',
      ].join('\n'),
    );
    let written: BinaryExpression | undefined;
    let loop: ForOfStatement | undefined;
    let read: Identifier | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (written === undefined && isBinaryExpression(at) && isExpression(at.left)) written = at;
      if (isForOfStatement(at)) loop = at;
      if (isReturnStatement(at) && at.expression !== undefined && isIdentifier(at.expression))
        read = at.expression;
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    const declared = read === undefined ? undefined : frameDeclarationOf(read);
    if (read === undefined || declared === undefined) {
      throw new Error(`No e is declared in ${statement}.`);
    }
    const target = loop?.initializer;
    if (loop !== undefined && target !== undefined && isExpression(target))
      return pathsOf(iteratedAssignmentSources(target, loop.expression, read, declared));
    if (written === undefined) throw new Error(`No assignment is written in ${statement}.`);
    return pathsOf(assignmentPatternSources(written.left, written.right, read, declared));
  }

  it.each(CASES)('$id: $what', ({ statement, sources }) => {
    expect(assigned(statement)).toStrictEqual(sources);
  });
});
