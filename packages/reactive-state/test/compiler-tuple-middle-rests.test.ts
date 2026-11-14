import { isArrayTypeNode, isTypeAliasDeclaration, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialTypeReading, type TypeReading } from '../src/compiler/local-type-environment.ts';
import { writtenTupleReadings } from '../src/compiler/local-type-tuple-selections.ts';

/**
 * A literal index of a tuple selects the member written at that position while every position
 * before it is fixed. At or past a rest of unknown length, the index may fall in that rest, at the
 * offset the fixed positions before it leave, or on a member after it that a shorter rest brings
 * there: a member written `n` places after the rest stands at the index only if `n` is no more than
 * that offset. TypeScript reads `[...Error[], string][0]` as `string | Error`.
 */

const CASES = [
  {
    tuple: '[...Error[], string]',
    index: 0,
    selected: ['Error', 'string'],
    rests: ['Error[]@0'],
    what: 'a leading rest before a member',
  },
  {
    tuple: '[string, ...Error[], number]',
    index: 1,
    selected: ['Error', 'number'],
    rests: ['Error[]@0'],
    what: 'a middle rest at its first offset',
  },
  {
    tuple: '[string, ...Error[], number, boolean]',
    index: 1,
    selected: ['Error', 'number'],
    rests: ['Error[]@0'],
    what: 'a member too far after the rest',
  },
  {
    tuple: '[string, ...Error[], number, boolean]',
    index: 2,
    selected: ['Error', 'number', 'boolean'],
    rests: ['Error[]@1'],
    what: 'each member a shorter rest brings',
  },
  {
    tuple: '[...First, ...Second, string]',
    index: 1,
    selected: ['First', 'Second', 'string'],
    rests: ['First@1', 'Second@any'],
    what: 'a second rest of an unknown offset',
  },
  {
    tuple: '[...Error[], ...[string, number]]',
    index: 0,
    selected: ['Error', 'string'],
    rests: ['Error[]@0'],
    what: 'a written tuple after the rest',
  },
  {
    tuple: '[...[string, ...Error[]], number]',
    index: 1,
    selected: ['Error', 'number'],
    rests: ['Error[]@0'],
    what: 'a member after a written tuple of a rest',
  },
  {
    tuple: '[string, ...Error[], number]',
    index: 0,
    selected: ['string'],
    rests: [],
    what: 'a position before the rest (a pin)',
  },
  {
    tuple: '[string, ...Error[]]',
    index: 3,
    selected: ['Error'],
    rests: ['Error[]@2'],
    what: 'a trailing rest (a pin)',
  },
  {
    tuple: '[string, ...Error[], number]',
    index: undefined,
    selected: ['string', 'Error', 'number'],
    rests: ['Error[]@any'],
    what: 'a numeric selection (a pin)',
  },
] as const;

describe('a literal index of a tuple at or past a rest of unknown length', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The written members `index` selects of `tuple`, and each rest it reads at the offset given. */
  function selectedOf(
    tuple: string,
    index: number | undefined,
  ): { readonly selected: readonly string[]; readonly rests: readonly string[] } {
    const source = `type First = unknown[];\ntype Second = unknown[];\ntype Selected = ${tuple};\n`;
    using parsed = api.createSourceFile('tuples.ts', source);
    const { sourceFile } = parsed;
    const textOf = (node: Node): string => source.slice(node.getStart(sourceFile), node.end);
    const declaration = sourceFile.statements.find(
      (statement) => isTypeAliasDeclaration(statement) && statement.name.text === 'Selected',
    );
    if (declaration === undefined || !isTypeAliasDeclaration(declaration)) {
      throw new Error('the tuple was not parsed');
    }
    const rests: string[] = [];
    const selectRest = (rest: TypeReading, offset: number | undefined): readonly TypeReading[] => {
      rests.push(`${textOf(rest.type)}@${offset === undefined ? 'any' : String(offset)}`);
      return isArrayTypeNode(rest.type) ? [{ ...rest, type: rest.type.elementType }] : [rest];
    };
    const readings = writtenTupleReadings(
      initialTypeReading(declaration.type),
      index,
      selectRest,
      (reading) => [reading],
    );
    if (readings === undefined) {
      throw new Error('the tuple was not read');
    }
    return { rests, selected: readings.map((reading) => textOf(reading.type)) };
  }

  it.each(CASES)('$what', ({ tuple, index, selected, rests }) => {
    expect(selectedOf(tuple, index)).toStrictEqual({ rests, selected });
  });
});
