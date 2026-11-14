import {
  isForOfStatement,
  isIdentifier,
  isParenthesizedTypeNode,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode,
  type Expression,
  type Node,
  type TypeAliasDeclaration,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { iteratedFrameSources } from '../src/compiler/framed-assignment-patterns.ts';
import { initialTypeReading, type TypeReading } from '../src/compiler/local-type-environment.ts';
import { writtenTuplePlaces } from '../src/compiler/local-type-tuple-selections.ts';

/**
 * The places an iterated tuple is read at are the most any alternative has, and a rest that is some
 * of both, an array beside a written tuple, has the places of the tuple among them: iterating
 * `[...(string[] | [string, Error])]` may assign the `Error` of the second place, so that a count of
 * one place for the whole rest dropped `values.1`. Each alternative of a rest is counted on its own,
 * an array or a cycle as the one place a rest of unknown length is, a written tuple by its own places.
 *
 * What a count reads is bounded. Shared aliases are met by every path that reaches them, and the
 * alternatives of each level of `type T1 = [...(T0 | [...T0])]` both reach the level before, so
 * twenty levels were a million counts of one place. One count reads the rests of at most 4096
 * tuples. A count that needs more cannot say how many places there are, and a count that is short
 * drops the place a loop may assign an `Error` at: iterating `[...T12, ...[string, Error]]` over
 * twelve such levels counted two places, and left out `values.2`. It is the most places a tuple
 * has, ten thousand (TypeScript refuses a tuple spread past that), so that every place is read,
 * as every element is a candidate; what a count can finish within its reads keeps its own answer.
 */
const MIXED = [
  {
    id: 'array-then-tuple',
    type: '[...(string[] | [string, Error])]',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'tuple-then-array',
    type: '[...([string, Error] | string[])]',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'named-rest',
    type: '[...rest: (string[] | [string, Error])]',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'readonly-tuple',
    type: 'readonly [...(string[] | readonly [string, Error])]',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'member-after',
    type: '[...(string[] | [string, Error]), number]',
    sources: ['values.0', 'values.1', 'values.2'],
  },
  {
    id: 'member-before',
    type: '[number, ...(string[] | [string, Error])]',
    sources: ['values.0', 'values.1', 'values.2'],
  },
  {
    id: 'two-mixed-rests',
    type: '[...(string[] | [string, Error]), ...(number[] | [number, Error, Error])]',
    sources: ['values.0', 'values.1', 'values.2', 'values.3', 'values.4'],
  },
  {
    id: 'nested-mixed-rest',
    type: '[...(string[] | [string, ...(number[] | [Error, Error])])]',
    sources: ['values.0', 'values.1', 'values.2'],
  },
  {
    id: 'array-beside-longer-tuples',
    type: '[...(string[] | [string] | [string, Error, Error])]',
    sources: ['values.0', 'values.1', 'values.2'],
  },
  {
    id: 'union-of-tuples-with-mixed-rest',
    type: '[string, Error?] | [...(string[] | [string, Error, Error])]',
    sources: ['values.0', 'values.1', 'values.2'],
  },
] as const;

const DECLARED = [
  {
    id: 'alias-of-the-mixed-tuple',
    declarations: 'type Values = [...(string[] | [string, Error])];',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'alias-of-the-tuple-alternative',
    declarations: 'type Pair = [string, Error]; type Values = [...(string[] | Pair)];',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'alias-of-the-array-alternative',
    declarations: 'type Words = string[]; type Values = [...(Words | [string, Error])];',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'generic-tuple-alternative',
    declarations: 'type Slots<T> = [...(string[] | [string, T])]; type Values = Slots<Error>;',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'generic-rest-alternatives',
    declarations:
      'type Rest<T> = string[] | [string, T, T]; type Values = [number, ...Rest<Error>];',
    sources: ['values.0', 'values.1', 'values.2', 'values.3'],
  },
] as const;

/** What a count must keep: a rest of one kind of alternative, an empty one, and a cycle. */
const PINNED = [
  { id: 'array-rest', declarations: '', type: '[...Error[]]', sources: ['values.0'] },
  {
    id: 'array-rest-after-member',
    declarations: '',
    type: '[string, ...Error[]]',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'tuple-alternatives',
    declarations: '',
    type: '[...([string] | [string, Error])]',
    sources: ['values.0', 'values.1'],
  },
  { id: 'empty-rest', declarations: '', type: '[...[]]', sources: [] },
  {
    id: 'empty-tuple-beside-array',
    declarations: '',
    type: '[...([] | string[])]',
    sources: ['values.0'],
  },
  { id: 'empty-tuples', declarations: '', type: '[...([] | [])]', sources: [] },
  {
    id: 'array-beside-tuple',
    declarations: '',
    type: '[string, Error?] | string[]',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'cycle-beside-a-tuple',
    declarations: 'type Values = [string, ...([Error, Error] | Values)];',
    type: 'Values',
    sources: ['values.0', 'values.1', 'values.2'],
  },
  {
    id: 'cycle-beside-an-array',
    declarations: 'type Values = [string, ...(Error[] | Values)];',
    type: 'Values',
    sources: ['values.0', 'values.1'],
  },
  {
    id: 'tuple-that-is-its-own-rest',
    declarations: 'type Values = [] | [string, ...Values];',
    type: 'Values',
    sources: ['values.0', 'values.1'],
  },
] as const;

/**
 * Alternatives met again on the way down, by an operand reader that expands every alias: a tuple
 * that is among its own rest's alternatives counts as the one place of a cycle, beside the others.
 */
const CYCLES = [
  {
    id: 'cycle-beside-a-tuple',
    declarations: 'type Values = [string, ...([Error, Error] | Values)];',
    places: 3,
  },
  {
    id: 'cycle-beside-an-array',
    declarations: 'type Values = [string, ...(Error[] | Values)];',
    places: 2,
  },
  {
    id: 'cycle-beside-a-longer-tuple',
    declarations: 'type Values = [string, ...(Values | [Error, Error, Error])];',
    places: 4,
  },
] as const;

/** Twenty levels of an alias that reaches the one before it by two alternatives or by two rests. */
const LEVELS = 20;

/** Each level reaches the one before it by both of two alternatives. */
const SHARING = (at: number, before: number): string =>
  `type T${String(at)} = [...(T${String(before)} | [...T${String(before)}])];`;

/** The same, beside an array. */
const MIXED_SHARING = (at: number, before: number): string =>
  `type T${String(at)} = [...(string[] | T${String(before)} | [...T${String(before)}])];`;

const SHARED = [
  { id: 'shared-alternatives', level: SHARING },
  { id: 'shared-alternatives-beside-arrays', level: MIXED_SHARING },
] as const;

/** One alias declaration for each level from the first to `levels`, above the one of `[base]`. */
function chainOf(
  levels: number,
  level: (at: number, before: number) => string,
  base = 'Error',
): string {
  const declarations = Array.from({ length: levels }, (_, index) => level(index + 1, index));
  return `type T0 = [${base}]; ${declarations.join(' ')}`;
}

/** The most places a tuple has, and the sources a loop over a count that has no reads left is given. */
const TUPLE_PLACES = 10_000;
const EVERY_PLACE = Array.from({ length: TUPLE_PLACES }, (_, place) => `values.${String(place)}`);

/** Each level a rest of the one before it, twice. */
const SEQUENCE = (at: number, before: number): string =>
  `type T${String(at)} = [...T${String(before)}, ...T${String(before)}];`;

/**
 * Rests of shared aliases no count can read in full, the `Error` at a place a short count leaves out:
 * after the rest, beside a tuple that is longer, after a rest that repeats a rest, beside arrays.
 */
const EXHAUSTED = [
  {
    id: 'rest-after-the-exhausted-rest',
    chain: (): string => chainOf(12, SHARING, 'string'),
    type: '[...T12, ...[string, Error]]',
  },
  {
    id: 'member-after-the-exhausted-rest',
    chain: (): string => chainOf(12, SHARING, 'string'),
    type: '[...T12, string, Error]',
  },
  {
    id: 'tuple-beside-the-exhausted-rest',
    chain: (): string => chainOf(12, SHARING, 'string'),
    type: '[...(T12 | [string, string, Error])]',
  },
  {
    id: 'exhausted-rest-of-arrays-and-tuples',
    chain: (): string => chainOf(12, MIXED_SHARING, 'string'),
    type: '[...T12, ...[string, Error]]',
  },
  {
    id: 'rests-that-reach-an-alias-twice',
    chain: (): string => chainOf(20, SEQUENCE, 'string'),
    type: '[...T20, ...[string, Error]]',
  },
  {
    id: 'exhausted-rest-in-an-alias',
    chain: (): string =>
      `${chainOf(12, SHARING, 'string')} type Values = [...T12, ...[string, Error]];`,
    type: 'Values',
  },
] as const;

/** The same shapes with levels enough for a count to finish: the places it has, and no more. */
const FINISHED = [
  {
    id: 'rest-after-the-shared-rest',
    chain: (): string => chainOf(8, SHARING, 'string'),
    type: '[...T8, ...[string, Error]]',
    sources: ['values.0', 'values.1', 'values.2'],
  },
  {
    id: 'member-after-the-shared-rest',
    chain: (): string => chainOf(8, SHARING, 'string'),
    type: '[...T8, string, Error]',
    sources: ['values.0', 'values.1', 'values.2'],
  },
  {
    id: 'tuple-beside-the-shared-rest',
    chain: (): string => chainOf(8, SHARING, 'string'),
    type: '[...(T8 | [string, string, Error])]',
    sources: ['values.0', 'values.1', 'values.2'],
  },
  {
    id: 'shared-rest-of-arrays-and-tuples',
    chain: (): string => chainOf(8, MIXED_SHARING, 'string'),
    type: '[...T8, ...[string, Error]]',
    sources: ['values.0', 'values.1', 'values.2'],
  },
] as const;

describe('the places a written tuple is counted at', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The sources `iteratedFrameSources` gives the iterated `values` of a program, as written. */
  function iterated(declarations: string, type: string): readonly string[] {
    using parsed = api.createSourceFile(
      'iteration-places.ts',
      `${declarations}\nfunction frames(values: ${type}) { let e: unknown = 0; for (e of values) {} return e; }\n`,
    );
    let iterable: Expression | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (isForOfStatement(at)) iterable = at.expression;
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    if (iterable === undefined) throw new Error(`No iteration is written for ${type}.`);
    return iteratedFrameSources(iterable).map((source) =>
      [source.value.getText(), ...source.keys].join('.'),
    );
  }

  /** The places `writtenTuplePlaces` counts of the alias `name`, and how often it asked for operands. */
  function counted(
    declarations: string,
    name: string,
  ): { readonly places: number | undefined; readonly asked: number } {
    using parsed = api.createSourceFile('tuple-places.ts', declarations);
    const aliases = new Map<string, TypeAliasDeclaration>();
    for (const statement of parsed.sourceFile.statements) {
      if (isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement);
    }
    const declaration = aliases.get(name);
    if (declaration === undefined) throw new Error(`${name} is not declared.`);
    let asked = 0;
    const operands = (reading: TypeReading): readonly TypeReading[] => {
      asked += 1;
      const { type } = reading;
      if (isParenthesizedTypeNode(type)) return operands({ ...reading, type: type.type });
      if (isUnionTypeNode(type)) {
        return type.types.flatMap((member) => operands({ ...reading, type: member }));
      }
      if (isTypeReferenceNode(type) && isIdentifier(type.typeName)) {
        const alias = aliases.get(type.typeName.text);
        if (alias !== undefined) return operands({ ...reading, type: alias.type });
      }
      return [reading];
    };
    const places = writtenTuplePlaces(initialTypeReading(declaration.type), operands);
    return { asked, places };
  }

  it.each(MIXED)('counts the tuple among the alternatives of a rest: $id', ({ type, sources }) => {
    expect(iterated('', type)).toStrictEqual(sources);
  });

  it.each(DECLARED)('counts through declarations: $id', ({ declarations, sources }) => {
    expect(iterated(declarations, 'Values')).toStrictEqual(sources);
  });

  it.each(PINNED)(
    'keeps the places of a rest of one kind: $id',
    ({ declarations, type, sources }) => {
      expect(iterated(declarations, type)).toStrictEqual(sources);
    },
  );

  it.each(CYCLES)('counts a cycle as one place: $id', ({ declarations, places }) => {
    expect(counted(declarations, 'Values').places).toBe(places);
  });

  it.each(SHARED)('reads shared aliases a bounded number of times: $id', ({ level }) => {
    const { asked, places } = counted(chainOf(LEVELS, level), `T${String(LEVELS)}`);

    expect(places).toBe(TUPLE_PLACES);
    expect(asked).toBeLessThan(40_000);
  });

  it('reads rests that reach an alias twice a bounded number of times', () => {
    const { asked, places } = counted(chainOf(LEVELS, SEQUENCE), `T${String(LEVELS)}`);

    expect(places).toBe(TUPLE_PLACES);
    expect(asked).toBeLessThan(40_000);
  });

  it('counts a small shared alias by the places it has', () => {
    const { asked, places } = counted(chainOf(8, SHARING), 'T8');

    expect(places).toBe(1);
    expect(asked).toBeLessThan(2000);
  });

  it.each(EXHAUSTED)(
    'reads every place where a count has no reads left: $id',
    ({ chain, type }) => {
      const sources = iterated(chain(), type);

      expect(sources).toContain('values.2');
      expect(sources).toStrictEqual(EVERY_PLACE);
    },
  );

  it.each(FINISHED)(
    'keeps the places of a count that finishes: $id',
    ({ chain, type, sources }) => {
      expect(iterated(chain(), type)).toStrictEqual(sources);
    },
  );

  it('counts the places of a shared alias in full while a count has reads left', () => {
    const { asked, places } = counted(chainOf(10, SEQUENCE), 'T10');

    expect(places).toBe(1024);
    expect(asked).toBeLessThan(10_000);
  });
});
