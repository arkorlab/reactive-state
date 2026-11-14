import { isFunctionDeclaration, type TypeNode } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { namesLocalMemberType } from '../src/compiler/local-type-reading.ts';

/**
 * A type query that a type it reaches queries again is read once where the path of keys is no
 * finite one, and as often as the path goes where it is: `typeof v.self.self.e` of an interface that
 * holds `self: typeof v` and `e: Error` reaches the error, and so does the same path written as
 * indexed accesses, `(typeof v)["self"]["self"]["e"]`, which select one key at a time, each of a
 * reading the query before it gave. Such a path enters the same query again; a query that gives
 * itself is entered each time it is read, and a bound on the entries of a query already on one path,
 * four in all, ends it as a repeat of an alias does: past the bound the query reads as none. Where an
 * indexed path takes more steps through one query than that, the error it reaches is not read. A
 * query is what it reads, so a name and members written in several places of a cycle are one query,
 * and a cycle of many of them, a union of five `typeof value.e`, ends as soon as one. Each reading of
 * a value query is counted, and the bounds of the rows are the work one reading takes. The rows
 * marked a pin answer the same before the change as after it.
 */

const LIMIT = vi.hoisted(() => 5000);
const reads = vi.hoisted(() => ({ calls: 0 }));

vi.mock(import('../src/compiler/local-type-value-queries.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    valueQueryReading: (...given: Parameters<typeof original.valueQueryReading>) => {
      reads.calls += 1;
      if (reads.calls > LIMIT) throw new Error('A value query is read again without end.');
      return original.valueQueryReading(...given);
    },
  };
});

const SELF = 'interface I { self: typeof v; e: Error } declare const v: I;';

/** The path `(typeof v)["self"]...["e"]` of `steps` selections of `self`. */
function indexed(steps: number): string {
  return `(typeof v)${'["self"]'.repeat(steps)}["e"]`;
}

const CASES = [
  {
    id: 'two-indexed-steps-of-a-query-that-holds-itself',
    names: true,
    source: SELF,
    type: indexed(2),
    reads: 60,
  },
  {
    id: 'three-indexed-steps-of-a-query-that-holds-itself',
    names: true,
    source: SELF,
    type: indexed(3),
    reads: 60,
  },
  {
    id: 'four-indexed-steps-of-a-query-that-holds-itself',
    names: true,
    source: SELF,
    type: indexed(4),
    reads: 60,
  },
  { id: 'one-indexed-step-pin', names: true, source: SELF, type: indexed(1), reads: 60 },
  {
    id: 'indexed-steps-after-a-qualified-query',
    names: true,
    source: SELF,
    type: '(typeof v.self)["self"]["e"]',
    reads: 60,
  },
  {
    id: 'qualified-query-before-an-index-pin',
    names: true,
    source: SELF,
    type: '(typeof v.self.self)["e"]',
    reads: 60,
  },
  {
    id: 'indexed-steps-written-after-typeof-pin',
    names: true,
    source: SELF,
    type: 'typeof v["self"]["e"]',
    reads: 60,
  },
  {
    id: 'five-indexed-steps-past-the-bound',
    names: false,
    source: SELF,
    type: indexed(5),
    reads: 60,
  },
  {
    id: 'error-beside-data-through-indexed-steps',
    names: true,
    source: 'interface I { self: typeof v; e: Error | string } declare const v: I;',
    type: indexed(3),
    reads: 60,
  },
  {
    id: 'data-through-indexed-steps-pin',
    names: false,
    source: 'interface I { self: typeof v; e: string } declare const v: I;',
    type: indexed(3),
    reads: 60,
  },
  {
    id: 'indexed-steps-of-a-type-alias',
    names: true,
    source: 'type T = { self: typeof v; e: Error }; declare const v: T;',
    type: indexed(3),
    reads: 60,
  },
  {
    id: 'indexed-steps-of-an-interface-through-readonly',
    names: true,
    source: 'interface I { self: Readonly<typeof v>; e: Error } declare const v: I;',
    type: indexed(3),
    reads: 60,
  },
  {
    id: 'indexed-steps-of-a-generic-interface',
    names: true,
    source: 'interface I<T> { self: typeof v; e: T } declare const v: I<Error>;',
    type: indexed(3),
    reads: 60,
  },
  {
    id: 'indexed-steps-of-an-inherited-member',
    names: true,
    source: 'interface B { self: typeof v } interface I extends B { e: Error } declare const v: I;',
    type: indexed(3),
    reads: 60,
  },
  {
    id: 'tuple-element-of-a-query-that-holds-itself',
    names: true,
    source: 'interface I { pair: [typeof v, Error] } declare const v: I;',
    type: '(typeof v)["pair"][0]["pair"][0]["pair"][1]',
    reads: 60,
  },
  {
    id: 'tuple-element-one-step-pin',
    names: true,
    source: 'interface I { pair: [typeof v, Error] } declare const v: I;',
    type: '(typeof v)["pair"][0]["pair"][1]',
    reads: 60,
  },
  {
    id: 'array-element-of-a-query-that-holds-itself-pin',
    names: true,
    source: 'interface I { list: (typeof v | Error)[] } declare const v: I;',
    type: '(typeof v)["list"][number]',
    reads: 60,
  },
  {
    id: 'query-that-gives-itself-by-an-index',
    names: false,
    source: 'interface I { e: (typeof v)["e"] } declare const v: I;',
    type: '(typeof v)["e"]',
    reads: 60,
  },
  {
    id: 'queries-that-give-each-other-by-an-index',
    names: false,
    source: 'declare const a: { x: (typeof b)["x"] }; declare const b: { x: (typeof a)["x"] };',
    type: '(typeof a)["x"]',
    reads: 60,
  },
  {
    id: 'query-that-gives-itself-in-three-places',
    names: false,
    source: 'declare const value: { e: typeof value.e | typeof value.e | typeof value.e };',
    type: 'typeof value.e',
    reads: 800,
  },
  {
    id: 'queries-that-give-each-other-in-two-places',
    names: false,
    source:
      'declare const a: { x: (typeof b)["x"] | (typeof b)["x"] }; declare const b: { x: (typeof a)["x"] | (typeof a)["x"] };',
    type: '(typeof a)["x"]',
    reads: 1000,
  },
] as const;

describe('a type query a finite path of indexes enters again', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  beforeEach(() => {
    reads.calls = 0;
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `type`, a parameter's type written after `source`, names `Error`. */
  function namesError(source: string, type: string): boolean {
    using parsed = api.createSourceFile(
      'indexed-reentry.ts',
      `${source}\nfunction frames(probe: ${type}) { return probe; }\n`,
    );
    let written: TypeNode | undefined;
    for (const statement of parsed.sourceFile.statements) {
      if (isFunctionDeclaration(statement)) written = statement.parameters[0]?.type;
    }
    if (written === undefined) throw new Error(`No parameter is declared of ${type}.`);
    return namesLocalMemberType(written, [], new Set(['Error']));
  }

  it.each(CASES)('$id', ({ names, reads: bound, source, type }) => {
    expect(namesError(source, type)).toBe(names);
    expect(reads.calls).toBeLessThanOrEqual(bound);
  });
});
