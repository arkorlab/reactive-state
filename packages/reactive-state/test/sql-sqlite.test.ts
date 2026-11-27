import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { bytecodeReads, type SchemaEntry } from '../src/sql/sqlite/bytecode.ts';
import { followedSqliteTable } from '../src/sql/sqlite/capture.ts';
import { holdsKind, sqliteKeyText } from '../src/sql/sqlite/values.ts';
import {
  conditionsOf,
  namesPragmaFunction,
  readsAlone,
  soleStatement,
} from '../src/sql/sqlite/where.ts';

/**
 * What a statement of D1 is followed by: the conditions of one table's statement as Drizzle writes
 * it, each value as the text the log keeps of the row, and the tables its bytecode reads.
 */

describe("the conditions of a statement of one table's", () => {
  it.each([
    [
      'select "id", "title" from "tasks" where "tasks"."project_id" = ?',
      [{ column: 'project_id', params: [0] }],
    ],
    [
      'select "id" from "tasks" where ("tasks"."project_id" = ? and "tasks"."id" = ?)',
      [
        { column: 'project_id', params: [0] },
        { column: 'id', params: [1] },
      ],
    ],
    [
      'select "id" from "tasks" where "tasks"."id" in (?, ?, ?)',
      [{ column: 'id', params: [0, 1, 2] }],
    ],
    ['select ?, "id" from "tasks" where "tasks"."id" = ? limit ?', [{ column: 'id', params: [1] }]],
    ['select "id" from "tasks" where ? = "tasks"."id"', [{ column: 'id', params: [0] }]],
    ['select "id" from "tasks" where "id" = ?', [{ column: 'id', params: [0] }]],
    ['select "id" from "tasks"', []],
    ['select "id" from "tasks" where "tasks"."id" = ? or "tasks"."id" = ?', []],
    ['select "id" from "tasks" where not "tasks"."done"', []],
    ['select "id" from "tasks" where "tasks"."title" = ? collate nocase', []],
    ['select "id" from "tasks" where "other"."id" = ?', []],
    ['select "id" from "tasks" where "tasks"."id" != ?', []],
    ['select "id" from "tasks" where "tasks"."id" = ? + 1', []],
    ['select "id" from "tasks" where "tasks"."title" = \'x\'', []],
    // `offset` and `window` may name a column; only `group`, `having`, `limit` and `order` end it.
    ['select "id" from "tasks" where "tasks"."id" = ? and offset = 0 or "tasks"."id" = 2', []],
    ['select "id" from "tasks" where "tasks"."id" = ? and window = 0 or "tasks"."id" = 2', []],
    [
      'select "id" from "tasks" where "tasks"."id" = ? and cast(? as offset) or "tasks"."id" = 2',
      [],
    ],
    // A name past ASCII is one name, a space past it one of its characters, as SQLite reads them.
    ['select "id" from "tasks" where "tasks"."id" = ? and élimit = 0 or "tasks"."id" = 2', []],
    [
      'select "id" from "tasks" where "tasks"."id" = ? and a\u{A0}limit = 0 or "tasks"."id" = 2',
      [],
    ],
    // An alias of the table, as Drizzle's relational queries write one: its columns are the alias's.
    [
      'select "id" from "tasks" "tasksAlias" where "tasksAlias"."project_id" = ? limit ?',
      [{ column: 'project_id', params: [0] }],
    ],
    [
      'select "id" from "tasks" as "t" where ("t"."project_id" = ? and "id" = ?)',
      [
        { column: 'project_id', params: [0] },
        { column: 'id', params: [1] },
      ],
    ],
    ['select "id" from "tasks" "t" where "tasks"."project_id" = ?', []],
    [
      'select "id" from "tasks" where "tasks"."id" = ? order by "tasks"."id" limit ? offset ?',
      [{ column: 'id', params: [0] }],
    ],
    [
      'select "id" from "tasks" where ("tasks"."done" between ? and ? and "tasks"."id" = ?)',
      [{ column: 'id', params: [2] }],
    ],
    // A range within a range: whose `AND` each is, is read not.
    [
      'select "id" from "tasks" where "tasks"."id" between 1 between 0 and 2 and "tasks"."id" = ?',
      [],
    ],
    // `("done" between ? and "id") = ?`: the `AND` is the range's, and no term is the column's.
    ['select "id" from "tasks" where "tasks"."done" between ? and "tasks"."id" = ?', []],
    [
      'select "id" from "tasks" where case when "tasks"."done" and "tasks"."id" = ? and 1 then 0 else 1 end',
      [],
    ],
  ])('of %s', (sql, terms) => {
    expect(conditionsOf(sql)).toStrictEqual({ table: 'tasks', terms });
  });

  it.each([
    ['select "tasks"."id" from "tasks" join "projects" on "tasks"."project_id" = "projects"."id"'],
    ['select "id" from "tasks", "projects"'],
    ['select "id" from "tasks" where "tasks"."id" in (select "id" from "projects")'],
    ['with "x" as (select 1) select "id" from "tasks"'],
    ['select "id" from "tasks" union select "id" from "projects"'],
    ['select "id" from "tasks" where "tasks"."id" = ?1'],
    ['select "id" from "tasks" -- a comment'],
    ['select `id` from `tasks`'],
    ['select "id" from tasks'],
    ['insert into "tasks" ("id") values (?)'],
    ['select "id" from "tasks" where exists (select 1)'],
    [
      'select * from "tasks" where "tasks"."id" = ? \u{FEFF}union \u{FEFF}select * \u{FEFF}from "tasks"',
    ],
    // `in "t"` is a subquery of the table's other rows, in the condition or out of it.
    [
      'select "id" from "tasks" where "tasks"."id" = ? and ("tasks"."id", "tasks"."code") in "tasks"',
    ],
    ['select ("tasks"."id") in "tasks" from "tasks" where "tasks"."id" = ?'],
    ['select "id" from "tasks" where "tasks"."id" = ? and "tasks"."id" not in "tasks"'],
    // SQLite numbers a named parameter among the `?`s: `"id"` is of the second value.
    ['select "id" from "tasks" where "tasks"."project_id" = :p and "tasks"."id" = ?'],
    ['select "id" from "tasks" where "tasks"."project_id" = $p and "tasks"."id" = ?'],
    ['select "id" from "tasks" where "tasks"."project_id" = @p and "tasks"."id" = ?'],
  ])('of none of %s', (sql) => {
    expect(conditionsOf(sql)).toBeUndefined();
  });
});

describe('whether a text is one statement', () => {
  it.each([
    ['select 1', true],
    ['select 1;', true],
    ['select 1;; -- done\n', true],
    ['select 1; /* done */ ', true],
    ['select \';\' from "tasks"', true],
    ['select "a;b" from "tasks"', true],
    ['select [a;b], `c;d` from "tasks"', true],
    ['select 1 -- ;\n from "tasks"', true],
    ['select 1; select 2', false],
    ['select 1; insert into "tasks" ("id") values (1)', false],
    ["select 1; 'x'", false],
    // A named parameter is read to its own end, past a quote within it, by SQLite.
    ['select $a(\');create table "x" ("y");--\')', false],
    ['select:a(\') as x; delete from "tasks"; --\'', false],
    ['select@a(\') as x; delete from "tasks"; --\'', false],
    ['select ? from "tasks"', true],
    ['select "a$b" from "tasks"', true],
  ])('of %j', (sql, sole) => {
    expect(soleStatement(sql)).toBe(sole);
  });
});

describe('whether a text reads alone, by its words', () => {
  it.each([
    ['with "x" as (select 1) select * from "tasks"', true],
    ['select "delete", \'update\' from "tasks"', true],
    ['with "x" as (select 1) delete from "tasks"', false],
    ['insert into "tasks" ("id") values (1)', false],
    ['with "x" as (select 1) select * from "tasks"; select 2', false],
    // SQLite's own `replace()` reads, but a read of no plan names no word a write holds.
    ['with "x" as (select replace("title", \'a\', \'b\') from "tasks") select * from "x"', false],
    ['with "x" as (select 1) select * from "tasks" -- a comment', false],
    // A byte order mark is a space to SQLite where a token begins: `\u{FEFF}DELETE` is `DELETE`.
    ['with "x" as (select 1) \u{FEFF}delete from "tasks"', false],
    ['begin', false],
    ['savepoint "x"', false],
  ])('of %j', (sql, reads) => {
    expect(readsAlone(sql)).toBe(reads);
  });
});

describe("a value's text, as the log keeps a row of it", () => {
  it.each([
    ['integer', 5, '5'],
    ['integer', -5, '-5'],
    ['integer', 9_007_199_254_740_993n, '9007199254740993'],
    ['integer', '42', '42'],
    ['integer', '05', undefined],
    ['integer', '-0', undefined],
    ['integer', 5.5, undefined],
    ['integer', 9_223_372_036_854_775_808n, undefined],
    ['integer', -9_223_372_036_854_775_807n, '-9223372036854775807'],
    // A real of the least integer stays one in a column of integers, and is written as a real.
    ['integer', -9_223_372_036_854_775_808n, undefined],
    ['integer', '-9223372036854775808', undefined],
    ['integer', null, undefined],
    ['boolean', true, '1'],
    ['boolean', 0, '0'],
    ['boolean', 2, undefined],
    ['text', 'a', 'a'],
    ['text', '\u{D800}', undefined],
    ['text', 'a\0b', undefined],
    ['text', 5, undefined],
  ] as const)('of a %s key of %s', (kind, value, written) => {
    expect(sqliteKeyText(kind, value)).toBe(written);
  });

  it.each([
    ['integer', 'INTEGER', true],
    ['boolean', 'integer', true],
    ['text', 'TEXT', true],
    ['text', 'varchar(10)', true],
    ['text', 'INTEGER', false],
    ['integer', 'TEXT', false],
    ['text', 'BLOB', false],
    ['text', '', false],
  ] as const)('of a %s key of a column declared %s', (kind, declared, holds) => {
    expect(holdsKind(kind, declared)).toBe(holds);
  });
});

describe("the tables a statement's bytecode reads", () => {
  const schema: SchemaEntry[] = [
    {
      name: 'tasks',
      rootpage: 4,
      sql: 'CREATE TABLE tasks (id)',
      tableName: 'tasks',
      type: 'table',
    },
    { name: 'tasks_project', rootpage: 5, sql: null, tableName: 'tasks', type: 'index' },
  ];

  it('reads the table of each b-tree it opens to read, an index for its table', () => {
    const read = bytecodeReads(
      [
        { opcode: 'OpenRead', p1: 1, p2: 5, p3: 0 },
        { opcode: 'OpenEphemeral', p1: 2, p2: 0, p3: 0 },
        { opcode: 'Insert', p1: 2, p2: 0, p3: 0 },
        { opcode: 'Transaction', p1: 0, p2: 0, p3: 5 },
        { opcode: 'Halt', p1: 0, p2: 0, p3: 0 },
      ],
      schema,
    );

    expect(read).toStrictEqual({ kind: 'reads', tables: new Set(['tasks']), virtuals: 0 });
  });

  it('counts the virtual tables it opens, whose reads no root page names', () => {
    const read = bytecodeReads(
      [
        { opcode: 'VOpen', p1: 0, p2: 0, p3: 0 },
        { opcode: 'OpenRead', p1: 1, p2: 5, p3: 0 },
        { opcode: 'VOpen', p1: 2, p2: 0, p3: 0 },
        { opcode: 'Transaction', p1: 0, p2: 0, p3: 5 },
        { opcode: 'Halt', p1: 0, p2: 0, p3: 0 },
      ],
      schema,
    );

    expect(read).toStrictEqual({ kind: 'reads', tables: new Set(['tasks']), virtuals: 2 });
  });

  // An answer of `EXPLAIN` that is no program as SQLite writes one is read as no answer.
  it.each([[[]], [[{ opcode: 'undefined', p1: undefined, p2: undefined, p3: undefined }]]])(
    'reads %j as unread',
    (instructions) => {
      expect(bytecodeReads(instructions, schema).kind).toBe('unread');
    },
  );

  it.each([
    [{ opcode: 'OpenWrite', p1: 0, p2: 4, p3: 0 }, 'writes'],
    [{ opcode: 'Transaction', p1: 0, p2: 1, p3: 5 }, 'writes'],
    // `PRAGMA optimize` runs SQL of its own in a read transaction of some builds.
    [{ opcode: 'SqlExec', p1: 0, p2: 0, p3: 0 }, 'writes'],
    [{ opcode: 'Vacuum', p1: 0, p2: 0, p3: 0 }, 'writes'],
    [{ opcode: 'AutoCommit', p1: 0, p2: 0, p3: 0 }, 'writes'],
    [{ opcode: 'Savepoint', p1: 0, p2: 0, p3: 0 }, 'writes'],
    [{ opcode: 'OpenRead', p1: 0, p2: 4, p3: 1 }, 'unread'],
    [{ opcode: 'OpenRead', p1: 0, p2: 9, p3: 0 }, 'unread'],
  ] as const)('reads %j as %s', (instruction, kind) => {
    expect(bytecodeReads([instruction], schema).kind).toBe(kind);
  });

  // An FTS5 table's update opens the table before it updates it, in a write transaction.
  it.each([
    [{ opcode: 'VUpdate', p1: 0, p2: 3, p3: 0 }],
    [{ opcode: 'Transaction', p1: 0, p2: 1, p3: 5 }],
    [{ opcode: 'OpenWrite', p1: 1, p2: 4, p3: 0 }],
  ] as const)('reads a write %j after a virtual table it opens as a write', (write) => {
    const instructions = [{ opcode: 'VOpen', p1: 0, p2: 0, p3: 0 }, write];

    expect(bytecodeReads(instructions, schema).kind).toBe('writes');
  });
});

describe("the name a table's rowid is read by", () => {
  it.each([
    [{ id: text().primaryKey() }, 'rowid'],
    // SQLite's names are of any case: a column `ROWID` is the one `rowid` reads.
    [{ id: text().primaryKey(), shadow: text('ROWID') }, '_rowid_'],
    [{ a: text('RowId'), b: text('_ROWID_') }, 'oid'],
    [{ a: text('rowid'), b: text('_rowid_'), c: text('OID') }, undefined],
  ])('of %#', (columns, rowid) => {
    expect(followedSqliteTable('t', sqliteTable('t', columns), []).rowid).toBe(rowid);
  });
});

describe("whether a text names one of SQLite's pragma_ functions", () => {
  it.each([
    ['select * from pragma_optimize(65538)', true],
    ['select * from "PRAGMA_OPTIMIZE"', true],
    ['select * from main.[pragma_optimize]', true],
    // A string that begins with one is read as a name where a name stands.
    ["select * from 'pragma_optimize'()", true],
    ["select * from 'PRAGMA_OPTIMIZE'", true],
    ['select \'a pragma_optimize\' from "tasks"', false],
    ['select "id" /* pragma_optimize */ from "tasks"', false],
    // A quoted name is read whole: its `--`, `'` or `/*` begins nothing.
    ['select 1 as "--", * from pragma_optimize(65538)', true],
    ['select 1 as "\'", * from pragma_optimize(65538)', true],
    ["select 1 as `'`, * from pragma_optimize(65538)", true],
    ['select 1 as [/*], * from pragma_optimize(65538)', true],
    ['select "my_pragma_x" from "tasks"', false],
  ])('of %j', (sql, named) => {
    expect(namesPragmaFunction(sql)).toBe(named);
  });
});
