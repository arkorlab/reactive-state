import { type SQL, sql } from 'drizzle-orm';
import {
  check,
  getTableConfig,
  integer,
  type SQLiteColumn,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { ddlOf } from './ddl.ts';

/**
 * The test application's tables as a Drizzle schema of SQLite's, in D1: what
 * `test/support/app/db.ts` declares as tables the authority keeps — the project fixture's projects,
 * their members and their tasks, and a counter — each field a column of its own name, of the
 * default that field had. A field's range is a CHECK and a `unique` group a unique index, which the
 * database refuses a write of, where the authority refused it before. What was public there is
 * not: public views go with kept tables. The schema is the one source: `DDL` is made of it
 * (`ddl.ts`), and each CHECK of `LIMITS`.
 *
 * A length is in the database's unit: SQLite's `length()` counts the code points of a text, up to
 * its first NUL, where the old fields counted UTF-16 units — 200 emoji are a title of 200, not of
 * 400 — and the application's own checks count as it does (`input.ts`). A bound write is also held
 * to the framework's own cap of 2,000 UTF-16 units. Text sorts by code point (`ORDER BY`), where
 * the old order was by UTF-16 unit.
 */

/** The ranges the fields were declared of: a text's longest, in code points, and a number's. */
export const LIMITS = {
  count: { max: 1_000_000, min: -1_000_000 },
  estimate: { max: 1_000_000, min: 0 },
  id: 64,
  title: 200,
} as const;

/** A number written into a CHECK's text, as a statement that makes a table binds no value. */
function literal(value: number): SQL {
  return sql.raw(String(value));
}

/** A CHECK of the text `column`, of `longest` code points at most. */
function longest(name: string, column: SQLiteColumn, most: number) {
  return check(name, sql`length(${column}) <= ${literal(most)}`);
}

/** A CHECK of the integer `column`, within `range`. */
function within(
  name: string,
  column: SQLiteColumn,
  range: { readonly max: number; readonly min: number },
) {
  return check(name, sql`${column} BETWEEN ${literal(range.min)} AND ${literal(range.max)}`);
}

export const projects = sqliteTable(
  'projects',
  {
    id: text().primaryKey(),
    ownerId: text('owner_id').notNull().default(''),
    title: text().notNull().default(''),
  },
  (columns) => {
    return [
      longest('projects_owner_id_length', columns.ownerId, LIMITS.id),
      longest('projects_title_length', columns.title, LIMITS.title),
    ];
  },
);

export const memberships = sqliteTable(
  'memberships',
  {
    id: text().primaryKey(),
    projectId: text('project_id').notNull().default(''),
    userId: text('user_id').notNull().default(''),
    canEdit: integer('can_edit', { mode: 'boolean' }).notNull().default(false),
  },
  (columns) => {
    return [
      uniqueIndex('memberships_project_user').on(columns.projectId, columns.userId),
      longest('memberships_project_id_length', columns.projectId, LIMITS.id),
      longest('memberships_user_id_length', columns.userId, LIMITS.id),
    ];
  },
);

export const todos = sqliteTable(
  'todos',
  {
    id: text().primaryKey(),
    projectId: text('project_id').notNull().default(''),
    title: text().notNull().default(''),
    completed: integer({ mode: 'boolean' }).notNull().default(false),
    estimate: integer().notNull().default(0),
  },
  (columns) => {
    return [
      longest('todos_project_id_length', columns.projectId, LIMITS.id),
      longest('todos_title_length', columns.title, LIMITS.title),
      within('todos_estimate_range', columns.estimate, LIMITS.estimate),
    ];
  },
);

export const counters = sqliteTable(
  'counters',
  {
    id: text().primaryKey(),
    ownerId: text('owner_id').notNull().default(''),
    title: text().notNull().default(''),
    count: integer().notNull().default(0),
  },
  (columns) => {
    return [
      longest('counters_owner_id_length', columns.ownerId, LIMITS.id),
      longest('counters_title_length', columns.title, LIMITS.title),
      within('counters_count_range', columns.count, LIMITS.count),
    ];
  },
);

export const schema = { counters, memberships, projects, todos };

/** The tables, in the order `DDL` makes them. */
const ORDERED = [projects, memberships, todos, counters] as const;

/** The tables' names, in the order `DDL` makes them. */
export const TABLES: readonly string[] = ORDERED.map((table) => getTableConfig(table).name);

/** The statements that make the tables and their indexes, of the schema: run them in one batch. */
export const DDL: readonly string[] = ddlOf(ORDERED);

/** The seed, as the old application's: the same rows under the same ids. */
export const SEED: readonly string[] = [
  "INSERT INTO projects (id, owner_id, title) VALUES ('p1', 'alice', '開発'), ('p2', 'alice', '運用'), ('p3', 'bob', 'Bob の作業')",
  "INSERT INTO memberships (id, project_id, user_id, can_edit) VALUES ('p1-bob', 'p1', 'bob', 1), ('p2-bob', 'p2', 'bob', 1)",
  "INSERT INTO todos (id, project_id, title, completed, estimate) VALUES ('t1', 'p1', '一覧を作る', 0, 2), ('t2', 'p1', '同期を確認する', 0, 3), ('t3', 'p2', '監視を見直す', 0, 1)",
  "INSERT INTO counters (id, owner_id, title, count) VALUES ('main', 'alice', 'Shared counter', 0), ('other', 'alice', 'Unrelated counter', 100)",
];
