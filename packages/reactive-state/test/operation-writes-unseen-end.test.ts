import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { sql as raw } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool } from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';

import type { OperationCall } from '../src/program.ts';
import { endsTransaction, rollsBack } from '../src/sql/client-writes.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { engineOf, openedWith } from './support/drizzle.ts';

/**
 * The writes of a transaction a server operation opened on a connection it checked out, whose end
 * the pool's client did not see: of a form Drizzle does not write (`COMMIT;`, `END`). A `ROLLBACK`
 * that follows it undoes nothing, so what the transaction wrote is of an outcome unknown, not
 * unwritten: the operation that throws after it is a failure kept for a resend, not the refusal
 * that says nothing was done.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const schema = { tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);
  INSERT INTO tasks VALUES ('t1', 'Write docs');
`;
const BUILD = 'b_drizzle';
const MODULE = 'actions/writes';
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;
/** A pool's connections, and those of the store's client and of the socket's spare. */
const CONNECTIONS = { pool: 3, served: 5 } as const;

/** What `promise` was rejected with; a test fails when it was not. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was not rejected.');
}

/** The ids of the tasks the database holds, in order. */
async function heldIds(pg: Client): Promise<readonly unknown[]> {
  const { rows } = await pg.query<{ id: unknown }>('SELECT id FROM tasks ORDER BY id');
  return rows.map((row) => row.id);
}

/** A PGlite of the tasks, served to a `pg.Pool` and to a client the store reads through. */
async function pooled() {
  const db = await PGlite.create();
  await db.exec(DDL);
  const server = new PGLiteSocketServer({
    db,
    host: '127.0.0.1',
    maxConnections: CONNECTIONS.served,
    port: 0,
  });
  await server.start();
  const port = Number(server.getServerConn().split(':').at(-1));
  const config = { database: 'postgres', host: '127.0.0.1', port, ssl: false, user: 'postgres' };
  const connections = new Pool({ ...config, max: CONNECTIONS.pool });
  const store = new Client(config);
  await store.connect();
  const follow = followDrizzle(schema);
  for (const statement of follow.captureSql()) await store.query(statement);
  onTestFinished(async () => {
    await connections.end();
    await store.end();
    await server.stop();
    await db.close();
  });
  const tracked = follow.client(connections);
  return { follow, orm: drizzle({ client: tracked, schema }), pg: store, tracked };
}

/** The call of `name` of the test's module. */
function callOf(name: string): OperationCall {
  return { args: [], build: BUILD, module: MODULE, name, operationId: crypto.randomUUID() };
}

describe('an operation whose transaction ended in a form the pool’s client does not read', () => {
  it.each([['COMMIT;'], ['END'], ['COMMIT AND CHAIN'], ['  commit  ;']])(
    'answers a failure, not a refusal, when `%s` ends it before a rollback and the code throws',
    async (ending) => {
      const setup = await pooled();
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            ended: async (): Promise<void> => {
              const connection = await setup.tracked.connect();
              try {
                await connection.query('BEGIN');
                await connection.query("INSERT INTO tasks VALUES ('t2', 'Kept')");
                await connection.query(ending);
                await connection.query('ROLLBACK');
              } finally {
                connection.release();
              }
              throw new Error('after the end');
            },
          },
        },
        {},
      );
      const call = callOf('ended');

      const first = await rejection(engine.operate(session, call));
      const again = await rejection(engine.operate(session, call));

      expect(first).toMatchObject({ code: 'OPERATION_FAILED' });
      expect(again).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers a failure, not a refusal, when a connection is given back in the transaction `COMMIT AND CHAIN` opened',
    async () => {
      const setup = await pooled();
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            chained: async (): Promise<void> => {
              const connection = await setup.tracked.connect();
              await connection.query('BEGIN');
              await connection.query("INSERT INTO tasks VALUES ('t2', 'Kept')");
              await connection.query('COMMIT AND CHAIN');
              connection.release();
              throw new Error('after the chain');
            },
          },
        },
        {},
      );

      const answer = await rejection(engine.operate(session, callOf('chained')));

      expect(answer).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers a failure, not a refusal, when a text of several statements ends it before a rollback',
    async () => {
      const setup = await pooled();
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            several: async (): Promise<void> => {
              const connection = await setup.tracked.connect();
              try {
                await connection.query('BEGIN');
                await connection.query("INSERT INTO tasks VALUES ('t2', 'Kept'); COMMIT");
                await connection.query('ROLLBACK');
              } finally {
                connection.release();
              }
              throw new Error('after the commit');
            },
          },
        },
        {},
      );

      const answer = await rejection(engine.operate(session, callOf('several')));

      expect(answer).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers the refusal of a transaction a `ROLLBACK` undid after a rollback to a savepoint of no keyword',
    async () => {
      const setup = await pooled();
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            undone: async (): Promise<void> => {
              const connection = await setup.tracked.connect();
              try {
                await connection.query('BEGIN');
                await connection.query("INSERT INTO tasks VALUES ('t2', 'Undone')");
                await connection.query('SAVEPOINT sp');
                await connection.query('ROLLBACK TO sp');
                await connection.query('ROLLBACK');
              } finally {
                connection.release();
              }
              throw new Error('after the rollback');
            },
          },
        },
        {},
      );

      const answer = await rejection(engine.operate(session, callOf('undone')));

      expect(answer).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers the refusal of a transaction whose `COMMIT` PostgreSQL answered as a `ROLLBACK`, of an error the code caught',
    async () => {
      const setup = await pooled();
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            aborted: async (): Promise<void> => {
              await setup.orm.transaction(async (tx) => {
                await tx.insert(tasks).values({ id: 't2', title: 'Undone' });
                try {
                  await tx.execute(raw`SELECT 1 / 0`);
                } catch {
                  // The transaction is aborted: its `COMMIT` rolls it back, and answers no error.
                }
              });
              throw new Error('after the commit');
            },
          },
        },
        {},
      );
      const call = callOf('aborted');

      const first = await rejection(engine.operate(session, call));
      const again = await rejection(engine.operate(session, call));

      expect(first).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      expect(again).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers a failure of a transaction that committed, whose earlier `COMMIT AND CHAIN` landed, though its own `COMMIT` was a `ROLLBACK`',
    async () => {
      const setup = await pooled();
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            chained: async (): Promise<void> => {
              const connection = await setup.tracked.connect();
              try {
                await connection.query('BEGIN');
                await connection.query("INSERT INTO tasks VALUES ('t2', 'Kept')");
                await connection.query('COMMIT AND CHAIN');
                await connection.query("INSERT INTO tasks VALUES ('t3', 'Undone')");
                try {
                  await connection.query('SELECT 1 / 0');
                } catch {
                  // The chained transaction is aborted: its `COMMIT` rolls it back.
                }
                await connection.query('COMMIT');
              } finally {
                connection.release();
              }
              throw new Error('after the commit');
            },
          },
        },
        {},
      );

      const answer = await rejection(engine.operate(session, callOf('chained')));

      expect(answer).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers the refusal of an operation whose transaction a rollback undid, and throws',
    async () => {
      const setup = await pooled();
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            undone: async (): Promise<void> => {
              const connection = await setup.tracked.connect();
              try {
                await connection.query('BEGIN');
                await connection.query("INSERT INTO tasks VALUES ('t2', 'Undone')");
                await connection.query('ROLLBACK');
              } finally {
                connection.release();
              }
              throw new Error('after the rollback');
            },
          },
        },
        {},
      );

      const answer = await rejection(engine.operate(session, callOf('undone')));

      expect(answer).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1']);
    },
    TEST_TIMEOUT_MS,
  );
});

/** The ids of the tasks a PGlite holds, in order. */
async function heldByPglite(pg: PGlite): Promise<readonly unknown[]> {
  const { rows } = await pg.query<{ id: unknown }>('SELECT id FROM tasks ORDER BY id');
  return rows.map((row) => row.id);
}

describe('an operation whose PGlite transaction was ended by a text of the code’s own', () => {
  it.each([
    ['COMMIT'],
    ['END'],
    ['commit;'],
    ['COMMIT AND CHAIN'],
    ['COMMIT WORK'],
    ['END TRANSACTION'],
  ])(
    'answers a failure, not a refusal, when `%s` ends it and the callback throws',
    async (ending) => {
      const setup = await openedWith(schema, DDL);
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            ended: async (): Promise<void> => {
              await setup.orm.transaction(async (tx) => {
                await tx.insert(tasks).values({ id: 't2', title: 'Kept' });
                await tx.execute(raw.raw(ending));
                throw new Error('after the end');
              });
            },
          },
        },
        {},
      );
      const call = callOf('ended');

      const first = await rejection(engine.operate(session, call));
      const again = await rejection(engine.operate(session, call));

      expect(first).toMatchObject({ code: 'OPERATION_FAILED' });
      expect(again).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(heldByPglite(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers a failure, not a refusal, when `rollback()` follows what a `COMMIT` of its own wrote',
    async () => {
      const setup = await openedWith(schema, DDL);
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            rolled: async (): Promise<void> => {
              await setup.orm.transaction(async (tx) => {
                await tx.insert(tasks).values({ id: 't2', title: 'Kept' });
                await tx.execute(raw`COMMIT`);
                tx.rollback();
              });
            },
          },
        },
        {},
      );

      const answer = await rejection(engine.operate(session, callOf('rolled')));

      expect(answer).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(heldByPglite(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers the refusal of a transaction a text of its own rolled back, and the code threw after',
    async () => {
      const setup = await openedWith(schema, DDL);
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            undone: async (): Promise<void> => {
              await setup.orm.transaction(async (tx) => {
                await tx.insert(tasks).values({ id: 't2', title: 'Undone' });
                await tx.execute(raw`ROLLBACK`);
                throw new Error('after the rollback');
              });
            },
          },
        },
        {},
      );

      const answer = await rejection(engine.operate(session, callOf('undone')));

      expect(answer).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      await expect(heldByPglite(setup.pg)).resolves.toStrictEqual(['t1']);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([['ROLLBACK TO sp'], ['ROLLBACK TO SAVEPOINT sp;'], ['ROLLBACK WORK TO SAVEPOINT sp']])(
    'answers a failure when `%s` followed a write the transaction then committed',
    async (rollback) => {
      const setup = await openedWith(schema, DDL);
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            toSavepoint: async (): Promise<void> => {
              await setup.orm.transaction(async (tx) => {
                await tx.insert(tasks).values({ id: 't2', title: 'Kept' });
                await tx.execute(raw`SAVEPOINT sp`);
                await tx.execute(raw.raw(rollback));
              });
              throw new Error('after the commit');
            },
          },
        },
        {},
      );

      const answer = await rejection(engine.operate(session, callOf('toSavepoint')));

      expect(answer).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(heldByPglite(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers a failure when a savepoint was rolled back inside what the transaction then committed',
    async () => {
      const setup = await openedWith(schema, DDL);
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            nested: async (): Promise<void> => {
              await setup.orm.transaction(async (tx) => {
                await tx.insert(tasks).values({ id: 't2', title: 'Kept' });
                try {
                  await tx.transaction(async (inner) => {
                    await inner.insert(tasks).values({ id: 't3', title: 'Undone' });
                    throw new Error('no room');
                  });
                } catch {
                  // Rolled back to the savepoint alone: `t2` goes on to commit.
                }
              });
              throw new Error('after the commit');
            },
          },
        },
        {},
      );

      const answer = await rejection(engine.operate(session, callOf('nested')));

      expect(answer).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(heldByPglite(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers the refusal of a transaction the callback’s throw rolled back, as before',
    async () => {
      const setup = await openedWith(schema, DDL);
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            thrown: async (): Promise<void> => {
              await setup.orm.transaction(async (tx) => {
                await tx.insert(tasks).values({ id: 't2', title: 'Undone' });
                throw new Error('no room');
              });
            },
          },
        },
        {},
      );

      const answer = await rejection(engine.operate(session, callOf('thrown')));

      expect(answer).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      await expect(heldByPglite(setup.pg)).resolves.toStrictEqual(['t1']);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the statements that end a transaction in a form its client does not read', () => {
  it.each([
    ['COMMIT;'],
    ['END'],
    ['abort'],
    ['COMMIT AND CHAIN'],
    ['ROLLBACK AND CHAIN'],
    ["INSERT INTO tasks VALUES ('t2', 'x'); COMMIT"],
    ['SELECT 1; /* a note */ END'],
    ['COMMIT WORK'],
    ['ROLLBACK TRANSACTION'],
    // A text no syntax reads may have ended it.
    ["SELECT E'a'\n'b'"],
  ])('is ended by `%s`', (sql) => {
    expect(endsTransaction(sql)).toBe(true);
  });

  it.each([
    ['SELECT 1'],
    ["SELECT 'commit; end'"],
    ['SELECT CASE WHEN true THEN 1 END'],
    ["UPDATE tasks SET title = 'rollback' WHERE id = 'a'"],
    ['DO $$ BEGIN PERFORM 1; END $$'],
    ['SELECT commit_count FROM stats'],
    ['ROLLBACK TO sp'],
    ['ROLLBACK TO SAVEPOINT sp;'],
    ['rollback work to savepoint sp'],
    ['ROLLBACK TRANSACTION TO sp'],
    ["COMMIT PREPARED 'x'"],
    ["ROLLBACK PREPARED 'x'"],
    [String.raw`SELECT 'C:\dir'`],
  ])('is not ended by `%s`', (sql) => {
    expect(endsTransaction(sql)).toBe(false);
  });
});

describe('the statements that roll a whole transaction back', () => {
  it.each([['ROLLBACK'], ['abort;'], ['ROLLBACK WORK'], ['ROLLBACK AND CHAIN'], ['  rollback  ']])(
    'is rolled back by `%s`',
    (sql) => {
      expect(rollsBack(sql)).toBe(true);
    },
  );

  it.each([
    ['COMMIT'],
    ['ROLLBACK TO sp'],
    ['ROLLBACK TO SAVEPOINT sp;'],
    ['ROLLBACK; COMMIT'],
    ["ROLLBACK PREPARED 'x'"],
    ["SELECT 'rollback'"],
  ])('is not rolled back by `%s`', (sql) => {
    expect(rollsBack(sql)).toBe(false);
  });
});
