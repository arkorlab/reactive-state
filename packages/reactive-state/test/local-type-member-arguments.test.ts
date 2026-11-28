import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { namesLocalMemberTypeArgument } from '../src/compiler/local-type-member-arguments.ts';

/**
 * The actual argument of a native reference that stands at a member path of a declared type: a
 * `Set<Error>` held in `options.list`, a `Map<string, Error>` in a rest of a tuple, and the types
 * those are written through (an alias, a parameter's constraint, a union with `undefined`). Each row
 * is whether the argument at the index names `Error`; the rows of another argument, of another kind
 * of reference and of a path nothing is written at pin what it keeps.
 */
const ERRORS = new Set(['Error']);
const SETS = new Set(['ReadonlySet', 'Set']);
const MAPS = new Set(['Map', 'ReadonlyMap']);
const ITERABLES = new Set(['Iterable', 'IterableIterator']);

const ROWS: readonly {
  readonly declarations: string;
  readonly keys: readonly string[];
  readonly natives: ReadonlySet<string>;
  readonly index: number;
  readonly names: boolean;
  readonly what: string;
}[] = [
  {
    declarations: 'function frames(value: Set<Error>) { return value; }',
    keys: [],
    natives: SETS,
    index: 0,
    names: true,
    what: 'a Set that holds errors, at no path',
  },
  {
    declarations: 'function frames(value: { list: Set<Error> }) { return value; }',
    keys: ['list'],
    natives: SETS,
    index: 0,
    names: true,
    what: 'a Set that holds errors, in a member',
  },
  {
    declarations:
      'function frames(value: { inner: { list: ReadonlySet<Error> } }) { return value; }',
    keys: ['inner', 'list'],
    natives: SETS,
    index: 0,
    names: true,
    what: 'a ReadonlySet that holds errors, in a member of a member',
  },
  {
    declarations: 'function frames(value: { list?: Set<Error> }) { return value; }',
    keys: ['list'],
    natives: SETS,
    index: 0,
    names: true,
    what: 'a Set that holds errors, in an optional member',
  },
  {
    declarations: 'function frames(value: Set<Error> | undefined) { return value; }',
    keys: [],
    natives: SETS,
    index: 0,
    names: true,
    what: 'a Set that holds errors, beside undefined',
  },
  {
    declarations:
      'type Failures = Set<Error>; function frames(value: { list: Failures }) { return value; }',
    keys: ['list'],
    natives: SETS,
    index: 0,
    names: true,
    what: 'a Set that holds errors, through an alias',
  },
  {
    declarations: 'function frames<T extends { list: Set<Error> }>(value: T) { return value; }',
    keys: ['list'],
    natives: SETS,
    index: 0,
    names: true,
    what: 'a Set that holds errors, in a member of a constraint',
  },
  {
    declarations: 'function frames(value: Map<string, Error>) { return value; }',
    keys: [],
    natives: MAPS,
    index: 1,
    names: true,
    what: 'the values of a Map that holds errors',
  },
  {
    declarations: 'function frames(value: Map<string, Error>) { return value; }',
    keys: [],
    natives: MAPS,
    index: 0,
    names: false,
    what: 'the keys of a Map that holds errors as values',
  },
  {
    declarations: 'function frames(value: Map<Error, string>) { return value; }',
    keys: [],
    natives: MAPS,
    index: 0,
    names: true,
    what: 'the keys of a Map whose keys are errors',
  },
  {
    declarations: 'function frames(value: { cache: ReadonlyMap<string, Error> }) { return value; }',
    keys: ['cache'],
    natives: MAPS,
    index: 1,
    names: true,
    what: 'the values of a ReadonlyMap that holds errors, in a member',
  },
  {
    declarations: 'function frames(value: { list: Iterable<Error> }) { return value; }',
    keys: ['list'],
    natives: ITERABLES,
    index: 0,
    names: true,
    what: 'an Iterable of errors, in a member',
  },
  {
    declarations: 'function frames(value: { list: Set<string> }) { return value; }',
    keys: ['list'],
    natives: SETS,
    index: 0,
    names: false,
    what: 'a Set of text',
  },
  {
    declarations: 'function frames(value: { list: Set<{ stack: string }> }) { return value; }',
    keys: ['list'],
    natives: SETS,
    index: 0,
    names: false,
    what: 'a Set of data',
  },
  {
    declarations: 'function frames(value: { list: Error[] }) { return value; }',
    keys: ['list'],
    natives: SETS,
    index: 0,
    names: false,
    what: 'an array, which is no Set',
  },
  {
    declarations: 'function frames(value: { list: Set<Error> }) { return value; }',
    keys: ['list'],
    natives: MAPS,
    index: 0,
    names: false,
    what: 'a Set, which is no Map',
  },
  {
    declarations: 'function frames(value: { other: Set<Error> }) { return value; }',
    keys: ['list'],
    natives: SETS,
    index: 0,
    names: false,
    what: 'a path nothing is written at',
  },
  {
    declarations: 'function frames(value: { list: Set<Error> }) { return value; }',
    keys: [],
    natives: SETS,
    index: 0,
    names: false,
    what: 'the object that holds a Set of errors',
  },
];

describe('the argument of a native reference at a member path of a declared type', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `answer` makes of the type written for the first parameter of the function `declarations` declares. */
  function names(declarations: string, answer: (type: TypeNode) => boolean): boolean {
    using parsed = api.createSourceFile('member-arguments.ts', `${declarations}\n`);
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared in ${declarations}.`);
    return answer(written);
  }

  it.each(ROWS)('reads $what', ({ declarations, keys, natives, index, names: expected }) => {
    expect(
      names(declarations, (type) =>
        namesLocalMemberTypeArgument(type, keys, { nativeNames: natives, index }, ERRORS),
      ),
    ).toBe(expected);
  });
});
