import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArrayReadingSelection } from '../src/compiler/local-type-array-words.ts';
import {
  namesLocalMemberArrayType,
  namesLocalMemberType,
} from '../src/compiler/local-type-reading.ts';

/**
 * A type parameter no actual argument fills is, to the reader, what its written constraint says:
 * `function f<T extends { e: Error }>(value: T)` holds an `Error` in `value.e`, and `T extends
 * Error[]` holds errors as its elements, however the application calls it. A member or an element
 * is selected through the constraint, through another parameter's, and through an alias. Each row
 * is whether `Error` is the member or the elements of the first parameter; the rows of data and of
 * a parameter that has no constraint pin what the change keeps.
 */
const ERRORS = new Set(['Error']);

const MEMBERS: readonly {
  readonly declarations: string;
  readonly keys: readonly string[];
  readonly names: boolean;
  readonly what: string;
}[] = [
  {
    declarations: 'function frames<T extends { e: Error }>(value: T) { return value; }',
    keys: ['e'],
    names: true,
    what: 'a member of a constraint',
  },
  {
    declarations: 'function frames<T extends { inner: { e: Error } }>(value: T) { return value; }',
    keys: ['inner', 'e'],
    names: true,
    what: 'a member of a member of a constraint',
  },
  {
    declarations:
      'function frames<U extends { e: Error }, T extends U>(value: T) { return value; }',
    keys: ['e'],
    names: true,
    what: 'a constraint that is another parameter',
  },
  {
    declarations:
      'type Holder<T extends { e: Error }> = T; function frames<T extends { e: Error }>(value: Holder<T>) { return value; }',
    keys: ['e'],
    names: true,
    what: 'a constraint reached through an alias',
  },
  {
    declarations: 'function frames<T extends { e: { stack: string } }>(value: T) { return value; }',
    keys: ['e'],
    names: false,
    what: 'a member of data',
  },
  {
    declarations: 'function frames<T>(value: T) { return value; }',
    keys: ['e'],
    names: false,
    what: 'a parameter with no constraint',
  },
  {
    declarations: 'function frames<T extends { e: Error }>(value: T) { return value; }',
    keys: [],
    names: false,
    what: 'the parameter itself, of an object that holds an error',
  },
];

const ELEMENTS: readonly {
  readonly declarations: string;
  readonly selection: ArrayReadingSelection;
  readonly names: boolean;
  readonly what: string;
}[] = [
  {
    declarations: 'function frames<T extends Error[]>(value: T) { return value; }',
    selection: {},
    names: true,
    what: 'the elements of an array constraint',
  },
  {
    declarations: 'function frames<T extends Error[]>(value: T) { return value; }',
    selection: { index: 0 },
    names: true,
    what: 'a place of an array constraint',
  },
  {
    declarations: 'function frames<T extends [string, Error]>(value: T) { return value; }',
    selection: { index: 1 },
    names: true,
    what: 'a place of a tuple constraint',
  },
  {
    declarations: 'function frames<T extends [string, Error]>(value: T) { return value; }',
    selection: { index: 0 },
    names: false,
    what: 'a place of a tuple constraint that holds data',
  },
  {
    declarations: 'function frames<T extends { stack: string }[]>(value: T) { return value; }',
    selection: { index: 0 },
    names: false,
    what: 'the elements of a constraint of data',
  },
  {
    declarations: 'function frames<T>(value: T) { return value; }',
    selection: {},
    names: false,
    what: 'a parameter with no constraint',
  },
];

describe('members and elements selected through a type parameter no argument fills', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `answer` makes of the type written for the first parameter of the function `declarations` declares. */
  function names(declarations: string, answer: (type: TypeNode) => boolean): boolean {
    using parsed = api.createSourceFile('constraints.ts', `${declarations}\n`);
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared in ${declarations}.`);
    return answer(written);
  }

  it.each(MEMBERS)('selects $what', ({ declarations, keys, names: expected }) => {
    expect(names(declarations, (type) => namesLocalMemberType(type, keys, ERRORS))).toBe(expected);
  });

  it.each(ELEMENTS)('selects $what', ({ declarations, selection, names: expected }) => {
    expect(
      names(declarations, (type) => namesLocalMemberArrayType(type, [], ERRORS, selection)),
    ).toBe(expected);
  });
});
