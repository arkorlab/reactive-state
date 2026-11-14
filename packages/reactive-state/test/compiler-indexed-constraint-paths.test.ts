import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { namesLocalMemberType } from '../src/compiler/local-type-reading.ts';

/**
 * What an indexed access keeps of the path to its object is the constraints that object was read
 * through, so `T extends { a: T['a'] }` ends as the cycle it is, and nothing else: member
 * selection starts a path anew, the aliases already expanded included, so a recursive alias read
 * through its own members (`Box['next']['error']`) is read as many times as it is written, and what
 * one object of an intersection or of a union expanded does not reach what another's member
 * selects. Each row is whether `Error` is what the first parameter's written type names; the rows
 * of a constraint that names itself pin that each of them ends.
 */
const ERRORS = new Set(['Error']);

const ROWS: readonly {
  readonly id: string;
  readonly declarations: string;
  readonly names: boolean;
}[] = [
  {
    id: 'a recursive alias read through its member',
    declarations:
      "type Box = { next: Box; error: Error }; function frames(value: Box['next']['error']) {}",
    names: true,
  },
  {
    id: 'a recursive alias read through its member twice',
    declarations:
      "type Box = { next: Box; error: Error }; function frames(value: Box['next']['next']['error']) {}",
    names: true,
  },
  {
    id: 'a recursive alias whose member is named inner',
    declarations:
      "type Box = { inner: Box; e: Error }; function frames(value: Box['inner']['e']) {}",
    names: true,
  },
  {
    id: 'a recursive alias with an actual argument',
    declarations:
      "type Box<T> = { next: Box<T>; v: T }; function frames(value: Box<Error>['next']['next']['v']) {}",
    names: true,
  },
  {
    id: 'a recursive alias with an argument that is a parameter',
    declarations:
      "type Box<T> = { next: Box<T>; v: T }; function frames<T extends Error>(value: Box<T>['next']['next']['v']) {}",
    names: true,
  },
  {
    id: 'a recursive alias whose field reads the argument',
    declarations:
      "type Box<T> = { next: Box<T>; v: T['x'] }; function frames<T extends { x: Error }>(value: Box<T>['next']['next']['v']) {}",
    names: true,
  },
  {
    id: 'a recursive alias that is the constraint',
    declarations:
      "type Box = { next: Box; error: Error }; function frames<T extends Box>(value: T['next']['error']) {}",
    names: true,
  },
  {
    id: 'a recursive alias that is a member of the constraint',
    declarations:
      "type Box = { next: Box; error: Error }; function frames<T extends { b: Box }>(value: T['b']['next']['error']) {}",
    names: true,
  },
  {
    id: 'a field that reads an alias another object of an intersection expanded',
    declarations:
      "type A = { b: Error }; type B = { a: A['b'] }; function frames(value: (A & B)['a']) {}",
    names: true,
  },
  {
    id: 'a member of one alternative of a constraint, an alias expanded by the other',
    declarations:
      "type Wrapper = { e: Error }; function frames<T extends Wrapper | { inner: Wrapper }>(value: T['inner']['e']) {}",
    names: true,
  },
  {
    id: 'a member of one alternative of a constraint, the alternatives the other way',
    declarations:
      "type Wrapper = { e: Error }; function frames<T extends { inner: Wrapper } | Wrapper>(value: T['inner']['e']) {}",
    names: true,
  },
  {
    id: 'a constraint that names its own member',
    declarations: "function frames<T extends { a: T['a'] }>(value: T['a']) {}",
    names: false,
  },
  {
    id: 'a constraint that names its own member beside an error',
    declarations: "function frames<T extends { a: Error | T['a'] }>(value: T['a']) {}",
    names: true,
  },
  {
    id: 'a constraint that names its own member twice',
    declarations: "function frames<T extends { next: T['next']['next'] }>(value: T['next']) {}",
    names: false,
  },
  {
    id: 'a constraint that names its own member through an alias',
    declarations:
      "type Get<U> = U['a']; function frames<T extends { a: Get<T> }>(value: T['a']) {}",
    names: false,
  },
  {
    id: 'a constraint that names its own member through an alias beside an error',
    declarations:
      "type Get<U> = U['a']; function frames<T extends { a: Get<T> | Error }>(value: T['a']) {}",
    names: true,
  },
  {
    id: 'a constraint that names its own member through an alias used twice',
    declarations:
      "type Next<U> = U['next']; function frames<T extends { next: Next<Next<T>> }>(value: T['next']) {}",
    names: false,
  },
  {
    id: 'a constraint that names its own keys',
    declarations: 'function frames<T extends { a: T[keyof T] }>(value: T[keyof T]) {}',
    names: false,
  },
  {
    id: 'constraints that name each other',
    declarations:
      "function frames<T extends { a: U['a'] }, U extends { a: T['a'] }>(value: T['a']) {}",
    names: false,
  },
  {
    id: 'three constraints that name one another',
    declarations:
      "function frames<T0 extends { a: T0['a'] | T1['a'] | T2['a'] }, T1 extends { a: T0['a'] | T1['a'] | T2['a'] }, T2 extends { a: T0['a'] | T1['a'] | T2['a']; e: Error }>(value: T0['a']) {}",
    names: false,
  },
  {
    id: 'three constraints that name one another beside an error',
    declarations:
      "function frames<T0 extends { a: T0['a'] | T1['a'] | T2['a'] }, T1 extends { a: T0['a'] | T1['a'] | T2['a'] }, T2 extends { a: T0['a'] | T1['a'] | T2['a'] | Error }>(value: T0['a']) {}",
    names: true,
  },
  {
    id: 'a constraint that is itself, read through its member three times',
    declarations: "function frames<T extends { a: T }>(value: T['a']['a']['a']) {}",
    names: false,
  },
];

describe('the path an indexed access keeps to its object', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What the type written for the first parameter of the function `declarations` declares names. */
  function names(declarations: string): boolean {
    using parsed = api.createSourceFile('paths.ts', `${declarations}\n`);
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared in ${declarations}.`);
    return namesLocalMemberType(written, [], ERRORS);
  }

  it.each(ROWS)('reads $id', ({ declarations, names: expected }) => {
    expect(names(declarations)).toBe(expected);
  });
});
