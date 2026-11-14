import {
  isArrayTypeNode,
  isParenthesizedTypeNode,
  isTypeAliasDeclaration,
  isUnionTypeNode,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialTypeReading, type TypeReading } from '../src/compiler/local-type-environment.ts';
import { writtenTupleReadings } from '../src/compiler/local-type-tuple-selections.ts';

/**
 * Each alternative of a rest of finite tuples is a path that reads what is left of the tuple, and
 * the paths of the alternatives of the next rest meet again once their own members are read. What a
 * path has left to read, and where it stands, decides what it selects, so a state is read once: the
 * work follows the states of a tuple, not the number of ways to reach them. Twelve rests of two
 * alternatives each are four thousand paths, and had a literal index past a rest of unknown length
 * answer a hundred thousand readings of four members.
 */

const ALTERNATIVES = '...(["u1"] | ["u2", "u3"])';
const REPEATED = 12;
const CASES = [
  {
    what: 'a literal index past a rest of unknown length',
    tuple: `[...("r")[], ${Array.from({ length: REPEATED }, () => ALTERNATIVES).join(', ')}, "z"]`,
    index: REPEATED + 1,
    members: ['r', 'u1', 'u2', 'u3', 'z'],
  },
  {
    what: 'a literal index after rests of alternatives',
    tuple: `["f", ${Array.from({ length: REPEATED }, () => ALTERNATIVES).join(', ')}, "z"]`,
    index: REPEATED,
    members: ['u1', 'u2', 'u3'],
  },
  {
    what: 'a numeric selection',
    tuple: `[${Array.from({ length: REPEATED }, () => ALTERNATIVES).join(', ')}, "z"]`,
    index: undefined,
    members: ['u1', 'u2', 'u3', 'z'],
  },
] as const;

describe('the states of a tuple selection', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The members `index` selects of `tuple`, and how often the alternatives of a rest were asked for. */
  function selectedOf(
    tuple: string,
    index: number | undefined,
  ): { readonly members: readonly string[]; readonly asked: number } {
    const source = `type Selected = ${tuple};\n`;
    using parsed = api.createSourceFile('tuples.ts', source);
    const { sourceFile } = parsed;
    const textOf = (node: Node): string => source.slice(node.getStart(sourceFile), node.end);
    const declaration = sourceFile.statements.find(isTypeAliasDeclaration);
    if (declaration === undefined) throw new Error('the tuple was not parsed');
    let asked = 0;
    const operands = (reading: TypeReading): readonly TypeReading[] => {
      asked += 1;
      const { type } = reading;
      if (isParenthesizedTypeNode(type)) return operands({ ...reading, type: type.type });
      if (isUnionTypeNode(type)) {
        return type.types.flatMap((member) => operands({ ...reading, type: member }));
      }
      return [reading];
    };
    const selectRest = (rest: TypeReading, offset: number | undefined): readonly TypeReading[] => {
      return operands(rest).flatMap((each) => {
        if (isArrayTypeNode(each.type)) return [{ ...each, type: each.type.elementType }];
        return writtenTupleReadings(each, offset, selectRest, operands) ?? [];
      });
    };
    const readings = writtenTupleReadings(
      initialTypeReading(declaration.type),
      index,
      selectRest,
      operands,
    );
    if (readings === undefined) throw new Error('the tuple was not read');
    const words = readings.flatMap((reading) => textOf(reading.type).match(/\w+/gu) ?? []);
    return {
      asked,
      members: [...new Set(words)].toSorted((left, right) => left.localeCompare(right)),
    };
  }

  it.each(CASES)('reads each state once: $what', ({ tuple, index, members }) => {
    const { asked, members: selected } = selectedOf(tuple, index);

    expect(selected).toStrictEqual(members);
    expect(asked).toBeLessThan(500);
  });
});
