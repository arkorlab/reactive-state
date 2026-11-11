import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArrayReadingSelection } from '../src/compiler/local-type-array-words.ts';
import {
  namesLocalMemberArrayType,
  namesLocalMemberType,
} from '../src/compiler/local-type-reading.ts';

/**
 * A rest of a tuple the reader cannot expand, an array's, with members after it, leaves the places
 * from its own on uncertain: `[...Error[], string]`'s place 0 is an `Error` where the rest holds one
 * and the `string` where it holds none, and any place after the rest's start may hold a member of
 * the rest or one after it. Every element may stand there, as at a place TypeScript's static type
 * reads as the union of them all. The places before the rest, a rest the reader expands, a finite
 * tuple, and a rest with no member after it keep the elements they hold; each row is whether `Error`
 * is among those a place may hold at run time. A member written by its position, `values[0]`, reads
 * a tuple's places the same way.
 */
const CASES: readonly {
  readonly declarations: string;
  readonly type: string;
  readonly selection: ArrayReadingSelection;
  readonly names: boolean;
  readonly what: string;
}[] = [
  {
    declarations: 'type Values = [...Error[], string];',
    type: 'Values',
    selection: { index: 0 },
    names: true,
    what: 'a leading rest, place 0',
  },
  {
    declarations: 'type Values = [string, ...Error[], string];',
    type: 'Values',
    selection: { index: 1 },
    names: true,
    what: 'a rest between fields, its first place',
  },
  {
    declarations: 'type Values = [string, ...Error[], string];',
    type: 'Values',
    selection: { index: 5 },
    names: true,
    what: 'a place far after a rest between fields',
  },
  {
    declarations: 'type Errors = Error[]; type Values = [...Errors, string];',
    type: 'Values',
    selection: { index: 0 },
    names: true,
    what: 'an aliased leading rest',
  },
  {
    declarations: 'type Spread<T extends unknown[]> = [...T, string];',
    type: 'Spread<Error[]>',
    selection: { index: 0 },
    names: true,
    what: 'a generic leading rest of an array',
  },
  {
    declarations: 'type Values = [...Error[], ...string[]];',
    type: 'Values',
    selection: { index: 0 },
    names: true,
    what: 'two rests, the first of errors',
  },
  {
    declarations: 'type Values = [string, string, ...Error[], string];',
    type: 'Values',
    selection: { index: 1 },
    names: false,
    what: 'a place before the rest',
  },
  {
    declarations: 'type Values = [string, ...string[], string];',
    type: 'Values',
    selection: { index: 1 },
    names: false,
    what: 'a rest of data between fields',
  },
  {
    declarations: 'type Values = [string, ...Error[]];',
    type: 'Values',
    selection: { index: 1 },
    names: true,
    what: 'a rest with no member after it, its first place',
  },
  {
    declarations: 'type Values = [Error, ...string[]];',
    type: 'Values',
    selection: { index: 1 },
    names: false,
    what: 'a rest of data with no member after it',
  },
  {
    declarations: 'type Pair = [Error, number]; type Values = [...Pair, string];',
    type: 'Values',
    selection: { index: 1 },
    names: false,
    what: 'a finite tuple rest, the place of its number',
  },
  {
    declarations: 'type Pair = [Error, number]; type Values = [...Pair, string];',
    type: 'Values',
    selection: { index: 0 },
    names: true,
    what: 'a finite tuple rest, the place of its error',
  },
  {
    declarations: 'type Pair = [Error, number]; type Values = [...Pair, ...Error[], string];',
    type: 'Values',
    selection: { index: 2 },
    names: true,
    what: 'a finite tuple rest before an array rest',
  },
];

const MEMBERS: readonly {
  readonly declarations: string;
  readonly key: string;
  readonly names: boolean;
  readonly what: string;
}[] = [
  {
    declarations: 'type Values = [...Error[], string];',
    key: '0',
    names: true,
    what: 'a leading rest, member 0',
  },
  {
    declarations: 'type Values = [string, ...Error[], string];',
    key: '1',
    names: true,
    what: 'a rest between fields, its first member',
  },
  {
    declarations: 'type Values = [string, ...Error[], string];',
    key: '0',
    names: false,
    what: 'a member before the rest',
  },
  {
    declarations: 'type Values = [string, ...Error[]];',
    key: '1',
    names: true,
    what: 'a rest with no member after it',
  },
  {
    declarations: 'type Values = [Error, ...string[]];',
    key: '1',
    names: false,
    what: 'a rest of data with no member after it',
  },
  {
    declarations: 'type Pair = [Error, number]; type Values = [...Pair, string];',
    key: '1',
    names: false,
    what: 'a finite tuple rest, the member of its number',
  },
  {
    declarations: 'type Pair = [Error, number]; type Values = [...Pair, string];',
    key: '0',
    names: true,
    what: 'a finite tuple rest, the member of its error',
  },
];

describe('a place of a tuple at or after a rest the reader cannot expand', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the selected elements of a parameter of `type` name `Error`. */
  function namesErrors(
    declarations: string,
    type: string,
    selection: ArrayReadingSelection,
  ): boolean {
    using parsed = api.createSourceFile(
      'nonfinal-rests.ts',
      `${declarations}\nfunction frames(values: ${type}) { return values; }\n`,
    );
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared of ${type}.`);
    return namesLocalMemberArrayType(written, [], new Set(['Error']), selection);
  }

  /** Whether the member `key` of a parameter of type `Values` names `Error`. */
  function namesMember(declarations: string, key: string): boolean {
    using parsed = api.createSourceFile(
      'nonfinal-rest-members.ts',
      `${declarations}\nfunction frames(values: Values) { return values; }\n`,
    );
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error('No parameter is declared of Values.');
    return namesLocalMemberType(written, [key], new Set(['Error']));
  }

  it.each(CASES)('$what', ({ declarations, type, selection, names }) => {
    expect(namesErrors(declarations, type, selection)).toBe(names);
  });

  it.each(MEMBERS)('selects member $what', ({ declarations, key, names }) => {
    expect(namesMember(declarations, key)).toBe(names);
  });
});
