import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArrayReadingSelection } from '../src/compiler/local-type-array-words.ts';
import {
  namesLocalMemberArrayType,
  namesLocalMemberType,
} from '../src/compiler/local-type-reading.ts';

/**
 * An indexed access reads the same written constraint as the member path it spells. A type
 * parameter no actual argument fills is, to the reader, what its constraint says, so
 * `function frames<T extends { e: Error }>(value: T['e'])` holds an `Error` as `value: T` holds one at
 * `e`, whether the object, the index or the key set of the access is the parameter. Each row is
 * whether `Error` is what the first parameter's written type, at the keys, names. The rows that
 * hold data, that have no constraint, and the constraints that name their own parameter pin what
 * the change keeps: none of them reads an Error that is not written, and each ends.
 */
const ERRORS = new Set(['Error']);

const MEMBERS: readonly {
  readonly id: string;
  readonly declarations: string;
  readonly keys: readonly string[];
  readonly names: boolean;
}[] = [
  {
    id: 'a member of a constraint',
    declarations: "function frames<T extends { e: Error }>(value: T['e']) {}",
    keys: [],
    names: true,
  },
  {
    id: 'a place of an array constraint',
    declarations: 'function frames<T extends Error[]>(value: T[number]) {}',
    keys: [],
    names: true,
  },
  {
    id: 'a place of a tuple constraint that holds an error',
    declarations: 'function frames<T extends [string, Error]>(value: T[1]) {}',
    keys: [],
    names: true,
  },
  {
    id: 'a place of a tuple constraint that holds data',
    declarations: 'function frames<T extends [string, Error]>(value: T[0]) {}',
    keys: [],
    names: false,
  },
  {
    id: 'a member of a member of a constraint',
    declarations: "function frames<T extends { inner: { e: Error } }>(value: T['inner']['e']) {}",
    keys: [],
    names: true,
  },
  {
    id: 'a member selected on after the access',
    declarations: "function frames<T extends { inner: { e: Error } }>(value: T['inner']) {}",
    keys: ['e'],
    names: true,
  },
  {
    id: 'a member of an element of an array constraint',
    declarations: "function frames<T extends { e: Error }[]>(value: T[number]['e']) {}",
    keys: [],
    names: true,
  },
  {
    id: 'a constraint that is another parameter',
    declarations: "function frames<U extends { e: Error }, T extends U>(value: T['e']) {}",
    keys: [],
    names: true,
  },
  {
    id: 'a constraint reached through an alias',
    declarations:
      "type Holder<T extends { e: Error }> = T; function frames<T extends { e: Error }>(value: Holder<T>['e']) {}",
    keys: [],
    names: true,
  },
  {
    id: 'a constraint reached through an intersection',
    declarations: "function frames<T extends { e: Error }>(value: (T & { x: 1 })['e']) {}",
    keys: [],
    names: true,
  },
  {
    id: 'a constraint reached through a native utility',
    declarations: "function frames<T extends { e: Error }>(value: Pick<T, 'e'>['e']) {}",
    keys: [],
    names: true,
  },
  {
    id: 'a constraint of alternatives, one holding an error',
    declarations: "function frames<T extends { e: Error } | { e: string }>(value: T['e']) {}",
    keys: [],
    names: true,
  },
  {
    id: 'an index that is a parameter with a constraint',
    declarations: "function frames<T extends { e: Error }, K extends 'e'>(value: T[K]) {}",
    keys: [],
    names: true,
  },
  {
    id: 'an index that is the keys of the parameter',
    declarations: 'function frames<T extends { e: Error }>(value: T[keyof T]) {}',
    keys: [],
    names: true,
  },
  {
    id: 'a member of data',
    declarations: "function frames<T extends { e: { stack: string } }>(value: T['e']) {}",
    keys: [],
    names: false,
  },
  {
    id: 'a place of an array of data',
    declarations: 'function frames<T extends { stack: string }[]>(value: T[number]) {}',
    keys: [],
    names: false,
  },
  {
    id: 'a member the constraint does not have',
    declarations: "function frames<T extends { e: Error }>(value: T['x']) {}",
    keys: [],
    names: false,
  },
  {
    id: 'a parameter with no constraint',
    declarations: "function frames<T>(value: T['e']) {}",
    keys: [],
    names: false,
  },
  {
    id: 'a parameter filled by an actual argument that holds an error',
    declarations: "type Get<T> = T['e']; function frames(value: Get<{ e: Error }>) {}",
    keys: [],
    names: true,
  },
  {
    id: 'a parameter filled by an actual argument that holds data',
    declarations:
      "type Get<T extends { e: unknown }> = T['e']; function frames(value: Get<{ e: string }>) {}",
    keys: [],
    names: false,
  },
  {
    id: 'a constraint that names its own member',
    declarations: "function frames<T extends { a: T['a'] }>(value: T['a']) {}",
    keys: [],
    names: false,
  },
  {
    id: 'a constraint that names its own member beside an error',
    declarations: "function frames<T extends { a: Error | T['a'] }>(value: T['a']) {}",
    keys: [],
    names: true,
  },
  {
    id: 'a constraint that names its own member, selected on',
    declarations: "function frames<T extends { a: T['a'] }>(value: T['a']) {}",
    keys: ['e'],
    names: false,
  },
  {
    id: 'a constraint that names its own keys',
    declarations: 'function frames<T extends { a: T[keyof T] }>(value: T[keyof T]) {}',
    keys: [],
    names: false,
  },
  {
    id: 'constraints that name each other',
    declarations:
      "function frames<T extends { a: U['a'] }, U extends { a: T['a'] }>(value: T['a']) {}",
    keys: [],
    names: false,
  },
  {
    id: 'constraints that name each other beside an error',
    declarations:
      "function frames<T extends { a: U['a'] | Error }, U extends { a: T['a'] }>(value: U['a']) {}",
    keys: [],
    names: true,
  },
];

const ELEMENTS: readonly {
  readonly id: string;
  readonly declarations: string;
  readonly selection: ArrayReadingSelection;
  readonly names: boolean;
}[] = [
  {
    id: 'the elements of a member that is an array of errors',
    declarations: "function frames<T extends { list: Error[] }>(value: T['list']) {}",
    selection: {},
    names: true,
  },
  {
    id: 'the elements of a place that is an array of errors',
    declarations: 'function frames<T extends Error[][]>(value: T[number]) {}',
    selection: {},
    names: true,
  },
  {
    id: 'the elements of a member that is an array of data',
    declarations: "function frames<T extends { list: { stack: string }[] }>(value: T['list']) {}",
    selection: {},
    names: false,
  },
];

/** The same written constraint, spelled as an access of the parameter and as the parameter itself. */
const AGREEMENTS: readonly {
  readonly id: string;
  readonly indexed: string;
  readonly direct: string;
  readonly keys: readonly string[];
}[] = [
  {
    id: 'an error member',
    indexed: "function frames<T extends { e: Error }>(value: T['e']) {}",
    direct: 'function frames<T extends { e: Error }>(value: T) {}',
    keys: ['e'],
  },
  {
    id: 'a member of data',
    indexed: "function frames<T extends { e: { stack: string } }>(value: T['e']) {}",
    direct: 'function frames<T extends { e: { stack: string } }>(value: T) {}',
    keys: ['e'],
  },
  {
    id: 'a member of a member',
    indexed: "function frames<T extends { inner: { e: Error } }>(value: T['inner']['e']) {}",
    direct: 'function frames<T extends { inner: { e: Error } }>(value: T) {}',
    keys: ['inner', 'e'],
  },
  {
    id: 'a tuple place',
    indexed: 'function frames<T extends [string, Error]>(value: T[1]) {}',
    direct: 'function frames<T extends [string, Error]>(value: T) {}',
    keys: ['1'],
  },
];

describe('an indexed access of a type parameter no argument fills', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `answer` makes of the type written for the first parameter of the function `declarations` declares. */
  function names(declarations: string, answer: (type: TypeNode) => boolean): boolean {
    using parsed = api.createSourceFile('indexed.ts', `${declarations}\n`);
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared in ${declarations}.`);
    return answer(written);
  }

  it.each(MEMBERS)('selects $id', ({ declarations, keys, names: expected }) => {
    expect(names(declarations, (type) => namesLocalMemberType(type, keys, ERRORS))).toBe(expected);
  });

  it.each(ELEMENTS)('selects $id', ({ declarations, selection, names: expected }) => {
    expect(
      names(declarations, (type) => namesLocalMemberArrayType(type, [], ERRORS, selection)),
    ).toBe(expected);
  });

  it.each(AGREEMENTS)('answers $id as the member path does', ({ indexed, direct, keys }) => {
    const spelled = names(indexed, (type) => namesLocalMemberType(type, [], ERRORS));

    expect(spelled).toBe(names(direct, (type) => namesLocalMemberType(type, keys, ERRORS)));
  });
});
