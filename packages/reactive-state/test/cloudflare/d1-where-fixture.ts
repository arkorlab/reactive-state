import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { authorityObject } from '../../src/cloudflare/object.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../../src/program.ts';
import { forbidden } from '../../src/server/index.ts';
import { followDrizzle, followedDb } from '../../src/sql/index.ts';

/**
 * An application whose tables are its Drizzle schema's in D1, whose component binds its states to a
 * row of them: what a Durable Object reads and writes of a row through the binding. Its object is
 * given no store: the follow brings its own, of the binding its `client` was given.
 */

const rowMembers = sqliteTable('where_members', {
  userId: text('user_id').primaryKey(),
});
export const rowTasks = sqliteTable('where_tasks', {
  id: integer().primaryKey(),
  projectId: text('project_id').notNull(),
  title: text().notNull(),
  slug: text().notNull().unique(),
  estimate: integer().notNull(),
  done: integer({ mode: 'boolean' }).notNull(),
  kind: text({ enum: ['bug', 'chore'] }).notNull(),
});
/** A table of what `where_tasks` holds not: a collation, a foreign key, a trigger that refuses. */
export const rowNotes = sqliteTable('where_notes', {
  id: text().primaryKey(),
  task: integer().notNull(),
  label: text().notNull(),
  body: text().notNull(),
});
/** The table as a schema of a column the database holds not declares it. */
export const rowGhosts = sqliteTable('where_notes', {
  id: text().primaryKey(),
  ghost: text().notNull(),
});

/** A table the database spells otherwise than the schema does, as SQLite compares names. */
export const rowCased = sqliteTable('where_cased', {
  id: text().primaryKey(),
  title: text().notNull(),
  done: integer({ mode: 'boolean' }).notNull(),
});

export const rowsFollow = followDrizzle({ rowMembers, rowNotes, rowTasks });
const rowsOrm = drizzle(rowsFollow.client(env.REACTIVE_D1), {
  schema: { rowMembers, rowNotes, rowTasks },
});
export const rowsDatabase = followedDb(rowsFollow);

/** The ids of the component's updates. */
export const ROW_UPDATES = {
  add: 'u_add',
  done: 'u_done',
  kind: 'u_kind',
  slug: 'u_slug',
  title: 'u_title',
  toggle: 'u_toggle',
} as const;

export const rowsProgram: ComponentProgram = {
  buildId: 'b_d1_rows',
  component: 'components/d1-row',
  evaluate: async (_props, $) => {
    const [member] = await rowsOrm.select().from(rowMembers).where(eq(rowMembers.userId, 'alice'));
    if (member === undefined) forbidden();
    const row = rowsDatabase.rowTasks.where(and(eq(rowTasks.id, 1), eq(rowTasks.projectId, 'p1')));
    return $.client({
      props: {},
      slots: {},
      states: {
        done: row.done,
        estimate: row.estimate,
        kind: row.kind,
        slug: row.slug,
        title: row.title,
      },
    });
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {
    [ROW_UPDATES.add]: {
      apply: (current: number, { step }: { readonly step: number }): number => current + step,
      keys: ['estimate'],
      kind: 'apply',
    },
    [ROW_UPDATES.done]: { keys: ['done'], kind: 'set' },
    [ROW_UPDATES.kind]: { keys: ['kind'], kind: 'set' },
    [ROW_UPDATES.slug]: { keys: ['slug'], kind: 'set' },
    [ROW_UPDATES.title]: { keys: ['title'], kind: 'set' },
    [ROW_UPDATES.toggle]: {
      apply: (current: boolean): boolean => !current,
      keys: ['done'],
      kind: 'apply',
    },
  },
  writable: ['done', 'estimate', 'kind', 'slug', 'title'],
};

export const RowsAuthority = authorityObject({
  buildId: rowsProgram.buildId,
  database: rowsDatabase,
  programs: [rowsProgram],
  sessions: 'asserted',
});
