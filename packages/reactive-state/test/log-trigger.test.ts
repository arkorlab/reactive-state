import { type DatabaseSync, DatabaseSync as Database } from 'node:sqlite';

import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { followDrizzle } from '../src/sql/index.ts';
import { type FollowedInstall, installedOf, logTrigger } from '../src/sql/sqlite/installed.ts';
import { oracleDatabase } from './support/sqlite-oracle.ts';

/**
 * What reads as a trigger of the change log's own: the text `capture.ts` writes, of every shape of
 * table, and none that reads another source (a join, a comma, `IN`, or a name in a string or a
 * comment that fakes its own table), which may raise and end the statement unlogged.
 */

type Row = Record<string, unknown>;

/** A row id past those of the schema: a trigger made after them. */
const LATE = 1_000_000;

/** A table of no key and a unique index of part of the rows. */
const loose = sqliteTable('loose', { a: text(), n: integer() }, (table) => {
  return [
    uniqueIndex('loose_n')
      .on(table.n)
      .where(sql`${table.n} > 0`),
  ];
});

/** The rows of the triggers of a database. */
function triggersOf(db: DatabaseSync): Row[] {
  return db
    .prepare("SELECT rowid, type, name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger'")
    .all();
}

/** What the database is held to of the tables whose triggers are `rows`, as they were made. */
function followedOf(rows: readonly Row[]): FollowedInstall {
  const triggers = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const made = triggers.get(String(row['tbl_name'])) ?? new Map<string, string>();
    made.set(String(row['name']), String(row['sql']));
    triggers.set(String(row['tbl_name']), made);
  }
  const byName = new Map([...triggers.keys()].map((name) => [name, name] as const));
  return { byName, partials: new Map(), rowids: new Map(), triggers, uniques: new Map() };
}

/** A trigger shaped as the log's own on `member`, of the statement `body`. */
function shaped(body: string): Row {
  return {
    name: '_rsd_00_insert',
    rowid: LATE,
    sql: `CREATE TRIGGER "_rsd_00_insert" AFTER INSERT ON "member" BEGIN INSERT INTO _rs_changes (tbl, id, before, after, at) ${body}; END`,
    tbl_name: 'member',
    type: 'trigger',
  };
}

/** The bodies that read a view `quiet`, which raises, past a log-shaped head. */
const READING = [
  ['a comma join', `SELECT 'member', '', NULL, NULL, 0 FROM "member" AS c , quiet`],
  ['IN of a name', `VALUES ('member', '', NULL, NULL, 0 IN quiet)`],
  [
    'the own text in a string',
    `SELECT 'FROM "member" AS c WHERE ', quiet.x, NULL, NULL, 0 FROM quiet`,
  ],
  [
    'the own text in a comment',
    `SELECT 'member', quiet.x, NULL, NULL, 0 FROM quiet /* FROM "member" AS c WHERE */`,
  ],
  ['a join', `SELECT 'member', quiet.x, NULL, NULL, 0 FROM "member" AS c JOIN quiet`],
] as const;

/** The upserts of a log-shaped trigger, which can update a row of the log. */
const UPSERTING = [
  [
    'ON CONFLICT DO UPDATE',
    `VALUES ('member', '', NULL, NULL, 0) ON CONFLICT DO UPDATE SET at = 1`,
  ],
  ['ON CONFLICT DO NOTHING', `VALUES ('member', '', NULL, NULL, 0) ON CONFLICT DO NOTHING`],
] as const;

describe('a trigger of the change log’s own', () => {
  it('is each trigger capture.ts writes, of every shape of table', () => {
    const { db } = oracleDatabase(false);
    const other = new Database(':memory:');
    other.exec(
      'CREATE TABLE loose (a TEXT, n INTEGER); CREATE UNIQUE INDEX loose_n ON loose (n) WHERE n > 0',
    );
    const statements = followDrizzle({ loose }).captureSql();
    for (const statement of statements) other.exec(statement);
    const [bare, partial] = [triggersOf(db), triggersOf(other)];
    const rows = [...bare, ...partial];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => !logTrigger(row))).toStrictEqual([]);
  });

  it.each(READING)('is not one that reads a view by %s', (_what, body) => {
    expect(logTrigger(shaped(body))).toBe(false);
  });

  it.each(UPSERTING)('is not one that ends in %s', (_what, body) => {
    expect(logTrigger(shaped(body))).toBe(false);
  });

  it.each(READING.slice(0, 3))(
    'leaves the table untriggered where one that reads a view by %s fires after',
    async (_what, body) => {
      const oracle = oracleDatabase(false);
      const rows = triggersOf(oracle.db);
      const followed = followedOf(rows);
      const before = await installedOf(oracle.binding, followed, rows);
      const after = await installedOf(oracle.binding, followed, [...rows, shaped(body)]);

      expect(before.untriggered.size).toBe(0);
      expect([...after.untriggered]).toContain('member');
    },
  );
});
