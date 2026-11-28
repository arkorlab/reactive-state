import { and, eq, gt, not, or, SQL, sql, StringChunk } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { type FieldRef, isFieldRef } from '../src/program.ts';
import { database, table, text as textField } from '../src/server/index.ts';
import { isRecordId } from '../src/server/schema.ts';
import { followDrizzle, followedDb } from '../src/sql/index.ts';

/** A row's columns, and the keys that name one row: each of the ways a schema declares one. */
const states = pgEnum('state', ['open', 'closed']);
const tasks = pgTable(
  'tasks',
  {
    id: uuid().primaryKey(),
    projectId: text('project_id').notNull(),
    title: text().notNull(),
    slug: text().notNull().unique(),
    label: varchar({ length: 12 }).notNull(),
    rank: smallint().notNull(),
    estimate: integer().notNull(),
    done: boolean().notNull(),
    state: states().notNull(),
    kind: text({ enum: ['bug', 'chore'] }).notNull(),
    owner: uuid().notNull(),
    note: text(),
    updatedAt: timestamp('updated_at').notNull(),
    shout: text()
      .notNull()
      .generatedAlwaysAs(sql`upper(title)`),
    sequence: integer().notNull().generatedAlwaysAsIdentity(),
    _revision: integer('revision').notNull(),
  },
  (columns) => {
    return [
      uniqueIndex('tasks_project_label').on(columns.projectId, columns.label),
      uniqueIndex('tasks_open_estimate')
        .on(columns.estimate)
        .where(sql`NOT done`),
      uniqueIndex('tasks_lower_title').on(sql`lower(${columns.title})`),
      unique('tasks_owner_rank').on(columns.owner, columns.rank),
    ];
  },
);
const members = pgTable(
  'members',
  {
    projectId: text('project_id').notNull(),
    userId: text('user_id').notNull(),
    role: text().notNull(),
  },
  (columns) => [primaryKey({ columns: [columns.projectId, columns.userId] })],
);
const projects = pgTable('projects', { id: text().primaryKey(), title: text().notNull() });
const schema = { members, projects, tasks };
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** Conditions that name one row. */
const TAKEN = [
  ['a primary key', eq(tasks.id, ID)],
  ['a unique column', eq(tasks.slug, 'first')],
  ['a unique index', and(eq(tasks.projectId, 'p1'), eq(tasks.label, 'a'))],
  ['a unique constraint', and(eq(tasks.owner, ID), eq(tasks.rank, 1))],
  ['more than a key', and(eq(tasks.id, ID), eq(tasks.projectId, 'p1'))],
  ['`and` of one condition', and(eq(tasks.id, ID))],
  ['`and` under `and`', and(eq(tasks.id, ID), and(eq(tasks.projectId, 'p1')))],
  ['`and` with a condition left out', and(undefined, eq(tasks.id, ID))],
] as const;

/** `or`, then a chunk of nothing, then an `eq`, joined as `and` joins its conditions. */
const LEFT_OUT = sql.join(
  [or(eq(tasks.id, ID), eq(tasks.id, OTHER)), undefined as never, eq(tasks.id, ID)],
  new StringChunk(' and '),
);

/** Conditions that name no one row whatever the database holds, and what the fault says. */
const REFUSED = [
  ['no condition', undefined, 'a row is named'],
  ['`or`', or(eq(tasks.id, ID), eq(tasks.id, OTHER)), 'a row is named'],
  ['`not`', not(eq(tasks.id, ID)), 'a row is named'],
  ['`gt`', gt(tasks.estimate, 1), 'a row is named'],
  ['raw SQL', sql`${tasks.id} = ${ID}`, 'a row is named'],
  ['an expression', eq(sql`lower(${tasks.title})`, 'a'), 'a row is named'],
  ['a column of the other side', eq(tasks.id, tasks.owner), 'a row is named'],
  ['SQL on the other side', eq(tasks.title, sql`'a'`), 'a row is named'],
  [
    '`or` under `and`',
    and(eq(tasks.id, ID), or(eq(tasks.done, true), eq(tasks.done, false))),
    'a row is named',
  ],
  [
    'a chunk of nothing before `or`, as a hand may write one',
    new SQL([new StringChunk('('), LEFT_OUT, new StringChunk(')')]),
    'a row is named',
  ],
  ['a column of another table', eq(projects.id, ID), 'another table'],
  ['a value of nothing', eq(tasks.id, undefined as never), 'no value'],
  ['`null`', eq(tasks.id, null as never), 'no value'],
  ['a column named twice', and(eq(tasks.id, ID), eq(tasks.id, OTHER)), 'twice'],
  ['a column no key holds', eq(tasks.title, 'a'), 'no key of the table'],
  ['part of a key', eq(tasks.projectId, 'p1'), 'no key of the table'],
  ['a partial index', eq(tasks.estimate, 1), 'no key of the table'],
] as const;

/** The database of the schema's tables, as an application declares it. */
function declared() {
  return followedDb(followDrizzle(schema));
}

/** `where` of a table whose type holds none, as a caller in JavaScript may call it. */
function whereOf(handle: unknown, condition: unknown): unknown {
  const where = Reflect.get(handle as Record<string, unknown>, 'where') as (
    given: unknown,
  ) => unknown;
  return where(condition);
}

/** `ref` of a table whose type holds none, as a caller in JavaScript may call it. */
function refOf(handle: unknown, id: string): unknown {
  const ref = Reflect.get(handle as Record<string, unknown>, 'ref') as (given: string) => unknown;
  return ref(id);
}

describe('db.<table>.where', () => {
  it('answers a reference of each column a state may bind of the row a condition names', () => {
    const row = declared().tasks.where(eq(tasks.id, ID));

    expect(isFieldRef(row.title)).toBe(true);
    expect(row.title).toMatchObject({ field: 'title', kind: 'field', table: 'tasks' });
    expect(isRecordId(row.title.id)).toBe(true);
    expect(new Set(Object.keys(row))).toStrictEqual(
      new Set([
        'done',
        'estimate',
        'kind',
        'label',
        'owner',
        'projectId',
        'rank',
        'slug',
        'state',
        'title',
      ]),
    );

    expectTypeOf(row.title).toEqualTypeOf<FieldRef<string>>();
    expectTypeOf(row.done).toEqualTypeOf<FieldRef<boolean>>();
    expectTypeOf(row.estimate).toEqualTypeOf<FieldRef<number>>();
    expectTypeOf(row.state).toEqualTypeOf<FieldRef<'closed' | 'open'>>();
    expectTypeOf(row.kind).toEqualTypeOf<FieldRef<'bug' | 'chore'>>();
    expectTypeOf(row).not.toHaveProperty('note');
    expectTypeOf(row).not.toHaveProperty('updatedAt');
    expectTypeOf(row).not.toHaveProperty('shout');
    expectTypeOf(row).not.toHaveProperty('sequence');
  });

  it.each(TAKEN)('takes %s', (_, condition) => {
    expect(isFieldRef(declared().tasks.where(condition).done)).toBe(true);
  });

  it('takes the columns of a composite primary key, and no fewer', () => {
    const db = declared();
    const row = db.members.where(and(eq(members.projectId, 'p1'), eq(members.userId, 'u1')));

    expect(row.role).toMatchObject({ field: 'role', table: 'members' });
    expect(() => db.members.where(eq(members.userId, 'u1'))).toThrow('no key of the table');
  });

  it('names one row by one id, in whatever order its conditions are written', () => {
    const db = declared();
    const one = db.tasks.where(and(eq(tasks.id, ID), eq(tasks.projectId, 'p1')));
    const other = db.tasks.where(and(eq(tasks.projectId, 'p1'), eq(tasks.id, ID)));

    expect(one.title.id).toBe(other.title.id);
  });

  it('names rows of other conditions, or of another table, by other ids', () => {
    const db = declared();
    const { id } = db.tasks.where(eq(tasks.id, ID)).title;
    const narrower = and(eq(tasks.id, ID), eq(tasks.projectId, 'p1'));

    expect(db.tasks.where(eq(tasks.id, OTHER)).title.id).not.toBe(id);
    expect(db.tasks.where(narrower).title.id).not.toBe(id);
    expect(db.projects.where(eq(projects.id, ID)).title.id).not.toBe(id);
  });

  it.each(REFUSED)('refuses %s', (_, condition, reason) => {
    const db = declared();

    expect(() => db.tasks.where(condition)).toThrow(reason);
    expect(() => db.tasks.where(condition)).toThrow('db.tasks.where:');
  });

  it.each([
    ['a column the condition names', 'id', 'names the row'],
    ['another column the condition names', 'projectId', 'names the row'],
    ['a column that may hold NULL', 'note', 'NULL'],
    ['a generated column', 'shout', 'the database generates'],
    ['an identity column', 'sequence', 'the database generates'],
    ['a column of another type', 'updatedAt', 'PgTimestamp'],
    ['a column of no name a binding carries', '_revision', 'a letter, then letters, digits or _'],
  ])('refuses to bind %s', (_, column, reason) => {
    const row = declared().tasks.where(and(eq(tasks.id, ID), eq(tasks.projectId, 'p1')));
    const read = (): unknown => Reflect.get(row, column);

    expect(read).toThrow(reason);
    expect(read).toThrow(`db.tasks.where(…).${column}:`);
  });

  it('answers nothing of a name no column has', () => {
    const row = declared().tasks.where(eq(tasks.id, ID));

    expect(Reflect.get(row, 'missing')).toBeUndefined();
  });

  it('refuses a table the authority keeps, and tells why', () => {
    const db = database({ notes: table({ title: textField() }) });

    expect(() => whereOf(db.notes, eq(tasks.id, ID))).toThrow(
      'db.notes.where: a condition names a row of a table of a Drizzle schema',
    );
  });

  it('points `ref` of a followed table at `where`', () => {
    expect(() => refOf(declared().tasks, ID)).toThrow('db.tasks.where');
  });
});
