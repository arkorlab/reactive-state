import { and, eq, sql } from 'drizzle-orm';
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { type FieldRef, isFieldRef } from '../src/program.ts';
import { database } from '../src/server/index.ts';
import { followDrizzle } from '../src/sql/index.ts';

/** A row's columns of SQLite's, and the keys that name one row, as a schema of D1 declares them. */
const tasks = sqliteTable(
  'tasks',
  {
    id: integer().primaryKey(),
    projectId: text('project_id').notNull(),
    title: text().notNull(),
    slug: text().notNull().unique(),
    label: text().notNull(),
    rank: integer().notNull(),
    estimate: integer().notNull(),
    done: integer({ mode: 'boolean' }).notNull(),
    kind: text({ enum: ['bug', 'chore'] }).notNull(),
    note: text(),
    weight: real().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    settings: text({ mode: 'json' }).notNull(),
    shout: text()
      .notNull()
      .generatedAlwaysAs(sql`upper(title)`),
    _revision: integer('revision').notNull(),
  },
  (columns) => {
    return [
      uniqueIndex('tasks_project_label').on(columns.projectId, columns.label),
      uniqueIndex('tasks_open_rank')
        .on(columns.rank)
        .where(sql`NOT done`),
      uniqueIndex('tasks_lower_title').on(sql`lower(${columns.title})`),
      unique('tasks_kind_estimate').on(columns.kind, columns.estimate),
    ];
  },
);
const members = sqliteTable(
  'members',
  {
    projectId: text('project_id').notNull(),
    userId: text('user_id').notNull(),
    role: text().notNull(),
  },
  (columns) => [primaryKey({ columns: [columns.projectId, columns.userId] })],
);

/** The database of the schema's tables, as an application declares it. */
function declared() {
  return database(followDrizzle({ members, tasks }).tables);
}

describe('db.<table>.where, of a schema of SQLite', () => {
  it('answers a reference of each column a state may bind of the row a condition names', () => {
    const row = declared().tasks.where(eq(tasks.id, 1));

    expect(isFieldRef(row.title)).toBe(true);
    expect(row.done).toMatchObject({ field: 'done', kind: 'field', table: 'tasks' });
    expect(new Set(Object.keys(row))).toStrictEqual(
      new Set(['done', 'estimate', 'kind', 'label', 'projectId', 'rank', 'slug', 'title']),
    );

    expectTypeOf(row.title).toEqualTypeOf<FieldRef<string>>();
    expectTypeOf(row.done).toEqualTypeOf<FieldRef<boolean>>();
    expectTypeOf(row.estimate).toEqualTypeOf<FieldRef<number>>();
    expectTypeOf(row.kind).toEqualTypeOf<FieldRef<'bug' | 'chore'>>();
    expectTypeOf(row).not.toHaveProperty('note');
    expectTypeOf(row).not.toHaveProperty('weight');
    expectTypeOf(row).not.toHaveProperty('createdAt');
    expectTypeOf(row).not.toHaveProperty('settings');
    expectTypeOf(row).not.toHaveProperty('shout');
  });

  it.each([
    ['a primary key', eq(tasks.id, 1)],
    ['a unique column', eq(tasks.slug, 'first')],
    ['a unique index', and(eq(tasks.projectId, 'p1'), eq(tasks.label, 'a'))],
    ['a unique constraint', and(eq(tasks.kind, 'bug'), eq(tasks.estimate, 1))],
    ['more than a key', and(eq(tasks.id, 1), eq(tasks.projectId, 'p1'))],
  ])('takes %s', (_, condition) => {
    expect(isFieldRef(declared().tasks.where(condition).title)).toBe(true);
  });

  it('takes the columns of a composite primary key, and no fewer', () => {
    const db = declared();
    const row = db.members.where(and(eq(members.projectId, 'p1'), eq(members.userId, 'u1')));

    expect(row.role).toMatchObject({ field: 'role', table: 'members' });
    expect(() => db.members.where(eq(members.userId, 'u1'))).toThrow('no key of the table');
  });

  it.each([
    ['a column no key holds', eq(tasks.title, 'a'), 'no key of the table'],
    ['part of a key', eq(tasks.projectId, 'p1'), 'no key of the table'],
    ['a partial index', eq(tasks.rank, 1), 'no key of the table'],
    ['a column of another table', eq(members.userId, 'u1'), 'another table'],
    ['`null`', eq(tasks.id, null as never), 'no value'],
  ])('refuses %s', (_, condition, reason) => {
    const db = declared();

    expect(() => db.tasks.where(condition)).toThrow(reason);
    expect(() => db.tasks.where(condition)).toThrow('db.tasks.where:');
  });

  it.each([
    ['a column the condition names', 'id', 'names the row'],
    ['a column that may hold NULL', 'note', 'NULL'],
    ['a generated column', 'shout', 'generates'],
    ['a real', 'weight', 'SQLiteReal'],
    ['a timestamp', 'createdAt', 'SQLiteTimestamp'],
    ['a document', 'settings', 'SQLiteTextJson'],
    ['a column of no name a binding carries', '_revision', 'a letter, then letters, digits or _'],
  ])('refuses to bind %s', (_, column, reason) => {
    const row = declared().tasks.where(eq(tasks.id, 1));
    const read = (): unknown => Reflect.get(row, column);

    expect(read).toThrow(reason);
    expect(read).toThrow(`db.tasks.where(…).${column}:`);
  });

  it('names one row by one id, in whatever order its conditions are written', () => {
    const db = declared();
    const one = db.tasks.where(and(eq(tasks.id, 1), eq(tasks.projectId, 'p1')));
    const other = db.tasks.where(and(eq(tasks.projectId, 'p1'), eq(tasks.id, 1)));

    expect(one.title.id).toBe(other.title.id);
    expect(db.tasks.where(eq(tasks.id, 2)).title.id).not.toBe(one.title.id);
  });

  it('points `ref` at `where`', () => {
    expect(() => declared().tasks.ref('1')).toThrow('db.tasks.where');
  });
});
