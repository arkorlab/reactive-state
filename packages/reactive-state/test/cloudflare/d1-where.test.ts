import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { rowChange } from '../../src/authority/row-writes.ts';
import type { AuthorityObject } from '../../src/cloudflare/object.ts';
import type { BoundRow, FieldRef } from '../../src/program.ts';
import { database } from '../../src/server/index.ts';
import { followDrizzle } from '../../src/sql/index.ts';
import { clientOf } from '../support/frames.ts';
import { rendered } from './d1-drizzle-render.ts';
import {
  ROW_UPDATES,
  rowCased,
  rowGhosts,
  rowNotes,
  rowsDatabase,
  rowsFollow,
  rowsProgram,
  rowTasks,
} from './d1-where-fixture.ts';
import { type AuthorityStub, valueOf } from './helpers.ts';

/**
 * A state bound to a row of a table in D1, run in workerd: its read and its write, by what D1
 * itself answers, and a write through a Durable Object.
 */

const db = env.REACTIVE_D1;
const ROOT = { build: rowsProgram.buildId, component: rowsProgram.component, props: {} };
const LIFETIME_MS = 60_000;

/** The row a reference is of. */
function rowOf(reference: FieldRef): BoundRow {
  if (reference.row === undefined) throw new Error('The reference names a record.');
  return reference.row;
}

/** A column of `id` of the table, read by the test alone. */
async function held(column: string, id = 1): Promise<unknown> {
  return db.prepare(`SELECT "${column}" AS v FROM where_tasks WHERE id = ?`).bind(id).first('v');
}

/** The tables, their log and their rows, made anew. */
async function prepare(): Promise<void> {
  const tables = ['where_cased', 'where_notes', 'where_tasks', 'where_members'];
  for (const name of [...tables, '_rs_changes', '_rs_meta']) {
    await db.exec(`DROP TABLE IF EXISTS ${name}`);
  }
  await db.batch(
    [
      'CREATE TABLE where_members (user_id TEXT PRIMARY KEY NOT NULL)',
      `CREATE TABLE where_tasks (
        id INTEGER PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL CHECK (title <> 'refused'),
        slug TEXT NOT NULL UNIQUE,
        estimate INTEGER NOT NULL,
        done INTEGER NOT NULL,
        kind TEXT NOT NULL
      )`,
      `CREATE TABLE where_notes (
        id TEXT PRIMARY KEY NOT NULL,
        task INTEGER NOT NULL REFERENCES where_tasks (id),
        label TEXT COLLATE NOCASE NOT NULL,
        body TEXT NOT NULL
      )`,
      `CREATE TRIGGER where_notes_raised BEFORE UPDATE ON where_notes WHEN NEW.body = 'raised'
        BEGIN SELECT RAISE(ABORT, 'No such body'); END`,
      'CREATE TABLE where_cased (ID TEXT PRIMARY KEY NOT NULL, Title TEXT NOT NULL, DONE INTEGER NOT NULL)',
      ...rowsFollow.captureSql(),
      "INSERT INTO where_members VALUES ('alice')",
      "INSERT INTO where_tasks VALUES (1, 'p1', 'Write docs', 'first', 3, 0, 'bug')",
      "INSERT INTO where_tasks VALUES (2, 'p1', 'Ship it', 'second', 5, 1, 'chore')",
      "INSERT INTO where_notes VALUES ('n1', 1, 'a', 'Kept')",
      "INSERT INTO where_cased VALUES ('c1', 'Held', 1)",
    ].map((statement) => db.prepare(statement)),
  );
}

/** The first task, as a component names it by its project too. */
function firstTask() {
  return rowsDatabase.rowTasks.where(and(eq(rowTasks.id, 1), eq(rowTasks.projectId, 'p1')));
}

/** The note, as a component names it. */
function firstNote() {
  return rowsDatabase.rowNotes.where(eq(rowNotes.id, 'n1'));
}

describe('a row of a table in D1', () => {
  beforeEach(prepare);

  it('reads what the row holds, a boolean as a boolean', async () => {
    const row = rowOf(firstTask().title);

    await expect(row.read(['done', 'estimate', 'kind', 'title'])).resolves.toStrictEqual({
      done: false,
      estimate: 3,
      kind: 'bug',
      title: 'Write docs',
    });
  });

  it('reads no row of a condition of none', async () => {
    const { title } = rowsDatabase.rowTasks.where(
      and(eq(rowTasks.id, 1), eq(rowTasks.projectId, 'p2')),
    );

    await expect(rowOf(title).read(['title'])).resolves.toBeUndefined();
  });

  it('writes a value of each type, a boolean as what the column holds', async () => {
    const row = rowOf(firstTask().title);

    await expect(row.write('title', 'Rewritten')).resolves.toBe('written');
    await expect(row.write('done', true)).resolves.toBe('written');
    await expect(row.write('estimate', 8)).resolves.toBe('written');
    await expect(row.write('kind', 'chore')).resolves.toBe('written');

    await expect(held('done')).resolves.toBe(1);
    await expect(row.read(['done', 'estimate', 'kind', 'title'])).resolves.toStrictEqual({
      done: true,
      estimate: 8,
      kind: 'chore',
      title: 'Rewritten',
    });
  });

  it('writes no row of a condition of none, and none of another', async () => {
    const { title } = rowsDatabase.rowTasks.where(
      and(eq(rowTasks.id, 1), eq(rowTasks.projectId, 'p2')),
    );

    await expect(rowOf(title).write('title', 'Moved')).resolves.toBe('absent');
    await expect(held('title')).resolves.toBe('Write docs');
    await expect(held('title', 2)).resolves.toBe('Ship it');
  });

  it('writes only where the row holds what it was to hold', async () => {
    const row = rowOf(firstTask().title);

    await expect(row.write('estimate', 4, 9)).resolves.toBe('absent');
    await expect(row.write('estimate', 4, 3)).resolves.toBe('written');
    await expect(row.write('done', true, true)).resolves.toBe('absent');
    await expect(row.write('done', true, false)).resolves.toBe('written');
  });

  it('tells text apart that the column’s collation finds equal', async () => {
    const row = rowOf(firstNote().label);

    await expect(row.write('label', 'A!', 'A')).resolves.toBe('absent');
    await expect(row.write('label', 'a!', 'a')).resolves.toBe('written');
  });

  it.each([
    ['a value a unique key holds elsewhere', () => firstTask().slug, 'second', 'taken'],
    ['a value of a check', () => firstTask().title, 'refused', 'invalid'],
    ['a value of a foreign key', () => firstNote().task, 9, 'invalid'],
    ['what a trigger raises', () => firstNote().body, 'raised', 'invalid'],
  ] as const)('answers what D1 refuses of %s', async (_, referenced, value, outcome) => {
    const reference = referenced();

    await expect(rowOf(reference).write(reference.field, value)).resolves.toBe(outcome);
  });

  it('leaves a column the database holds not a fault, of a read as of a write', async () => {
    const follow = followDrizzle({ rowGhosts });
    follow.client(db);
    const { ghost } = database(follow.tables).rowGhosts.where(eq(rowGhosts.id, 'n1'));

    await expect(rowOf(ghost).read(['ghost'])).rejects.toThrow('no such column');
    await expect(rowOf(ghost).write('ghost', 'Boo')).rejects.toThrow('no such column');
  });

  it('reads and writes a column the database spells in another case', async () => {
    const follow = followDrizzle({ rowCased });
    follow.client(db);
    const row = rowOf(database(follow.tables).rowCased.where(eq(rowCased.id, 'c1')).title);

    await expect(row.read(['title', 'done'])).resolves.toStrictEqual({
      done: true,
      title: 'Held',
    });
    await expect(row.write('title', 'Rewritten', 'Held')).resolves.toBe('written');
    await expect(row.read(['title'])).resolves.toStrictEqual({ title: 'Rewritten' });
  });

  it('reads no value of what no state holds, as a column of SQLite may keep', async () => {
    await db.prepare("UPDATE where_notes SET body = x'6162' WHERE id = 'n1'").run();
    const row = rowOf(firstNote().body);

    await expect(row.read(['body', 'label'])).resolves.toStrictEqual({ label: 'a' });
  });

  it.each([
    ['its keys', () => firstTask().title],
    ['a unique column', () => rowsDatabase.rowTasks.where(eq(rowTasks.slug, 'first')).title],
    [
      'a boolean beside its key',
      () => rowsDatabase.rowTasks.where(and(eq(rowTasks.id, 1), eq(rowTasks.done, false))).title,
    ],
  ])('names in its change what a render read of it by %s', async (_, reference) => {
    const row = rowOf(reference());

    const dependencies = await rendered(async () => row.read(['title']));

    expect(dependencies.changedBy([rowChange('rowTasks', row)])).toBe(true);
  });

  it('follows no other row', async () => {
    const dependencies = await rendered(async () => rowOf(firstTask().title).read(['title']));
    const other = rowOf(rowsDatabase.rowTasks.where(eq(rowTasks.id, 2)).title);

    expect(dependencies.changedBy([rowChange('rowTasks', other)])).toBe(false);
  });
});

/** An authority of the application, and what a page does through it. */
function authority() {
  const stub = env.D1_ROWS_AUTHORITY.getByName(crypto.randomUUID()) as unknown as AuthorityStub &
    Pick<AuthorityObject, 'poke'>;
  onTestFinished(async () => {
    await runInDurableObject(stub, async (_object, state) => {
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
  });
  const session = { expires: Date.now() + LIFETIME_MS, id: 'd1-rows', user: 'alice' };
  const render = async () => valueOf(await stub.render(session, ROOT));
  const stateOf = async (key: string) => {
    const state = clientOf((await render()).tree, rowsProgram.component).part.states[key];
    if (state === undefined || !('field' in state)) throw new Error(`${key} binds no field.`);
    return state;
  };
  return {
    render,
    stateOf,
    write: async (key: string, updaterId: string, sent: Readonly<Record<string, unknown>>) => {
      const { binding = '' } = await stateOf(key);
      return stub.update(session, {
        binding,
        operationId: crypto.randomUUID(),
        updaterId,
        ...sent,
      });
    },
    stub,
  };
}

describe('a state bound to a row in D1, through a Durable Object', () => {
  beforeEach(prepare);

  it('shows the row, writes it, and shows it at the receipt’s revision', async () => {
    const { render, stateOf, write } = authority();
    const { field } = await stateOf('title');

    expect((await render()).frame.fields[field]).toBe('Write docs');

    const receipt = valueOf(await write('title', ROW_UPDATES.title, { value: 'Rewritten' }));
    const { frame } = await render();

    expect(frame.revision).toBeGreaterThanOrEqual(receipt.committedRevision);
    expect(frame.fields[field]).toBe('Rewritten');
    await expect(held('title')).resolves.toBe('Rewritten');
  });

  it('computes an `apply` from what the row holds, a boolean too', async () => {
    const { write } = authority();
    await db.prepare('UPDATE where_tasks SET estimate = 10 WHERE id = 1').run();

    valueOf(await write('estimate', ROW_UPDATES.add, { captures: { step: 2 } }));
    valueOf(await write('done', ROW_UPDATES.toggle, {}));

    await expect(held('estimate')).resolves.toBe(12);
    await expect(held('done')).resolves.toBe(1);
  });

  it('refuses what the component refuses now, though no log told of it', async () => {
    const { stateOf, stub } = authority();
    const { binding = '' } = await stateOf('title');
    await db.prepare("DELETE FROM where_members WHERE user_id = 'alice'").run();
    const session = { expires: Date.now() + LIFETIME_MS, id: 'd1-rows', user: 'alice' };

    const answer = await stub.update(session, {
      binding,
      operationId: 'op-revoked',
      updaterId: ROW_UPDATES.title,
      value: 'Not mine',
    });

    expect(answer).toMatchObject({ ok: false, status: 403 });
    await expect(held('title')).resolves.toBe('Write docs');
  });

  it('answers each refusal as PostgreSQL’s', async () => {
    const { write } = authority();

    await expect(write('slug', ROW_UPDATES.slug, { value: 'second' })).resolves.toMatchObject({
      code: 'UNIQUE_VIOLATION',
      status: 409,
    });
    await expect(write('title', ROW_UPDATES.title, { value: 'refused' })).resolves.toMatchObject({
      code: 'INVALID_VALUE',
      status: 422,
    });
    await expect(write('kind', ROW_UPDATES.kind, { value: 'feature' })).resolves.toMatchObject({
      code: 'INVALID_VALUE',
      status: 422,
    });
    await expect(held('kind')).resolves.toBe('bug');

    await db.batch([
      db.prepare('DELETE FROM where_notes'),
      db.prepare('DELETE FROM where_tasks WHERE id = 1'),
    ]);

    await expect(write('title', ROW_UPDATES.title, { value: 'Gone' })).resolves.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('reads the log after the write, as an operation does', async () => {
    const { stub, write } = authority();
    valueOf(await write('title', ROW_UPDATES.title, { value: 'Rewritten' }));

    await expect(runDurableObjectAlarm(stub)).resolves.toBeDefined();
  });
});
