import { isFunctionTypeNode, isTypeAliasDeclaration } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialTypeReading } from '../src/compiler/local-type-environment.ts';
import { actualQueryArgument } from '../src/compiler/local-type-query-argument-scope.ts';
import { writtenReturnReading } from '../src/compiler/local-type-return-results.ts';

/**
 * A written function's own type parameters are read at their constraints, and a constraint may name
 * its own parameter (`T extends { next: T }`): the reading of `T` holds `T`, which is the reading of
 * `T`. A query argument made of such a reading is not written out whole, and the walk over it ends
 * where it meets the reading of a parameter it is inside of, as it ends where a local type comes back
 * to its own arguments. A parameter used twice, one reading met twice side by side, is no cycle.
 */

const CASES = [
  {
    what: 'a parameter that names itself in an object type',
    source: 'type F = <T extends { next: T }>() => T;',
    closed: false,
  },
  {
    what: 'a parameter that names itself two members down',
    source: 'type F = <T extends { next: { again: T } }>() => T;',
    closed: false,
  },
  {
    what: 'a parameter that names itself in the key of an indexed type',
    source: 'type F = <K extends "a" & { self: K }>() => { a: Error }[K];',
    closed: false,
  },
  {
    what: 'a parameter that names itself in a type it returns a member of',
    source: 'type F = <T extends { next: T; value: string }>() => { value: T["value"]; next: T };',
    closed: false,
  },
  {
    what: 'two parameters that name each other',
    source: 'type F = <A extends B, B extends A>() => A;',
    closed: false,
  },
  {
    what: 'a parameter that names itself through a local type (a pin)',
    source: 'interface Box<U> { value: U; }\ntype F = <T extends Box<T>>() => T;',
    closed: false,
  },
  {
    what: 'a parameter whose constraint is written out whole (a pin)',
    source: 'type F = <T extends { next: string }>() => T;',
    closed: true,
  },
  {
    what: 'a parameter used twice (a pin)',
    source: 'type F = <T extends { next: string }>() => [T, T, { again: T }];',
    closed: true,
  },
  {
    what: 'a parameter with no constraint (a pin)',
    source: 'type F = <T>() => { value: T };',
    closed: true,
  },
] as const;

describe('a query argument made of a parameter read at its constraint', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether what the function `F` returns, read at its own parameters' constraints, is written out whole. */
  function closedOf(source: string): boolean {
    using parsed = api.createSourceFile('constraints.ts', source);
    const declaration = parsed.sourceFile.statements.find(
      (statement) => isTypeAliasDeclaration(statement) && statement.name.text === 'F',
    );
    if (declaration === undefined || !isTypeAliasDeclaration(declaration)) {
      throw new Error('the function was not parsed');
    }
    const signature = declaration.type;
    if (!isFunctionTypeNode(signature)) throw new Error('F was not a function');
    const returned = writtenReturnReading(initialTypeReading(signature), signature);
    if (returned === undefined) throw new Error('the function returned nothing');
    return actualQueryArgument(returned);
  }

  it.each(CASES)('reads $what', ({ source, closed }) => {
    expect(closedOf(source)).toBe(closed);
  });
});
