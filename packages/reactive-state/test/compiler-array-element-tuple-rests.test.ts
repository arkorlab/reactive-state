import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArrayReadingSelection } from '../src/compiler/local-type-array-words.ts';
import { namesLocalMemberArrayType } from '../src/compiler/local-type-reading.ts';

/**
 * A tuple's rest supplies its elements through an alias or a generic's actual argument as a written
 * one does: `type Errors = Error[]; type Values = [...Errors]` holds `Error` elements, at each
 * position the rest may fill and from its end, as `Spread<[Error]>` does for `[...T]`. A required
 * element after the last rest is the one at its place from the end, however long the rest is. Each
 * row is whether `Error` is among the elements that position may hold at run time; the rows that a
 * written fixed position or a data rest decides pin the selections the change leaves as they were.
 */
const CASES: readonly {
  readonly declarations: string;
  readonly type: string;
  readonly selection: ArrayReadingSelection;
  readonly names: boolean;
  readonly what: string;
}[] = [
  {
    declarations: 'type Errors = Error[]; type Values = [...Errors];',
    type: 'Values',
    selection: {},
    names: true,
    what: 'an aliased rest',
  },
  {
    declarations: 'type Errors = Error[]; type Values = [...Errors];',
    type: 'Values',
    selection: { index: 0 },
    names: true,
    what: 'an aliased rest at a position',
  },
  {
    declarations: 'type Errors = Error[]; type Values = [...Errors];',
    type: 'Values',
    selection: { index: -1 },
    names: true,
    what: 'an aliased rest from its end',
  },
  {
    declarations: 'type Errors = Error[]; type Values = [{ stack: string }, ...Errors];',
    type: 'Values',
    selection: { index: -1 },
    names: true,
    what: 'an aliased rest after a field, at -1',
  },
  {
    declarations: 'type Values = [...Error[], { stack: string }];',
    type: 'Values',
    selection: { index: -1 },
    names: false,
    what: 'a field after a written rest, at -1',
  },
  {
    declarations: 'type Errors = Error[]; type Values = [...Errors, { stack: string }];',
    type: 'Values',
    selection: { index: -1 },
    names: false,
    what: 'a field after an aliased rest, at -1',
  },
  {
    declarations: 'type Spread<T extends unknown[]> = [...T];',
    type: 'Spread<[Error]>',
    selection: {},
    names: true,
    what: 'a generic rest of a tuple',
  },
  {
    declarations: 'type Spread<T extends unknown[]> = [...T];',
    type: 'Spread<Error[]>',
    selection: { index: 0 },
    names: true,
    what: 'a generic rest of an array',
  },
  {
    declarations: 'type Values = [...Error[]];',
    type: 'Values',
    selection: { index: 0 },
    names: true,
    what: 'a written array rest at a position',
  },
  {
    declarations: 'type Tail = [Error]; type Values = [string, ...Tail];',
    type: 'Values',
    selection: { index: 1 },
    names: true,
    what: 'an aliased tuple after a field',
  },
  {
    declarations: 'type Errors = Error[]; type Values = [...Errors][];',
    type: 'Values',
    selection: { nested: true },
    names: true,
    what: 'a nested aliased rest',
  },
  {
    declarations: 'type Values = [Error];',
    type: 'Values',
    selection: { index: 0 },
    names: true,
    what: 'a written fixed position',
  },
  {
    declarations: 'type Values = [string, ...Error[]];',
    type: 'Values',
    selection: { index: 0 },
    names: false,
    what: 'a fixed position before a rest',
  },
  {
    declarations: 'type Data = { stack: string }[]; type Values = [...Data];',
    type: 'Values',
    selection: {},
    names: false,
    what: 'a data rest',
  },
];

describe("a tuple rest's elements, through aliases and actual arguments", () => {
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
      'tuple-rests.ts',
      `${declarations}\nfunction frames(values: ${type}) { return values; }\n`,
    );
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared of ${type}.`);
    return namesLocalMemberArrayType(written, [], new Set(['Error']), selection);
  }

  it.each(CASES)('$what', ({ declarations, type, selection, names }) => {
    expect(namesErrors(declarations, type, selection)).toBe(names);
  });
});
