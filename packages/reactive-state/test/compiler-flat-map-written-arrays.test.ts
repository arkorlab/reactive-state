import { type Expression, isArrowFunction, isIdentifier, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { flatMapWrittenArray } from '../src/compiler/framed-flat-map-guards.ts';

/**
 * A `flatMap` mapper's return flattens one layer only where it is an array, and its annotation says
 * so by the names of types: `Array<Error>` names the global array type only where no type of the
 * name is declared or imported where the annotation stands — a type alias, an interface or a
 * type-only import of `Array` names something else, which `flatMap` leaves whole. A value named
 * `Array` hides no type: `Array<Error>` beside `const Array = …` is still the global array type.
 */

const CASES = [
  { array: true, lines: ['function frames(errors: Array<Error>) {'], what: 'the global Array' },
  {
    array: true,
    lines: ['function frames(errors: ReadonlyArray<Error>) {'],
    what: 'the global ReadonlyArray',
  },
  { array: true, lines: ['function frames(errors: readonly Error[]) {'], what: 'an array type' },
  {
    array: false,
    lines: ['type Array<T> = T;', 'function frames(errors: Array<Error>) {'],
    what: 'a type alias named Array',
  },
  {
    array: false,
    lines: ['type ReadonlyArray<T> = T;', 'function frames(errors: ReadonlyArray<Error>) {'],
    what: 'a type alias named ReadonlyArray',
  },
  {
    array: false,
    lines: ['interface Array<T> { item: T }', 'function frames(errors: Array<Error>) {'],
    what: 'an interface named Array',
  },
  {
    array: false,
    lines: ["import type { Array } from './arrays.ts';", 'function frames(errors: Array<Error>) {'],
    what: 'a type-only import named Array',
  },
  {
    after: ['}'],
    array: false,
    lines: [
      'function outer() {',
      '  type Array<T> = T;',
      'function frames(errors: Array<Error>) {',
    ],
    what: 'a type alias of an enclosing block',
  },
  {
    array: true,
    lines: [
      'function other() {',
      '  type Array<T> = T;',
      '  return 0 as unknown as Array<number>;',
      '}',
      'function frames(errors: Array<Error>) {',
    ],
    what: 'a type alias of another block',
  },
  {
    array: true,
    lines: ['const Array = { of: () => 0 };', 'function frames(errors: Array<Error>) {'],
    what: 'a value named Array',
  },
] as const;

describe('the written array a flatMap mapper returns', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `flatMapWrittenArray` answers of `errors`, returned by a `flatMap` mapper after `lines`. */
  function writtenArray(lines: readonly string[], after: readonly string[]): boolean {
    const source = [...lines, '  return [0].flatMap(() => errors)[0];', '}', ...after, ''].join(
      '\n',
    );
    using parsed = api.createSourceFile('flat-map.ts', source);
    let returned: Expression | undefined;
    const visit = (node: Node): void => {
      if (isArrowFunction(node) && isIdentifier(node.body)) {
        returned = node.body;
      }
      node.forEachChild(visit);
    };
    parsed.sourceFile.forEachChild(visit);
    if (returned === undefined) {
      throw new Error('No mapper returns a name.');
    }
    return flatMapWrittenArray(returned);
  }

  it.each(CASES)('of $what', (row) => {
    expect(writtenArray(row.lines, 'after' in row ? row.after : [])).toBe(row.array);
  });
});
