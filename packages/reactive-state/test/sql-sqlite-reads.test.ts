import { describe, expect, it } from 'vitest';

import type { Edge } from '../src/sql/sqlite/closure.ts';
import {
  candidateOf,
  type KeyTerm,
  readsApart,
  wheresNamed,
  wheresTogether,
} from '../src/sql/sqlite/reads.ts';
import type { Occurrence, Scope } from '../src/sql/sqlite/scopes.ts';
import type { TableSource } from '../src/sql/sqlite/sources.ts';
import type { Term } from '../src/sql/sqlite/where.ts';

const scope: Scope = { facts: [], occurrences: [], parent: undefined };

/** A source of `table`, of the terms given. */
function sourceOf(table: string, terms: readonly Term[]): TableSource {
  const occurrence: Occurrence = { alias: table, scope, table };
  return { columns: new Map(), occurrence, table, terms };
}

/** An equality that holds of `to`'s rows, of `from`'s column `f`. */
function edge(to: TableSource, from: TableSource): Edge {
  return {
    from: { column: 'f', occurrence: from.occurrence },
    to: { column: 'k', occurrence: to.occurrence },
  };
}

/** Which terms are of keys, of a schema whose keys are `k` and `c`. */
function keyTerms(_of: TableSource, terms: readonly Term[]): readonly KeyTerm[] {
  return terms.flatMap(({ column, params }) => {
    return ['c', 'k'].includes(column)
      ? [{ field: `k_${column}`, kind: 'text' as const, params }]
      : [];
  });
}

describe('what names the rows of a table no parameter reaches', () => {
  const joined = sourceOf('t', []);
  const driver = sourceOf('d', [{ column: 'c', params: [1, 2] }]);

  it("reads the driver's values by its terms, one past what a read names", () => {
    const candidate = candidateOf(
      joined,
      { edges: [edge(joined, driver)], sources: [joined, driver] },
      keyTerms,
    );

    expect(candidate).toStrictEqual({
      field: 'k_k',
      kind: 'text',
      params: [1, 2],
      sql: 'SELECT DISTINCT "f" AS "value" FROM "d" WHERE "c" IN (?, ?) LIMIT 33',
    });
  });

  // A term may name what is no column of the table: a result's alias reads nothing in a candidate.
  it("holds the driver's key terms alone: the rows its read follows", () => {
    const both = sourceOf('d', [
      { column: 'c', params: [0] },
      { column: 'value', params: [1] },
    ]);
    const candidate = candidateOf(
      joined,
      { edges: [edge(joined, both)], sources: [joined, both] },
      keyTerms,
    );

    expect(candidate?.sql).toContain('WHERE "c" IN (?) LIMIT');
    expect(candidate?.params).toStrictEqual([0]);
  });

  // Two sources named by each other wait each for a change only the other notes.
  it('takes no driver read by no key term of its own', () => {
    const named = sourceOf('d', [{ column: 'other', params: [0] }]);

    expect(
      candidateOf(joined, { edges: [edge(joined, named)], sources: [joined, named] }, keyTerms),
    ).toBeUndefined();
  });

  it('takes no driver the plan does not read', () => {
    expect(
      candidateOf(joined, { edges: [edge(joined, driver)], sources: [joined] }, keyTerms),
    ).toBeUndefined();
  });

  it('takes no equality of another source', () => {
    const other = sourceOf('o', []);

    expect(
      candidateOf(joined, { edges: [edge(other, driver)], sources: [joined, driver] }, keyTerms),
    ).toBeUndefined();
  });

  it('takes no column of no key', () => {
    const plain: Edge = {
      from: { column: 'f', occurrence: driver.occurrence },
      to: { column: 'plain', occurrence: joined.occurrence },
    };

    expect(
      candidateOf(joined, { edges: [plain], sources: [joined, driver] }, keyTerms),
    ).toBeUndefined();
  });
});

describe('what the answer of a candidate names', () => {
  const key = { field: 'k_k', kind: 'text' } as const;
  const integer = { field: 'k_k', kind: 'integer' } as const;

  it.each([
    ['its values', key, [{ value: 'a' }, { value: 'b' }], [{ k_k: 'a' }, { k_k: 'b' }]],
    ['no record of no row', key, [], []],
    ['no record of a `NULL`', key, [{ value: null }, { value: 'a' }], [{ k_k: 'a' }]],
    ['an integer by its text', integer, [{ value: 5 }], [{ k_k: '5' }]],
    ['every record of a blob', key, [{ value: [1, 2] }], [{}]],
    ['every record of a real of an integer key', integer, [{ value: 1.5 }], [{}]],
    ['every record of text of an integer key', integer, [{ value: 'x' }], [{}]],
    ['every record of a number of a text key', key, [{ value: 5 }], [{}]],
  ])('names %s', (_name, candidate, rows, wheres) => {
    expect(wheresNamed(rows, candidate)).toStrictEqual(wheres);
  });

  it('names every record of what is no list of rows', () => {
    expect(wheresNamed(undefined, key)).toStrictEqual([{}]);
  });

  it('names every record past what a read names', () => {
    const rows = Array.from({ length: 33 }, (_, at) => ({ value: String(at) }));

    expect(wheresNamed(rows, key)).toStrictEqual([{}]);
    expect(wheresNamed(rows.slice(1), key)).toHaveLength(32);
  });
});

describe("the reads of a table's several sources", () => {
  const term = { field: 'k_c', kind: 'text', params: [0] } as const;
  const candidate = { field: 'k_k', kind: 'text', params: [0], sql: 'SELECT 1' } as const;

  it('keeps each once', () => {
    expect(readsApart([{ terms: [term] }, { terms: [term] }])).toStrictEqual([{ terms: [term] }]);
  });

  it('reads whole of a source of no term and no candidate', () => {
    expect(readsApart([{ terms: [term] }, { terms: [] }])).toStrictEqual([{ terms: [] }]);
  });

  it('keeps a source of a candidate', () => {
    const reads = [{ terms: [term] }, { candidate, terms: [] }];

    expect(readsApart(reads)).toStrictEqual(reads);
  });

  it.each([
    ['each once', [{ a: '1' }, { a: '1' }, { a: '2' }], [{ a: '1' }, { a: '2' }]],
    ['the table whole where one is', [{ a: '1' }, {}], [{}]],
  ])('names %s', (_name, wheres, together) => {
    expect(wheresTogether(wheres)).toStrictEqual(together);
  });

  it('names the table whole past what a read names', () => {
    const wheres = Array.from({ length: 33 }, (_, at) => ({ a: String(at) }));

    expect(wheresTogether(wheres)).toStrictEqual([{}]);
  });
});
