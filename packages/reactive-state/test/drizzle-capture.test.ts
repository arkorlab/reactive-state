import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { followDrizzle } from '../src/sql/index.ts';
import { openedWith } from './support/drizzle.ts';

/**
 * `captureSql()`, as a host runs it each time it starts: on a database of writers, a statement that
 * takes a followed table's lock waits for every open transaction that wrote it, and holds every
 * writer behind it. Where the triggers stand as they should, it takes none.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const DDL = 'CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL)';
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

/** What `pg` holds of the table `tasks` once `follow`'s statements ran, in a transaction left open. */
async function locksOf(
  { pg }: Awaited<ReturnType<typeof openedWith>>,
  statements: readonly string[],
): Promise<readonly string[]> {
  await pg.exec('BEGIN');
  for (const statement of statements) await pg.query(statement);
  const { rows } = await pg.query<{ mode: string }>(
    "SELECT mode FROM pg_locks WHERE relation = 'tasks'::regclass AND pid = pg_backend_pid()",
  );
  await pg.exec('ROLLBACK');
  return rows.map((row) => row.mode);
}

/** What each trigger of `tasks` is, as PostgreSQL writes it. */
async function definitionsOf({ pg }: Awaited<ReturnType<typeof openedWith>>) {
  const { rows } = await pg.query<{ made: string }>(
    "SELECT pg_get_triggerdef(oid) AS made FROM pg_trigger WHERE tgrelid = 'tasks'::regclass AND NOT tgisinternal ORDER BY tgname",
  );
  return rows.map((row) => row.made);
}

/** The triggers `tasks` holds, by name. */
async function triggersOf({ pg }: Awaited<ReturnType<typeof openedWith>>) {
  const { rows } = await pg.query<{ tgname: string; tgnargs: number; tgenabled: string }>(
    "SELECT tgname, tgnargs, tgenabled FROM pg_trigger WHERE tgrelid = 'tasks'::regclass AND NOT tgisinternal ORDER BY tgname",
  );
  return rows;
}

describe('captureSql()', () => {
  it(
    'takes no lock of a table whose triggers stand as they should',
    async () => {
      const setup = await openedWith({ tasks }, DDL);

      await expect(locksOf(setup, setup.follow.captureSql())).resolves.toStrictEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'makes a trigger a migration took away, and leaves the others',
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      const before = await triggersOf(setup);
      await setup.pg.exec('DROP TRIGGER reactive_state_update ON tasks');

      for (const statement of setup.follow.captureSql()) await setup.pg.query(statement);

      await expect(triggersOf(setup)).resolves.toStrictEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'makes a trigger again of the keys the schema holds now',
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      const keyed = pgTable('tasks', {
        id: text().primaryKey(),
        title: text().notNull().unique(),
      });
      const follow = followDrizzle({ tasks: keyed });
      await setup.pg.exec('CREATE UNIQUE INDEX tasks_title ON tasks (title)');

      for (const statement of follow.captureSql()) await setup.pg.query(statement);

      const made = await triggersOf(setup);

      expect(made.find(({ tgname }) => tgname === 'reactive_state_update')?.tgnargs).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'turns on again a trigger left off, by which the log would hear nothing',
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      await setup.pg.exec('ALTER TABLE tasks DISABLE TRIGGER reactive_state_update');

      for (const statement of setup.follow.captureSql()) await setup.pg.query(statement);

      const made = await triggersOf(setup);

      expect(made.find(({ tgname }) => tgname === 'reactive_state_update')?.tgenabled).toBe('O');
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    [
      'of another event',
      'reactive_state_truncate AFTER INSERT ON tasks FOR EACH STATEMENT EXECUTE FUNCTION reactive_state.capture_all()',
    ],
    [
      'of a condition',
      'reactive_state_truncate AFTER TRUNCATE ON tasks FOR EACH STATEMENT WHEN (false) EXECUTE FUNCTION reactive_state.capture_all()',
    ],
    [
      'before the statement',
      'reactive_state_truncate BEFORE TRUNCATE ON tasks FOR EACH STATEMENT EXECUTE FUNCTION reactive_state.capture_all()',
    ],
    [
      'of each row',
      "reactive_state_insert AFTER INSERT ON tasks REFERENCING NEW TABLE AS rows_after FOR EACH ROW EXECUTE FUNCTION reactive_state.capture_inserted('id')",
    ],
    [
      'of another transition table',
      "reactive_state_insert AFTER INSERT ON tasks REFERENCING NEW TABLE AS others FOR EACH STATEMENT EXECUTE FUNCTION reactive_state.capture_inserted('id')",
    ],
    [
      'of no transition table',
      "reactive_state_insert AFTER INSERT ON tasks FOR EACH STATEMENT EXECUTE FUNCTION reactive_state.capture_inserted('id')",
    ],
  ])(
    'makes again a trigger of its name, function and keys, but %s',
    async (_what, trigger) => {
      const setup = await openedWith({ tasks }, DDL);
      const before = await definitionsOf(setup);
      await setup.pg.exec(`CREATE OR REPLACE TRIGGER ${trigger}`);

      await expect(definitionsOf(setup)).resolves.not.toStrictEqual(before);

      for (const statement of setup.follow.captureSql()) await setup.pg.query(statement);

      await expect(definitionsOf(setup)).resolves.toStrictEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'holds the lock of one table at a time, which a start waits on writers with',
    async () => {
      const notes = pgTable('notes', { id: text().primaryKey() });
      const setup = await openedWith(
        { notes, tasks },
        `${DDL}; CREATE TABLE notes (id text PRIMARY KEY)`,
      );
      await setup.pg.exec(`
        DROP TRIGGER reactive_state_update ON tasks;
        DROP TRIGGER reactive_state_update ON notes;
      `);
      const held: number[] = [];

      for (const statement of setup.follow.captureSql()) {
        await setup.pg.exec('BEGIN');
        await setup.pg.query(statement);
        const { rows } = await setup.pg.query(
          "SELECT 1 FROM pg_locks WHERE relation IN ('tasks'::regclass, 'notes'::regclass) AND pid = pg_backend_pid()",
        );
        await setup.pg.exec('COMMIT');
        held.push(rows.length);
      }

      expect(held).toStrictEqual([0, 1, 1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs each statement under a lock two hosts starting at once wait on',
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      const held: number[] = [];

      for (const statement of setup.follow.captureSql()) {
        await setup.pg.exec('BEGIN');
        await setup.pg.query(statement);
        const { rows } = await setup.pg.query(
          "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
        );
        await setup.pg.exec('ROLLBACK');
        held.push(rows.length);
      }

      expect(held).toStrictEqual([1, 1]);
    },
    TEST_TIMEOUT_MS,
  );
});
