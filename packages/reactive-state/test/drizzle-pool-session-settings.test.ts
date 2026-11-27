import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool, type PoolClient } from 'pg';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { leavesSession } from '../src/sql/guards.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { engineOf } from './support/drizzle.ts';

/**
 * What a checked-out connection of a `pg` pool does with a setting it changes. A pool refuses the
 * change outside a render, as it reaches one connection of many; a connection checked out may make
 * it, and the pool-wide plans were not asked under it. What it changes beyond its transaction goes
 * with it: it is closed as it is given back, never to the next to take it, and no render plans a
 * statement through it. What a transaction's own `SET LOCAL` and `set_config(…, true)` change ends
 * with the transaction, and the connection is given back as it is.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const schema = { tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);
  INSERT INTO tasks VALUES ('a', 'one'), ('b', 'two');
`;
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

/** A PGlite of the tasks, its log made, served to a pool of its own and to the store's client. */
async function pooled() {
  const db = await PGlite.create();
  await db.exec(DDL);
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', maxConnections: 5, port: 0 });
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

describe('a checked-out connection of a pool that changes a setting', () => {
  it.each([
    ['SET statement_timeout = 5000'],
    ['SET SESSION statement_timeout = 5000'],
    ['SET search_path = public'],
    ['RESET statement_timeout'],
    ["SELECT set_config('statement_timeout', '5000', false)"],
    ["SELECT set_config('statement_timeout', $1, $2)"],
    [String.raw`SELECT U&"set\005fconfig"('statement_timeout', '5000', false)`],
  ])(
    'is closed as it is given back, after `%s`',
    async (statement) => {
      const { pool, tracked } = await pooled();
      const held = await tracked.connect();
      const values = statement.includes('$1') ? ['5000', false] : [];

      await held.query(statement, values);
      held.release();

      expect(pool.totalCount).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is closed as it is given back, after a setting changed in a transaction that commits',
    async () => {
      const { pool, tracked } = await pooled();
      const held = await tracked.connect();

      await held.query('BEGIN');
      await held.query('SET statement_timeout = 5000');
      await held.query('COMMIT');
      held.release();

      expect(pool.totalCount).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is closed as it is given back by the callback of `connect`, after a setting it changed',
    async () => {
      const { pool, tracked } = await pooled();
      const connected = vi.fn();

      tracked.connect(connected);
      await vi.waitFor(() => {
        expect(connected).toHaveBeenCalledTimes(1);
      });
      const [, held, done] = connected.mock.calls[0] as [unknown, PoolClient, () => void];
      await held.query('SET statement_timeout = 5000');
      done();

      expect(pool.totalCount).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['SET LOCAL statement_timeout = 5000'],
    ["SELECT set_config('statement_timeout', '5000', true)"],
    ["SELECT pg_catalog.set_config('statement_timeout', coalesce('5000', ''), true)"],
  ])(
    'is given back as it is, after `%s` in a transaction',
    async (statement) => {
      const { pool, tracked } = await pooled();
      const held = await tracked.connect();

      await held.query('BEGIN');
      await held.query(statement);
      await held.query('COMMIT');
      held.release();

      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is given back as it is, after a text that only names a setting',
    async () => {
      const { pool, tracked } = await pooled();
      const held = await tracked.connect();

      await held.query("SELECT 'SET search_path = other'");
      await held.query("UPDATE tasks SET title = 'reset all' WHERE id = 'a'");
      held.release();

      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is asked no statement of a render, whose plan was not asked under its setting',
    async () => {
      const setup = await pooled();
      const held = await setup.tracked.connect();
      onTestFinished(() => {
        held.release();
      });
      await held.query('SET statement_timeout = 5000');
      const { render } = await engineOf(setup, async (_props, $) =>
        $.h('p', null, JSON.stringify((await held.query('SELECT id FROM tasks')).rows)),
      );

      await expect(render()).rejects.toThrow(/settings were changed/u);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is asked the statements of a render after a setting changed in its transaction alone',
    async () => {
      const setup = await pooled();
      const held = await setup.tracked.connect();
      onTestFinished(() => {
        held.release();
      });
      await held.query('BEGIN');
      await held.query('SET LOCAL statement_timeout = 5000');
      await held.query('COMMIT');
      const { render } = await engineOf(setup, async (_props, $) =>
        $.h('p', null, JSON.stringify((await held.query('SELECT id FROM tasks')).rows)),
      );

      await expect(render()).resolves.toContain('"a"');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the settings a text changes beyond its transaction', () => {
  it.each([
    ['SET search_path = other'],
    ['set session search_path to other'],
    ['SET SESSION AUTHORIZATION DEFAULT'],
    ['RESET ALL'],
    ['DISCARD ALL'],
    ["SELECT set_config('search_path', 'other', false)"],
    ["SELECT set_config('search_path', 'other', $1)"],
    ["SELECT set_config('search_path', 'other', NOT false)"],
    ["SELECT 1; SELECT set_config('a', 'b', false)"],
    ['SELECT 1; SET LOCAL a = 1; SET b = 2'],
    [String.raw`SELECT U&"set\005fconfig"('search_path', 'other', false)`],
  ])('is changed by `%s`', (statement) => {
    expect(leavesSession(statement, true)).toBe(true);
  });

  it.each([
    ['SET LOCAL search_path = other'],
    ['set local statement_timeout to 5000'],
    ['SET TRANSACTION READ ONLY'],
    ["SELECT set_config('search_path', 'other', true)"],
    ["SELECT pg_catalog.set_config('a', f('x', 1), true)"],
    ["SELECT set_config('a', $1, TRUE), set_config('b', $2, true)"],
    ["SELECT 'SET search_path = other'"],
    ["UPDATE tasks SET title = 'reset all' WHERE id = 'a'"],
    ['SELECT 1'],
  ])('is not changed by `%s`', (statement) => {
    expect(leavesSession(statement, true)).toBe(false);
  });
});
