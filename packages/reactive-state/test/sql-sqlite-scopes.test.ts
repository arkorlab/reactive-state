import { describe, expect, it } from 'vitest';

import type { SchemaEntry } from '../src/sql/sqlite/bytecode.ts';
import { type Comparison, comparisonOf, edgesOf, termsOf } from '../src/sql/sqlite/closure.ts';
import { type StatementRead, statementRead } from '../src/sql/sqlite/scopes.ts';
import { type Sources, sourcesOf } from '../src/sql/sqlite/sources.ts';
import { conditionsOf, readsAlone } from '../src/sql/sqlite/where.ts';

/** Each source of `sql`, `alias: column=place …`, every column compared alike; none unread. */
function termsIn(sql: string): Readonly<Record<string, readonly string[]>> | undefined {
  const read = statementRead(sql);
  if (read === undefined) return undefined;
  const terms = termsOf(read, () => 'text');
  const named = read.occurrences.map((occurrence) => {
    const own = terms.get(occurrence) ?? [];
    return [
      occurrence.alias,
      own.map((term) => `${term.column}=${term.params.join(',')}`),
    ] as const;
  });
  return Object.fromEntries(named);
}

/** What `sql` reads, of a statement read plainly. */
function plainly(sql: string): StatementRead {
  const read = statementRead(sql);
  if (read === undefined) throw new Error(`read not plainly: ${sql}`);
  return read;
}

describe('what a statement says of each source it reads', () => {
  it.each([
    [
      'a join by a parameter of its driver',
      'select "m"."id" from "m" inner join "u" on "u"."id" = "m"."user" where "m"."org" = ?',
      { m: ['org=0'], u: [] },
    ],
    [
      'an equality that hands a parameter on',
      'select 1 from "a" inner join "b" on "b"."k" = "a"."k" where "a"."k" = ?',
      { a: ['k=0'], b: ['k=0'] },
    ],
    [
      "a left join's own term",
      'select 1 from "a" left join "b" on "b"."x" = ? where "a"."k" = ?',
      { a: ['k=1'], b: ['x=0'] },
    ],
    [
      'a term a subquery holds of its own source',
      'select 1 from "a" where exists (select 1 from "b" where "b"."k" = ?)',
      { a: [], b: ['k=0'] },
    ],
    [
      'a correlated subquery under `not exists`',
      'select 1 from "a" where "a"."k" = ? and not exists (select 1 from "b" where "b"."k" = "a"."k")',
      { a: ['k=0'], b: ['k=0'] },
    ],
    [
      'a list of parameters',
      'select 1 from "a" inner join "b" on "b"."k" = "a"."k" where "a"."k" in (?, ?)',
      { a: ['k=0,1'], b: ['k=0,1'] },
    ],
    [
      'an alias, in any case of ASCII',
      'select 1 from "t" "A" inner join "u" on "u"."k" = "a"."k" where "A"."k" = ?',
      { A: ['k=0'], u: ['k=0'] },
    ],
    [
      "a `LEFT JOIN`'s `ON`, of a term of the left table it hands to its right",
      'select 1 from "a" left join "b" on "b"."k" = "a"."f" and "a"."f" = ?',
      { a: [], b: ['k=0'] },
    ],
    [
      'a derived table, whose columns hand nothing on',
      'select 1 from "a" inner join (select "k" from "b" where "b"."k" = ?) "d" on "d"."k" = "a"."k"',
      { a: [], b: ['k=0'], d: [] },
    ],
  ])('reads %s', (_name, sql, terms) => {
    expect(termsIn(sql)).toStrictEqual(terms);
  });

  it.each([
    [
      "a term of a left join's left table in its `ON`",
      'select 1 from "a" left join "b" on "b"."k" = "a"."k" and "a"."x" = ?',
      { a: [], b: [] },
    ],
    [
      'an equality handed to the left of a left join',
      'select 1 from "a" left join "b" on "b"."k" = "a"."k" where "b"."k" = ?',
      { a: [], b: ['k=0'] },
    ],
    [
      'an `OR`',
      'select 1 from "a" inner join "b" on "b"."k" = "a"."k" where "a"."k" = ? or "a"."x" = ?',
      { a: [], b: [] },
    ],
    [
      'a `NOT`',
      'select 1 from "a" inner join "b" on "b"."k" = "a"."k" where not "a"."k" = ?',
      { a: [], b: [] },
    ],
    [
      'a `NOT IN`',
      'select 1 from "a" inner join "b" on "b"."k" = "a"."k" where "a"."k" not in (?)',
      { a: [], b: [] },
    ],
    [
      'a `CASE`',
      'select 1 from "a" inner join "b" on "b"."k" = "a"."k" where case when "a"."k" = ? then 1 else 0 end',
      { a: [], b: [] },
    ],
    [
      'a `BETWEEN`',
      'select 1 from "a" inner join "b" on "b"."k" = "a"."k" where "a"."x" between ? and ? and "a"."k" = ?',
      { a: [], b: [] },
    ],
    [
      'a `COLLATE`',
      'select 1 from "a" inner join "b" on "b"."k" = "a"."k" where "a"."k" = ? collate nocase',
      { a: [], b: [] },
    ],
    [
      'a comparison other than `=`',
      'select 1 from "a" inner join "b" on "b"."k" = "a"."k" where "a"."k" >= ?',
      { a: [], b: [] },
    ],
    [
      'a term of a `HAVING`',
      'select 1 from "a" inner join "b" on "b"."k" = "a"."k" group by "a"."k" having "a"."k" = ?',
      { a: [], b: [] },
    ],
    // A `SELECT` in parentheses is one value: its `AND` is its own, whatever its value is held to.
    [
      'an `AND` of a `SELECT` that stands as a condition',
      'select 1 from "a" where (select count(*) = 0 from "b" where "b"."k" = ? and "a"."k" = ?)',
      { a: [], b: ['k=0'] },
    ],
    [
      'an `AND` of a `SELECT` beside another term',
      'select 1 from "a" where "a"."x" = ? and (select count(*) = 0 from "b" where 1 and "a"."k" = ?)',
      { a: ['x=0'], b: [] },
    ],
    [
      "an `AND` of a `SELECT` in a join's `ON`",
      'select 1 from "a" inner join "b" on (select count(*) = 0 from "c" where 1 and "a"."k" = ?)',
      { a: [], b: [], c: [] },
    ],
    [
      'an `AND` of a `SELECT` of no `FROM`',
      'select 1 from "a" where (select count(*) = 0 where 1 and "a"."k" = ?)',
      { a: [] },
    ],
    [
      'an `AND` of an `ORDER BY`',
      'select 1 from "a" where (select 1 from "b" order by 1 and "a"."k" = ?)',
      { a: [], b: [] },
    ],
    [
      'an `OR` past an `AND`',
      'select 1 from "a" inner join "b" on 1 where "a"."k" = ? and "a"."x" = ? or "a"."y" = ?',
      { a: [], b: [] },
    ],
    [
      'an `AND` in a `CASE`',
      'select 1 from "a" inner join "b" on 1 where case when 1 and "a"."k" = ? and 1 then 1 else 0 end',
      { a: [], b: [] },
    ],
    [
      'a column of the scope around a subquery, to which an equality hands nothing',
      'select 1 from "a" where exists (select 1 from "b" where "b"."k" = ? and "b"."k" = "a"."f")',
      { a: [], b: ['k=0'] },
    ],
    [
      "a bare name in a subquery, which may be of any scope's",
      'select 1 from "a" where exists (select 1 from "b" where "k" = ?)',
      { a: [], b: [] },
    ],
    [
      'a term of an outer source in a subquery, which is no term of its rows',
      'select 1 from "a" where exists (select 1 from "b" where "a"."k" = ?)',
      { a: [], b: [] },
    ],
  ])('names no row of %s', (_name, sql, terms) => {
    expect(termsIn(sql)).toStrictEqual(terms);
  });

  it.each([
    ['a set operation', 'select 1 from "a" union select 1 from "b"'],
    ['a `WITH`', 'with c as (select 1) select * from "c"'],
    ['a comma join', 'select 1 from "a", "b" where "a"."k" = ?'],
    ['a cross join', 'select 1 from "a" cross join "b" where "a"."k" = ?'],
    ['a right join', 'select 1 from "a" right join "b" on "b"."k" = "a"."k"'],
    ['a full join', 'select 1 from "a" full join "b" on "b"."k" = "a"."k"'],
    ['a natural join', 'select 1 from "a" natural join "b"'],
    ['a `USING`', 'select 1 from "a" inner join "b" using ("k")'],
    ['a window', 'select row_number() over (order by "a"."k") from "a"'],
    ['`IS NOT DISTINCT FROM`', 'select 1 from "a" where "a"."k" is not distinct from ? or 1'],
    ['`x IN "t"`, of a table no source names', 'select 1 from "a" where "a"."k" in "b"'],
    ['a table of another schema', 'select 1 from "main"."a"'],
    ['a parenthesized join', 'select 1 from ("a" inner join "b" on 1)'],
    [
      'a table-valued function of its own',
      'select 1 from "a" inner join pragma_table_info(?) "p" on 1',
    ],
    ['a comment', 'select 1 from "a" /* x */ where "a"."k" = ?'],
    ['a numbered parameter', 'select 1 from "a" inner join "b" on 1 where "a"."k" = ?1'],
    ['an `INDEXED BY`', 'select 1 from "a" indexed by "i" inner join "b" on 1'],
    // SQLite takes up to three words of a join, of any order, and a word after `AS` as an alias.
    ['`LEFT OUTER OUTER`', 'select 1 from "a" inner join "b" on 1 left outer outer join "c" on 1'],
    ['`OUTER LEFT`', 'select 1 from "a" outer left join "b" on 1'],
    ['`LEFT LEFT`', 'select 1 from "a" left left join "b" on 1'],
    ['`CROSS INNER`', 'select 1 from "a" cross inner join "b" on 1'],
    ['`INNER INNER`', 'select 1 from "a" inner inner join "b" on 1'],
    ['an alias `LEFT`', 'select 1 from "a" as left join "b" on 1'],
    ['an alias `INNER`', 'select 1 from "a" as inner join "b" on 1'],
    ['an `AS` of nothing', 'select 1 from "a" as'],
    // SQLite stops at a NUL, and reads each lone surrogate as U+FFFD.
    [
      'a `FROM` past a `WHERE`',
      'select 1 from "a" where exists (select 1 where 1 is distinct from "x")',
    ],
    ['`IS DISTINCT FROM` of no `FROM`', 'select 1 is distinct from "a" where "a"."k" = ?'],
    [
      '`IS NOT DISTINCT FROM` of no `FROM`, nested',
      'select 1 from "b" where exists (select 1 is not distinct from "a" where "a"."k" = ?)',
    ],
    ['a NUL', 'select 1 from "a" inner join "b" on 1 where 1\0 and "a"."k" = ?'],
    ['a lone surrogate', 'select 1 from "a" "\u{D800}" inner join "b" on 1'],
  ])('reads not %s', (_name, sql) => {
    expect(statementRead(sql)).toBeUndefined();
  });

  it.each([
    ['a NUL', 'select * from "a" where 1\0 and "a"."k" = ?'],
    ['a lone surrogate', 'select * from "a" where "a"."\u{D800}" = ?'],
  ])('reads no condition of one table past %s', (_name, sql) => {
    expect(conditionsOf(sql)).toBeUndefined();
  });

  it('reads by its words a text of a lone surrogate, which writes nothing either way', () => {
    expect(readsAlone("with x as (select '\u{D800}' as v) select v from x")).toBe(true);
  });

  it('reads a `SELECT DISTINCT`, whose `FROM` is the clause', () => {
    expect(termsIn('select distinct "a"."k" from "a" where "a"."k" = ?')).toStrictEqual({
      a: ['k=0'],
    });
  });

  it.each([
    ['a word after `AS`', 'select 1 from "a" as left where "left"."k" = ?', { left: ['k=0'] }],
    ['`LEFT OUTER`', 'select 1 from "a" left outer join "b" on "b"."x" = ?', { a: [], b: ['x=0'] }],
    ['`INNER`', 'select 1 from "a" inner join "b" on "b"."x" = ?', { a: [], b: ['x=0'] }],
    ['a bare `JOIN`', 'select 1 from "a" join "b" on "b"."x" = ?', { a: [], b: ['x=0'] }],
  ])('still reads %s', (_name, sql, terms) => {
    expect(termsIn(sql)).toStrictEqual(terms);
  });

  it('hands no parameter across columns compared otherwise', () => {
    const read = plainly('select 1 from "a" inner join "b" on "b"."k" = "a"."k" where "a"."k" = ?');
    const terms = termsOf(read, (of) => (of.occurrence.alias === 'a' ? 'integer' : 'text'));

    expect([...terms.keys()].map((each) => each.alias)).toStrictEqual(['a']);
  });

  // SQLite resolves what a function is given among every source of its scope, one after it too.
  it("reads a function's argument of a source that stands after it", () => {
    const read = plainly(`
      select "a"."k" from "a" where "a"."k" = ? and exists (
        select 1 from json_each((
          select json_group_array("c"."v") from "c" where "c"."k" = "a"."k"
        )) "j" inner join "b" "a" on 1)`);
    const terms = termsOf(read, () => 'text');

    expect([...terms.keys()].map((each) => each.table)).toStrictEqual(['a']);
  });

  // A derived table sees the scope around its own, not a sibling of the alias that scope holds.
  it('reads a derived table of the scope around its siblings', () => {
    const read = plainly(`
      select 1 from "a" where exists (
        select 1 from "c" "a"
        inner join (select 1 from "b" where "b"."k" = "a"."k") "d" on 1
        where "a"."k" = ?)`);
    const terms = termsOf(read, () => 'text');

    expect([...terms.keys()].map((each) => each.table)).toStrictEqual(['c']);
  });

  it('reads the functions a statement reads as tables', () => {
    const read = statementRead('select 1 from "a" where exists (select 1 from json_each(?) "j")');

    expect(read?.functions).toStrictEqual(['json_each']);
  });

  it.each([
    ['integer', false, 'integer'],
    ['VARCHAR(10)', false, 'text'],
    ['text', true, undefined],
    ['blob', false, undefined],
    [undefined, false, undefined],
  ])('compares a column of type %s, collated %s, as %s', (type, collated, comparison) => {
    expect(comparisonOf(type, collated)).toBe(comparison);
  });
});

/** What `read` says of each source, but the occurrence it stands for: its kind, of none. */
function sourcesIn(read: Sources) {
  if (read.kind !== 'sources') throw new Error(`of no sources: ${read.kind}`);
  return read.sources.map(({ columns, table, terms }) => ({ columns, table, terms }));
}

/** Each edge of `sql`, as `to = from`, of columns compared alike unless `comparison` says. */
function edgesIn(sql: string, comparison: Comparison = () => 'text') {
  const edges = edgesOf(plainly(sql), comparison);
  return edges.map(
    ({ from, to }) => `${to.occurrence.alias}.${to.column}=${from.occurrence.alias}.${from.column}`,
  );
}

/** An entry of the schema, of a table of one text column unless it says otherwise. */
function entry(name: string, type = 'table', sql = 'CREATE TABLE t (k TEXT)'): SchemaEntry {
  return { name, rootpage: 1, sql, tableName: name, type };
}

describe('the equalities that hold of the rows of a source', () => {
  it.each([
    [
      "an inner join's, of each side",
      'select 1 from "a" inner join "b" on "b"."k" = "a"."f"',
      ['b.k=a.f', 'a.f=b.k'],
    ],
    [
      "a `LEFT JOIN`'s, of its right table alone",
      'select 1 from "a" left join "b" on "b"."k" = "a"."f"',
      ['b.k=a.f'],
    ],
    [
      'a `WHERE` over a left join, of each side',
      'select 1 from "a" left join "b" on 1 where "b"."k" = "a"."f"',
      ['b.k=a.f', 'a.f=b.k'],
    ],
    [
      "a subquery's, of its own source alone",
      'select 1 from "a" where exists (select 1 from "b" where "b"."k" = "a"."f")',
      ['b.k=a.f'],
    ],
    [
      "a `NOT EXISTS`'s, of its own source",
      'select 1 from "a" where not exists (select 1 from "b" where "b"."k" = "a"."f")',
      ['b.k=a.f'],
    ],
    ['none under an `OR`', 'select 1 from "a" inner join "b" on "b"."k" = "a"."f" or 1', []],
    ['none of `IS`', 'select 1 from "a" inner join "b" on "b"."k" is "a"."f"', []],
  ])('reads %s', (_name, sql, edges) => {
    expect(edgesIn(sql)).toStrictEqual(edges);
  });

  it('reads none of columns compared otherwise', () => {
    const sql = 'select 1 from "a" inner join "b" on "b"."k" = "a"."f"';

    expect(
      edgesIn(sql, ({ occurrence }) => (occurrence.alias === 'a' ? 'integer' : 'text')),
    ).toStrictEqual([]);
    expect(
      edgesIn(sql, ({ occurrence }) => (occurrence.alias === 'x' ? 'text' : undefined)),
    ).toStrictEqual([]);
  });
});

describe('what a plan says of the sources a statement names', () => {
  const texts = new Map([['k', 'TEXT']]);
  const columns = new Map([
    ['a', texts],
    ['b', texts],
  ]);
  const joined = 'select 1 from "a" inner join "b" on "b"."k" = "a"."k" where "a"."k" = ?';
  const plain = [entry('a'), entry('b')];

  it('reads each source of the terms that restrict it', () => {
    const read = sourcesOf(plainly(joined), {
      columns,
      opened: new Set(['a', 'b']),
      schema: plain,
      virtuals: 0,
    });

    expect(sourcesIn(read)).toStrictEqual([
      { columns: texts, table: 'a', terms: [{ column: 'k', params: [0] }] },
      { columns: texts, table: 'b', terms: [{ column: 'k', params: [0] }] },
    ]);
  });

  it('hands no parameter to a table of a collation of its own', () => {
    const schema = [entry('a'), entry('b', 'table', 'CREATE TABLE b (k TEXT COLLATE NOCASE)')];
    const read = sourcesOf(plainly(joined), {
      columns,
      opened: new Set(['a', 'b']),
      schema,
      virtuals: 0,
    });

    expect(sourcesIn(read)).toStrictEqual([
      { columns: texts, table: 'a', terms: [{ column: 'k', params: [0] }] },
      { columns: texts, table: 'b', terms: [] },
    ]);
  });

  it('reads no source of a table the bytecode opens not', () => {
    const read = sourcesOf(plainly('select 1 from "a" left join "b" on "b"."k" = "a"."k"'), {
      columns,
      opened: new Set(['a']),
      schema: plain,
      virtuals: 0,
    });

    expect(sourcesIn(read)).toStrictEqual([{ columns: texts, table: 'a', terms: [] }]);
  });

  it.each([
    {
      kind: 'whole',
      name: 'a table it names not',
      opened: ['a', 'b', 'c'],
      schema: plain,
      virtuals: 0,
    },
    {
      kind: 'whole',
      name: 'a view',
      opened: ['a'],
      schema: [entry('a'), entry('b', 'view')],
      virtuals: 0,
    },
    {
      kind: 'every',
      name: 'a view, of a virtual table',
      opened: ['a'],
      schema: [entry('a'), entry('b', 'view')],
      virtuals: 1,
    },
    {
      kind: 'every',
      name: 'a virtual table',
      opened: ['a'],
      schema: [entry('a'), entry('b', 'table', 'CREATE VIRTUAL TABLE b USING fts5(k)')],
      virtuals: 1,
    },
  ])('reads a statement of $name as $kind', ({ kind, opened, schema, virtuals }) => {
    const read = sourcesOf(plainly(joined), {
      columns,
      opened: new Set(opened),
      schema,
      virtuals,
    });

    expect(read.kind).toBe(kind);
  });

  it('reads every table where a table of that name stands in for a function', () => {
    const read = sourcesOf(plainly('select 1 from "a" inner join json_each(?) "j" on 1'), {
      columns,
      opened: new Set(['a']),
      schema: [entry('a'), entry('json_each')],
      virtuals: 0,
    });

    expect(read.kind).toBe('every');
  });
});
