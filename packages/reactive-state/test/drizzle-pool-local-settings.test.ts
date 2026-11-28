import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool } from 'pg';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { scopedAfter } from '../src/sql/guards.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { engineOf } from './support/drizzle.ts';

/**
 * What a render reads through a checked-out connection of a `pg` pool whose open transaction sets a
 * setting for itself (`SET LOCAL`, `set_config(…, true)`) outside a render. The plans a pool keeps
 * are asked of one text and shared by every connection, so a plan asked under that setting would
 * be read by renders of the others, and one kept from the others would be read under it: a render
 * queries through no such connection while its transaction is open, and does once it ended.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const schema = { tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);
  INSERT INTO tasks VALUES ('a', 'one'), ('b', 'two');
  CREATE SCHEMA other;
  CREATE TABLE other.tasks (id text PRIMARY KEY, title text NOT NULL);
  INSERT INTO other.tasks VALUES ('z', 'elsewhere');
`;
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;
/** What a render's refusal says of a connection whose settings were changed. */
const REFUSED = /settings were changed/u;

/** A PGlite of the tasks, its log made, served to a pool of its own and to the store's client. */
async function pooled() {
  const db = await PGlite.create();
  await db.exec(DDL);
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', maxConnections: 6, port: 0 });
  await server.start();
  const port = Number(server.getServerConn().split(':').at(-1));
  const config = { database: 'postgres', host: '127.0.0.1', port, ssl: false, user: 'postgres' };
  const pool = new Pool({ ...config, max: 3 });
  const store = new Client(config);
  await store.connect();
  const follow = followDrizzle(schema);
  for (const statement of follow.captureSql()) await store.query(statement);
  const tracked = follow.client(pool);
  onTestFinished(async () => {
    await pool.end();
    await store.end();
    await server.stop();
    await db.close();
  });
  return { follow, pg: store, pool, tracked };
}

/**
 * An engine whose render reads the ids of the tasks through `connection`: made before a transaction
 * opens, as PGlite's one session holds the log's reads back until it ends. Each engine renders
 * once, as it keeps the page it made.
 */
async function rendering(
  setup: Awaited<ReturnType<typeof pooled>>,
  connection: Pick<Pool, 'query'>,
) {
  const { render } = await engineOf(setup, async (_props, $) => {
    const { rows } = await connection.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
    return $.h('p', null, rows.map((row) => row.id).join(','));
  });
  return render;
}

/** A connection of the pool the application holds, given back as the test ends. */
async function held(setup: Awaited<ReturnType<typeof pooled>>) {
  const connection = await setup.tracked.connect();
  onTestFinished(() => {
    connection.release();
  });
  return connection;
}

describe('a render through a connection whose transaction set a setting for itself', () => {
  it.each([
    [['BEGIN', 'SET LOCAL search_path = other']],
    [['BEGIN', "SELECT set_config('search_path', 'other', true)"]],
    [['BEGIN; SET LOCAL search_path = other']],
    [['BEGIN', 'SELECT 1', 'SET LOCAL search_path = other', 'SELECT 1']],
  ])(
    'is refused while the transaction is open, after %j, though a plan of the text was kept',
    async (statements) => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofPool = await rendering(setup, setup.tracked);
      const ofHeld = await rendering(setup, connection);

      // A render of the pool keeps the plan of the text, asked of the default search path.
      await expect(ofPool()).resolves.toContain('a,b');

      for (const statement of statements) await connection.query(statement);

      await expect(ofHeld()).rejects.toThrow(REFUSED);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([['COMMIT'], ['ROLLBACK']])(
    'is read again once the transaction ended with `%s`, as the setting ended with it',
    async (ending) => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);
      await connection.query('BEGIN');
      await connection.query('SET LOCAL search_path = other');
      await connection.query(ending);

      await expect(ofHeld()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is read where `SET LOCAL` came in no transaction, which it changes nothing in',
    async () => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);
      await connection.query('SET LOCAL statement_timeout = 5000');

      await expect(ofHeld()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is read through a transaction that set nothing',
    async () => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);
      await connection.query('BEGIN');
      await connection.query('SELECT 1');

      await expect(ofHeld()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a render through a connection whose transaction that set a setting ended', () => {
  it.each([
    [['COMMIT', 'BEGIN']],
    [['ROLLBACK', 'BEGIN']],
    [['COMMIT;', 'BEGIN']],
    [['END', 'BEGIN']],
    [['ABORT', 'BEGIN']],
    [['COMMIT WORK', 'BEGIN']],
    [['SET LOCAL search_path = other; COMMIT', 'BEGIN']],
    [['SELECT 1; ROLLBACK', 'BEGIN']],
    [['COMMIT AND CHAIN']],
    [['COMMIT', 'BEGIN', 'SELECT 1']],
  ])(
    'is read through the next one, which set nothing, after %j',
    async (after) => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);
      await connection.query('BEGIN');
      await connection.query('SET LOCAL search_path = other');
      for (const statement of after) await connection.query(statement);

      await expect(ofHeld()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is refused again where the next transaction sets one of its own',
    async () => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);
      for (const statement of [
        'BEGIN',
        'SET LOCAL statement_timeout = 5000',
        'COMMIT',
        'BEGIN',
        'SET LOCAL search_path = other',
      ]) {
        await connection.query(statement);
      }

      await expect(ofHeld()).rejects.toThrow(REFUSED);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    [['SAVEPOINT s', 'ROLLBACK TO SAVEPOINT s']],
    [['SAVEPOINT s', 'RELEASE SAVEPOINT s']],
    [['SET TRANSACTION READ ONLY']],
  ])(
    'is refused still, after %j, which end no transaction',
    async (after) => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);
      await connection.query('BEGIN');
      await connection.query('SET LOCAL search_path = other');
      for (const statement of after) await connection.query(statement);

      await expect(ofHeld()).rejects.toThrow(REFUSED);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is read through the next to take the connection, where it was given back in its transaction',
    async () => {
      const setup = await pooled();
      const first = await setup.tracked.connect();
      await first.query('BEGIN');
      await first.query('SET LOCAL search_path = other');
      first.release();
      const next = await setup.tracked.connect();
      onTestFinished(() => {
        next.release();
      });
      const ofNext = await rendering(setup, next);

      await expect(ofNext()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a render through a connection whose transaction may still hold what was set', () => {
  it.each([['SELECT 1 / 0; COMMIT'], ['SELECT 1 / 0; ROLLBACK'], ['SELECT 1 / 0; END']])(
    'is refused after `%s` failed before it ended the transaction, as a savepoint brings it back',
    async (ending) => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofPool = await rendering(setup, setup.tracked);
      const ofHeld = await rendering(setup, connection);

      await expect(ofPool()).resolves.toContain('a,b');

      for (const statement of ['BEGIN', 'SET LOCAL search_path = other', 'SAVEPOINT sp']) {
        await connection.query(statement);
      }

      await expect(connection.query(ending)).rejects.toThrow(/division by zero/u);

      await connection.query('ROLLBACK TO SAVEPOINT sp');

      await expect(ofHeld()).rejects.toThrow(REFUSED);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is read after a `COMMIT` that ended it, through the answer and not the text alone',
    async () => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);
      await connection.query('BEGIN');
      await connection.query('SET LOCAL search_path = other');
      await connection.query('SELECT 1; COMMIT AND CHAIN');

      await expect(ofHeld()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is read in the next transaction after a `SET LOCAL` that outside one set nothing',
    async () => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);
      await connection.query('SET LOCAL statement_timeout = 5000');
      await connection.query('BEGIN');

      await expect(ofHeld()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is refused where a setting is made while its plan is asked, which its reads were not noted of',
    async () => {
      const setup = await pooled();
      const real = await setup.pool.connect();
      real.release();
      const connection = await held(setup);
      const ofPool = await rendering(setup, setup.tracked);
      const ofHeld = await rendering(setup, connection);
      await connection.query('BEGIN');
      // The host's own code sets it as the plan's last statement is answered, outside the render.
      const asked = Promise.withResolvers<undefined>();
      const setting = (async () => {
        await asked.promise;
        return connection.query('SET LOCAL search_path = other');
      })();
      const target = real as unknown as { query: (...args: unknown[]) => Promise<unknown> };
      const query = target.query.bind(real);
      vi.spyOn(target, 'query').mockImplementation(async (...args: unknown[]) => {
        const answered = await query(...args);
        if (String(args[0]).includes('EXPLAIN') && args.every((each) => typeof each !== 'object')) {
          asked.resolve(undefined);
          await setting;
        }
        return answered;
      });

      await expect(ofHeld()).rejects.toThrow(REFUSED);
      expect(ofPool).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a render through a connection whose `DO` block set one for its transaction', () => {
  it.each([
    [['BEGIN', 'DO $$ BEGIN SET LOCAL search_path = other; END $$']],
    [['BEGIN', "DO $$ BEGIN PERFORM set_config('search_path', 'other', true); END $$"]],
    [['BEGIN', "DO 'BEGIN SET LOCAL search_path = other; END'"]],
    [['BEGIN', "DO $$ BEGIN EXECUTE 'SET LOCAL search_path = other'; END $$"]],
  ])(
    'is refused while the transaction is open, after %j',
    async (statements) => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofPool = await rendering(setup, setup.tracked);
      const ofHeld = await rendering(setup, connection);

      await expect(ofPool()).resolves.toContain('a,b');

      for (const statement of statements) await connection.query(statement);

      await expect(ofHeld()).rejects.toThrow(REFUSED);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    [['BEGIN', 'DO $$ BEGIN PERFORM 1; END $$']],
    [['BEGIN', 'DO $$ BEGIN CREATE TEMP TABLE staged (id int) ON COMMIT DROP; END $$']],
    [['BEGIN', "DO $$ BEGIN UPDATE tasks SET title = 'x' WHERE id = 'b'; END $$"]],
  ])(
    'is read after a block that sets none, %j',
    async (statements) => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);

      for (const statement of statements) await connection.query(statement);

      await expect(ofHeld()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is read after the transaction its block set one in ended',
    async () => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);
      await connection.query('BEGIN');
      await connection.query('DO $$ BEGIN SET LOCAL search_path = other; END $$');
      await connection.query('COMMIT');

      await expect(ofHeld()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a render through a connection whose statements were queued without awaiting each', () => {
  it(
    'is refused after the transaction and its `SET LOCAL` were queued, as when each is awaited',
    async () => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofPool = await rendering(setup, setup.tracked);
      const ofHeld = await rendering(setup, connection);

      await expect(ofPool()).resolves.toContain('a,b');

      await Promise.all([
        connection.query('BEGIN'),
        connection.query('SET LOCAL search_path = other'),
        connection.query('SELECT 1'),
      ]);

      await expect(ofHeld()).rejects.toThrow(REFUSED);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is read after a queued transaction that set nothing, once its statements were answered',
    async () => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);

      await Promise.all([
        connection.query('SET LOCAL statement_timeout = 5000'),
        connection.query('BEGIN'),
        connection.query('SELECT 1'),
        connection.query('COMMIT'),
      ]);

      await expect(ofHeld()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is read after a queued `COMMIT` of a transaction that set one, once it was answered',
    async () => {
      const setup = await pooled();
      const connection = await held(setup);
      const ofHeld = await rendering(setup, connection);

      await Promise.all([
        connection.query('BEGIN'),
        connection.query('SET LOCAL search_path = other'),
        connection.query('COMMIT'),
      ]);

      await expect(ofHeld()).resolves.toContain('a,b');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the transaction-local settings a text leaves', () => {
  it.each([
    ['SET LOCAL search_path = other', false, true],
    ["SELECT set_config('search_path', 'other', true)", false, true],
    ['SELECT 1', true, true],
    ['SELECT 1', false, false],
    ['COMMIT', true, false],
    ['commit;', true, false],
    ['END', true, false],
    ['ABORT', true, false],
    ['ROLLBACK', true, false],
    ['COMMIT AND CHAIN', true, false],
    ['COMMIT WORK', true, false],
    ['SET LOCAL a = 1; COMMIT', false, false],
    ['COMMIT; BEGIN; SET LOCAL a = 1', true, true],
    ['SET LOCAL a = 1; SELECT 1', false, true],
    ['ROLLBACK TO SAVEPOINT s', true, true],
    ['ROLLBACK TO s', true, true],
    ['ROLLBACK WORK TO SAVEPOINT s', true, true],
    ['ROLLBACK AND CHAIN', true, false],
    ["COMMIT PREPARED 'x'", true, true],
    ["ROLLBACK PREPARED 'x'", true, true],
    ["SELECT 'COMMIT; END'", true, true],
    ['SELECT CASE WHEN true THEN 1 END', true, true],
    ['DO $$ BEGIN PERFORM 1; END $$', true, true],
    ['BEGIN', true, true],
    ['DO $$ BEGIN SET LOCAL a = 1; END $$', false, true],
    ["DO $$ BEGIN PERFORM set_config('a', 'b', true); END $$", false, true],
    ["DO 'BEGIN SET LOCAL a = 1; END'", false, true],
    ["DO $$ BEGIN EXECUTE 'SET LOCAL a = 1'; END $$", false, true],
    ['DO $$ BEGIN PERFORM 1; END $$', false, false],
    ['DO $$ BEGIN CREATE TABLE IF NOT EXISTS staged (id int); END $$', false, false],
    ['DO $$ BEGIN SET LOCAL a = 1; END $$; COMMIT', false, false],
    ['COMMIT; DO $$ BEGIN SET LOCAL a = 1; END $$', true, true],
    ["SELECT 'a'; DO $$ BEGIN PERFORM 1; END $$", false, false],
    ["SELECT 'a'; DO $$ BEGIN SET LOCAL a = 1; END $$", false, true],
    ["DO LANGUAGE 'plpgsql' $$ BEGIN PERFORM 1; END $$", false, false],
  ])('reads `%s` of %j as %j', (sql, before, after) => {
    expect(scopedAfter(sql, true, before).ran).toBe(after);
  });

  // Read in each syntax the session may have, as a backslash in a plain string may end it in one.
  it.each([
    [String.raw`SET LOCAL application_name = 'a\b'`, false, false, true],
    [String.raw`SELECT 'C:\dir'`, false, false, false],
    [String.raw`SELECT 'C:\dir'; COMMIT`, false, true, false],
    [String.raw`SELECT set_config('application_name', 'a\b', true)`, false, false, true],
    [String.raw`SET LOCAL application_name = 'it\'s'`, false, false, true],
    ["SELECT E'a'\n'b'", true, false, true],
    ["SELECT 'unfinished", true, false, true],
  ])('reads `%s` of syntax known on %j, of %j, as %j', (sql, conforming, before, after) => {
    expect(scopedAfter(sql, conforming, before).ran).toBe(after);
  });
});
