import { env } from 'cloudflare:workers';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, it } from 'vitest';

import { followedSqliteTable, sqliteCaptureSql } from '../../src/sql/sqlite/capture.ts';
import { sqliteKeysOf } from '../../src/sql/sqlite/keys.ts';

/**
 * The change log a Drizzle schema's tables write in D1, run in workerd: a row of each row a
 * statement changed, of the text of its keys before and after, and of each row `REPLACE` deletes.
 */

const tasks = sqliteTable(
  'tasks',
  {
    id: integer().primaryKey(),
    projectId: text('project_id').notNull(),
    title: text().notNull(),
    done: integer({ mode: 'boolean' }).notNull().default(false),
    code: text().unique(),
  },
  (table) => [index('tasks_project').on(table.projectId)],
);
const notes = sqliteTable('notes', { body: text() });
const parents = sqliteTable('parents', { id: text().primaryKey() });
const children = sqliteTable('children', {
  id: integer().primaryKey(),
  parentId: text('parent_id').references(() => parents.id, { onDelete: 'cascade' }),
});

/** The log's rows after `seq`, as the triggers wrote them. */
async function logged(after = 0) {
  const { results } = await env.REACTIVE_D1.prepare(
    'SELECT tbl, id, before, after FROM _rs_changes WHERE seq > ? ORDER BY seq',
  )
    .bind(after)
    .all<{ tbl: string; id: string; before: string | null; after: string | null }>();
  return results.map((row) => {
    return {
      after: row.after === null ? null : (JSON.parse(row.after) as unknown),
      before: row.before === null ? null : (JSON.parse(row.before) as unknown),
      id: row.id,
      tbl: row.tbl,
    };
  });
}

/** The log's head. */
async function head(): Promise<number> {
  const row = await env.REACTIVE_D1.prepare(
    "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = '_rs_changes'), 0) AS seq",
  ).first<{ seq: number }>();
  return row?.seq ?? 0;
}

describe('the change log of a Drizzle schema in D1', () => {
  beforeEach(async () => {
    const db = env.REACTIVE_D1;
    await db.batch(
      [
        'DROP TABLE IF EXISTS tasks',
        'DROP TABLE IF EXISTS notes',
        'DROP TABLE IF EXISTS _rs_changes',
        'DROP TABLE IF EXISTS _rs_meta',
        'CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, code TEXT UNIQUE)',
        'CREATE INDEX tasks_project ON tasks (project_id)',
        'CREATE TABLE notes (body TEXT)',
      ].map((statement) => db.prepare(statement)),
    );
    const followed = [
      followedSqliteTable('tasks', tasks, sqliteKeysOf(tasks)),
      followedSqliteTable('notes', notes, sqliteKeysOf(notes)),
    ];
    await db.batch(sqliteCaptureSql(followed).map((statement) => db.prepare(statement)));
  });

  it("logs each row's keys before and after a change", async () => {
    const db = env.REACTIVE_D1;
    const at = await head();
    await db
      .prepare("INSERT INTO tasks (id, project_id, title, code) VALUES (1, 'p1', 'one', 'a')")
      .run();
    await db.prepare("UPDATE tasks SET project_id = 'p2', done = 1 WHERE id = 1").run();
    await db.prepare('DELETE FROM tasks WHERE id = 1').run();

    await expect(logged(at)).resolves.toStrictEqual([
      {
        after: { k_code: 'a', k_done: '0', k_id: '1', k_project_id: 'p1' },
        before: null,
        id: 'row',
        tbl: 'tasks',
      },
      {
        after: { k_code: 'a', k_done: '1', k_id: '1', k_project_id: 'p2' },
        before: { k_code: 'a', k_done: '0', k_id: '1', k_project_id: 'p1' },
        id: 'row',
        tbl: 'tasks',
      },
      {
        after: null,
        before: { k_code: 'a', k_done: '1', k_id: '1', k_project_id: 'p2' },
        id: 'row',
        tbl: 'tasks',
      },
    ]);
  });

  it('logs each row a REPLACE deletes, of its primary key and of a unique column', async () => {
    const db = env.REACTIVE_D1;
    await db
      .prepare(
        "INSERT INTO tasks (id, project_id, title, code) VALUES (1, 'p1', 'one', 'a'), (2, 'p2', 'two', 'b')",
      )
      .run();
    const at = await head();
    await db
      .prepare(
        "INSERT OR REPLACE INTO tasks (id, project_id, title, code) VALUES (3, 'p3', 'three', 'a')",
      )
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO tasks (id, project_id, title, code) VALUES (2, 'p9', 'nine', 'z')",
      )
      .run();

    const entries = await logged(at);

    expect(entries).toContainEqual({
      after: null,
      before: { k_code: 'a', k_done: '0', k_id: '1', k_project_id: 'p1' },
      id: 'row',
      tbl: 'tasks',
    });
    expect(entries).toContainEqual({
      after: null,
      before: { k_code: 'b', k_done: '0', k_id: '2', k_project_id: 'p2' },
      id: 'row',
      tbl: 'tasks',
    });
  });

  it('logs each row a foreign key deletes of its own', async () => {
    const db = env.REACTIVE_D1;
    await db.batch(
      [
        'DROP TABLE IF EXISTS children',
        'DROP TABLE IF EXISTS parents',
        'CREATE TABLE parents (id TEXT PRIMARY KEY)',
        'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id TEXT REFERENCES parents (id) ON DELETE CASCADE)',
        "INSERT INTO parents VALUES ('a')",
        "INSERT INTO children VALUES (1, 'a')",
      ].map((statement) => db.prepare(statement)),
    );
    const followed = [
      followedSqliteTable('parents', parents, sqliteKeysOf(parents)),
      followedSqliteTable('children', children, sqliteKeysOf(children)),
    ];
    await db.batch(sqliteCaptureSql(followed).map((statement) => db.prepare(statement)));
    const at = await head();

    await db.prepare("DELETE FROM parents WHERE id = 'a'").run();

    await expect(logged(at)).resolves.toContainEqual({
      after: null,
      before: { k_id: '1', k_parent_id: 'a' },
      id: 'row',
      tbl: 'children',
    });
  });

  it('logs a change of a table of no keys as of the table alone', async () => {
    const db = env.REACTIVE_D1;
    const at = await head();
    await db.prepare("INSERT INTO notes (body) VALUES ('x')").run();

    await expect(logged(at)).resolves.toStrictEqual([
      { after: null, before: null, id: '', tbl: 'notes' },
    ]);
  });
});
