import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Tables whose changes a log follows, and their twins of no log, of one database, and the writes
 * of each that `ownChanges` is held to: what each answers of a followed table, counted of its own,
 * is what it answers of the twin, whose count holds no log's row.
 */

/** Tasks of projects, of a key, an index and a unique code: an insert of a code met replaces one. */
export const ownTasks = sqliteTable(
  'own_tasks',
  {
    id: integer().primaryKey(),
    projectId: text('project_id').notNull(),
    title: text().notNull(),
    code: text().unique(),
  },
  (table) => [index('own_tasks_project').on(table.projectId)],
);
const ownParents = sqliteTable('own_parents', { id: text().primaryKey() });
/** Children whose parent's delete cascades to them. */
const ownChildren = sqliteTable('own_children', {
  id: integer().primaryKey(),
  parentId: text('parent_id').references(() => ownParents.id, { onDelete: 'cascade' }),
});
/** The followed tables, as an application's schema exports them. */
export const ownSchema = { ownChildren, ownParents, ownTasks };

/** The statements that make the tables of `prefix`: `own_` the followed ones, `plain_` their twins. */
export function tablesOf(prefix: 'own_' | 'plain_'): readonly string[] {
  return [
    `CREATE TABLE ${prefix}tasks (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, code TEXT UNIQUE)`,
    `CREATE INDEX ${prefix}tasks_project ON ${prefix}tasks (project_id)`,
    `CREATE TABLE ${prefix}parents (id TEXT PRIMARY KEY)`,
    `CREATE TABLE ${prefix}children (id INTEGER PRIMARY KEY, parent_id TEXT REFERENCES ${prefix}parents (id) ON DELETE CASCADE)`,
  ];
}

/** The statements that drop the tables of both prefixes, and the log. */
export const DROPPED: readonly string[] = [
  ...['own_', 'plain_'].flatMap((prefix) => {
    return ['children', 'parents', 'tasks'].map(
      (table) => `DROP TABLE IF EXISTS ${prefix}${table}`,
    );
  }),
  'DROP TABLE IF EXISTS _rs_changes',
  'DROP TABLE IF EXISTS _rs_meta',
];

/** A write of a case, of its tables named `{tasks}`, `{parents}` and `{children}`, and its values. */
export interface Write {
  readonly sql: string;
  readonly values: readonly (number | string)[];
}

/**
 * Writes of every kind a count is answered of: of one row and of several, of none, a conflict done
 * nothing of and one updated, a row ignored and one replaced, a `WITH` before an update, a delete
 * of rows and one that cascades, and a `REPLACE` of a parent of children.
 */
export const WRITES: readonly Write[] = [
  {
    sql: "INSERT INTO {tasks} (id, project_id, title, code) VALUES (1, 'p1', 'one', 'a')",
    values: [],
  },
  {
    sql: "INSERT INTO {tasks} (id, project_id, title, code) VALUES (2, 'p1', 'two', 'b'), (3, 'p2', 'three', 'c')",
    values: [],
  },
  { sql: "UPDATE {tasks} SET title = title || '!' WHERE project_id = ?", values: ['p1'] },
  { sql: "UPDATE {tasks} SET title = 'none' WHERE id = ?", values: [99] },
  {
    sql: "INSERT INTO {tasks} (id, project_id, title, code) VALUES (1, 'p1', 'again', 'z') ON CONFLICT DO NOTHING",
    values: [],
  },
  {
    sql: "INSERT INTO {tasks} (id, project_id, title, code) VALUES (4, 'p3', 'four', 'd') ON CONFLICT DO NOTHING",
    values: [],
  },
  {
    sql: "INSERT INTO {tasks} (id, project_id, title, code) VALUES (5, 'p3', 'five', 'a') ON CONFLICT (code) DO UPDATE SET title = excluded.title",
    values: [],
  },
  {
    sql: "INSERT OR IGNORE INTO {tasks} (id, project_id, title, code) VALUES (2, 'p1', 'ignored', 'y')",
    values: [],
  },
  {
    sql: "INSERT OR REPLACE INTO {tasks} (id, project_id, title, code) VALUES (6, 'p4', 'six', 'b')",
    values: [],
  },
  {
    sql: "WITH moved AS (SELECT id FROM {tasks} WHERE project_id = 'p3') UPDATE {tasks} SET project_id = 'p5' WHERE id IN (SELECT id FROM moved)",
    values: [],
  },
  { sql: 'DELETE FROM {tasks} WHERE project_id = ?', values: ['p5'] },
  { sql: "INSERT INTO {parents} (id) VALUES ('x'), ('y')", values: [] },
  { sql: "INSERT INTO {children} (id, parent_id) VALUES (1, 'x'), (2, 'x'), (3, 'y')", values: [] },
  { sql: "DELETE FROM {parents} WHERE id = 'x'", values: [] },
  { sql: "REPLACE INTO {parents} (id) VALUES ('y')", values: [] },
];

/** `sql` of the tables of `prefix`. */
export function named(sql: string, prefix: 'own_' | 'plain_'): string {
  return sql.replaceAll(
    /\{(children|parents|tasks)\}/gu,
    (_whole, table: string) => `${prefix}${table}`,
  );
}

/** The count of each answer of D1's, as its `meta` says. */
export function changesOf(answers: readonly unknown[]): readonly unknown[] {
  return answers.map((answer) => {
    const meta: unknown =
      typeof answer === 'object' && answer !== null ? Reflect.get(answer, 'meta') : undefined;
    const changes: unknown =
      typeof meta === 'object' && meta !== null ? Reflect.get(meta, 'changes') : undefined;
    return changes;
  });
}
