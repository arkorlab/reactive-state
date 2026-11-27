import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool } from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';

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
