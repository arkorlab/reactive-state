import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool, type PoolClient } from 'pg';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { changesSession, leavesSession, leavesTransactionOpen } from '../src/sql/guards.ts';
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

/** Runs `body` on a connection `tracked` checks out, given back as it ends, whatever it did. */
async function checkedOut(
  tracked: Awaited<ReturnType<typeof pooled>>['tracked'],
  body: (held: PoolClient) => Promise<void>,
): Promise<void> {
  const held = await tracked.connect();
  try {
    await body(held);
  } finally {
    held.release();
  }
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
      const values = statement.includes('$1') ? ['5000', false] : [];

      await checkedOut(tracked, async (held) => {
        await held.query(statement, values);
      });

      expect(pool.totalCount).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is closed as it is given back, after a setting changed in a transaction that commits',
    async () => {
      const { pool, tracked } = await pooled();

      await checkedOut(tracked, async (held) => {
        await held.query('BEGIN');
        await held.query('SET statement_timeout = 5000');
        await held.query('COMMIT');
      });

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
      try {
        await held.query('SET statement_timeout = 5000');
      } finally {
        done();
      }

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

      await checkedOut(tracked, async (held) => {
        await held.query('BEGIN');
        await held.query(statement);
        await held.query('COMMIT');
      });

      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is given back as it is, after a text that only names a setting',
    async () => {
      const { pool, tracked } = await pooled();

      await checkedOut(tracked, async (held) => {
        await held.query("SELECT 'SET search_path = other'");
        await held.query("UPDATE tasks SET title = 'reset all' WHERE id = 'a'");
      });

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

describe('the settings a text changes that the session’s string syntax makes hard to read', () => {
  // A backslash in a plain string is a letter of it where `standard_conforming_strings` is on, and
  // may end it where it is off; before a first render asks, it is not known on.
  it.each([
    [String.raw`SET application_name = 'a\b'`, false],
    [String.raw`SELECT set_config('application_name', 'a\b', false)`, false],
    [String.raw`SET application_name = 'a\b'`, true],
    [String.raw`SELECT 'a\b'; SET application_name = 'c'`, false],
    // Unreadable in either syntax: it may change one.
    [String.raw`SET application_name = 'it\'s'`, false],
    [String.raw`SET application_name = 'it\'s'`, true],
    [String.raw`INSERT INTO tasks VALUES ('a', 'it\'s')`, false],
    ["SELECT E'a'\n'b'", false],
    ["SELECT 'unfinished", false],
    ['SELECT /* unfinished', true],
  ])('is changed by `%s` of a syntax known on: %j', (statement, conforming) => {
    expect(leavesSession(statement, conforming)).toBe(true);
  });

  it.each([
    [String.raw`SELECT 'C:\dir'`, false],
    [String.raw`INSERT INTO tasks VALUES ('a', 'C:\dir')`, false],
    [String.raw`SELECT 'a\b'`, true],
    [String.raw`SET LOCAL application_name = 'a\b'`, false],
    [String.raw`SELECT set_config('application_name', 'a\b', true)`, false],
    [String.raw`SELECT E'a\nb'`, false],
    ["SELECT 'it''s'", false],
  ])('is not changed by `%s` of a syntax known on: %j', (statement, conforming) => {
    expect(leavesSession(statement, conforming)).toBe(false);
  });

  it(
    'closes a connection given back after a text of a backslash it could not read before a render',
    async () => {
      const { pool, tracked } = await pooled();

      await checkedOut(tracked, async (held) => {
        await held.query(String.raw`SET application_name = 'a\b'`);
      });

      expect(pool.totalCount).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'gives a connection back as it is after a text of a backslash that changes no setting',
    async () => {
      const { pool, tracked } = await pooled();

      await checkedOut(tracked, async (held) => {
        await held.query(String.raw`SELECT 'C:\dir'`);
      });

      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a statement of a text that is no setting of a session', () => {
  it.each([
    ['SET CONSTRAINTS ALL DEFERRED'],
    ['set constraints all immediate'],
    ['SET CONSTRAINTS tasks_pkey DEFERRED'],
    ['BEGIN; SET CONSTRAINTS ALL DEFERRED; COMMIT'],
  ])('is no change of one: `%s`', (statement) => {
    expect(changesSession(statement, true)).toBe(false);
    expect(leavesSession(statement, true)).toBe(false);
  });

  it.each([['SET constraints.name = 1'], ['SET "constraints".name = 1']])(
    'is one of a setting of that prefix: `%s`',
    (statement) => {
      expect(changesSession(statement, true)).toBe(true);
      expect(leavesSession(statement, true)).toBe(true);
    },
  );

  it(
    'gives a connection back as it is after `SET CONSTRAINTS` in a transaction',
    async () => {
      const { pool, tracked } = await pooled();

      await checkedOut(tracked, async (held) => {
        await held.query('BEGIN');
        await held.query('SET CONSTRAINTS ALL DEFERRED');
        await held.query('COMMIT');
      });

      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a text the pool itself runs on one connection of many', () => {
  it.each([
    [String.raw`SET application_name = 'a\b'`, false],
    ["SET application_name = E'a'\n'b'", false],
    ["SET application_name = E'a'\n'b'", true],
    [String.raw`SET application_name = 'it\'s'`, false],
    ["SELECT 'unfinished", true],
    ['SELECT /* unfinished', false],
  ])('is changed by `%s` of a syntax known on: %j', (statement, conforming) => {
    expect(changesSession(statement, conforming)).toBe(true);
  });

  it.each([
    [String.raw`SELECT 'C:\dir'`, false],
    [String.raw`INSERT INTO tasks VALUES ('a', 'C:\dir')`, false],
    [String.raw`SELECT * FROM tasks WHERE title ~ '\d+'`, false],
    [String.raw`SELECT E'a\nb'`, false],
    ["SELECT 'it''s'", true],
  ])('is not changed by `%s` of a syntax known on: %j', (statement, conforming) => {
    expect(changesSession(statement, conforming)).toBe(false);
  });

  it.each([[String.raw`SET application_name = 'a\b'`], ["SET application_name = E'a'\n'b'"]])(
    'refuses `%s` as it would change one connection of many, of a syntax not known on',
    async (statement) => {
      const { tracked } = await pooled();

      await expect(tracked.query(statement)).rejects.toThrow(/one connection/u);
      await expect(tracked.query({ text: statement })).rejects.toThrow(/one connection/u);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs a text of a backslash that changes nothing, before a render has said the syntax',
    async () => {
      const { tracked } = await pooled();

      await expect(tracked.query(String.raw`SELECT 'C:\dir' AS path`)).resolves.toMatchObject({
        rows: [{ path: String.raw`C:\dir` }],
      });
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['BEGIN'],
    ['begin isolation level serializable'],
    ['START TRANSACTION'],
    ["BEGIN; INSERT INTO tasks VALUES ('c', 'three')"],
    ['SELECT 1; BEGIN'],
    ['COMMIT; BEGIN'],
    // A chained end starts the transaction again.
    ['BEGIN; COMMIT AND CHAIN'],
    ['BEGIN; ROLLBACK AND CHAIN'],
    ['BEGIN; COMMIT WORK AND CHAIN'],
    ['BEGIN; END TRANSACTION AND CHAIN'],
    ['BEGIN; ABORT AND CHAIN'],
    ['BEGIN; COMMIT AND CHAIN; COMMIT AND CHAIN'],
  ])('leaves a transaction open: `%s`', (statement) => {
    expect(leavesTransactionOpen(statement, true)).toBe(true);
  });

  it.each([
    ['SELECT 1'],
    ['COMMIT'],
    ["BEGIN; INSERT INTO tasks VALUES ('c', 'three'); COMMIT"],
    ['BEGIN; SELECT 1; END'],
    ['BEGIN; ROLLBACK'],
    ['BEGIN; SELECT 1; COMMIT; SELECT 2'],
    ["SELECT 'BEGIN'"],
    ['DO $$ BEGIN PERFORM 1; END $$'],
    ['SELECT begin_at FROM tasks'],
    ["COMMIT PREPARED 'x'"],
    ['BEGIN; COMMIT AND NO CHAIN'],
    ['BEGIN; COMMIT AND CHAIN; COMMIT'],
    ['BEGIN; COMMIT AND CHAIN; ROLLBACK AND NO CHAIN'],
    ['COMMIT AND CHAIN'],
  ])('leaves none open: `%s`', (statement) => {
    expect(leavesTransactionOpen(statement, true)).toBe(false);
  });

  it.each([
    ['BEGIN'],
    ['START TRANSACTION READ ONLY'],
    ["BEGIN; INSERT INTO tasks VALUES ('c', 'three')"],
    ["BEGIN; INSERT INTO tasks VALUES ('c', 'three'); COMMIT AND CHAIN"],
    ['BEGIN; ROLLBACK AND CHAIN'],
  ])(
    'refuses `%s`, which would give the next to take the connection a transaction no one commits',
    async (statement) => {
      const { pool, tracked } = await pooled();

      await expect(tracked.query(statement)).rejects.toThrow(/transaction this leaves open/u);
      await expect(tracked.query({ text: statement })).rejects.toThrow(
        /transaction this leaves open/u,
      );
      await expect(pool.query('SELECT 1')).resolves.toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tells a callback of the refusal, as `pg` tells it a fault',
    async () => {
      const { tracked } = await pooled();
      const heard = vi.fn();

      Reflect.apply(Reflect.get(tracked, 'query') as (...args: unknown[]) => unknown, tracked, [
        'BEGIN',
        heard,
      ]);

      await vi.waitFor(() => {
        expect(heard).toHaveBeenCalledTimes(1);
      });

      expect(String(heard.mock.calls[0]?.[0])).toMatch(/transaction this leaves open/u);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs a text that opens a transaction and ends it, and a transaction of a checked-out connection',
    async () => {
      const { pool, tracked } = await pooled();

      await tracked.query("BEGIN; INSERT INTO tasks VALUES ('c', 'three'); COMMIT");
      await checkedOut(tracked, async (held) => {
        await held.query('BEGIN');
        await held.query("INSERT INTO tasks VALUES ('d', 'four')");
        await held.query('COMMIT');
      });

      await expect(pool.query('SELECT count(*)::int AS n FROM tasks')).resolves.toMatchObject({
        rows: [{ n: 4 }],
      });
      expect(pool.idleCount).toBe(pool.totalCount);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a checkout released twice', () => {
  it(
    'is refused the second time, as `pg` refuses it, and touches no other checkout',
    async () => {
      const { pool, tracked } = await pooled();
      const first = await tracked.connect();
      first.release();
      const second = await tracked.connect();
      onTestFinished(() => {
        second.release();
      });

      const listening = second.listenerCount('error');

      expect(() => {
        first.release();
      }).toThrow('already been released');

      // The connection the second checkout holds is still its own: no one gave it back, nor took
      // the listener the checkout put on it.
      expect(pool.idleCount).toBe(pool.totalCount - 1);
      expect(second.listenerCount('error')).toBe(listening);
      await expect(second.query('SELECT 1 AS one')).resolves.toMatchObject({ rows: [{ one: 1 }] });
    },
    TEST_TIMEOUT_MS,
  );
});
