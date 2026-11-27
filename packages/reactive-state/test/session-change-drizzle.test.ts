import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool } from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';

import { type OperationCall } from '../src/program.ts';
import { changeSession } from '../src/server/index.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { engineOf, openedWith } from './support/drizzle.ts';

/**
 * `changeSession` in the application's own transaction (`followDrizzle`'s PGlite `transaction`): the
 * package cannot tell whether that transaction commits where the change is asked, so the call is
 * refused with a `TypeError` while one is open, and taken after it returns, committed or not.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const DDL = `CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);`;
const BUILD = 'b_drizzle';
const MODULE = 'actions/session';
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

/** The call of `name` of the test's module. */
function callOf(name: string): OperationCall {
  return { args: [], build: BUILD, module: MODULE, name, operationId: crypto.randomUUID() };
}

describe('a session change asked in a transaction of the application’s own', () => {
  it(
    'is refused inside it, with what to do, and the rows roll back with the throw',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      const { engine, session } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
        [MODULE]: {
          inside: async (): Promise<unknown> => {
            let refused: unknown;
            try {
              await setup.orm.transaction(async (tx) => {
                await tx.insert(tasks).values({ id: 't2', title: 'Undone' });
                changeSession({ activeTeam: 'inside' });
              });
            } catch (error) {
              refused = error;
            }
            return refused instanceof TypeError ? refused.message : null;
          },
        },
      });

      const receipt = await engine.operate(session, callOf('inside'));

      expect(receipt.result).toContain('once they have returned');
      expect(receipt).not.toHaveProperty('sessionChange');
      await expect(setup.pg.query('SELECT id FROM tasks')).resolves.toMatchObject({ rows: [] });
    },
  );

  it(
    'is taken once they have returned, committed or rolled back',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      const { engine, session } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
        [MODULE]: {
          after: async (): Promise<void> => {
            await setup.orm.transaction(async (tx) => {
              await tx.insert(tasks).values({ id: 't2', title: 'Kept' });
            });
            changeSession({ activeTeam: 'after' });
          },
          afterRolledBack: async (): Promise<void> => {
            try {
              await setup.orm.transaction(async (tx) => {
                await tx.insert(tasks).values({ id: 't3', title: 'Undone' });
                throw new Error('no room');
              });
            } catch {
              // The operation goes on.
            }
            changeSession({ activeTeam: 'after-rollback' });
          },
        },
      });

      const committed = await engine.operate(session, callOf('after'));
      const rolledBack = await engine.operate(session, callOf('afterRolledBack'));

      expect(committed.sessionChange).toStrictEqual({ activeTeam: 'after' });
      expect(rolledBack.sessionChange).toStrictEqual({ activeTeam: 'after-rollback' });
    },
  );
});

/** A pool's connections, and those of the store's client and the socket's spare. */
const CONNECTIONS = { pool: 3, served: 5 } as const;

/** How long a pool's `end()` is waited for, a connection of the test's being left checked out. */
const LEAKED_MS = 300;

/** Waits `ms` on a timer. */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A PGlite served to a `pg.Pool` the application's Drizzle is given, as production has it. */
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
  const follow = followDrizzle({ tasks });
  for (const statement of follow.captureSql()) await store.query(statement);
  onTestFinished(async () => {
    // A connection Drizzle's failed BEGIN never released holds `end()`: the server closing frees it.
    await Promise.race([connections.end(), wait(LEAKED_MS)]);
    await store.end();
    await server.stop();
    await db.close();
  });
  const tracked = follow.client(connections);
  return { follow, orm: drizzle({ client: tracked, schema: { tasks } }), pg: store, tracked };
}

/** The message of the `TypeError` that asking for a session change throws, or none if it is taken. */
function refusalOf(): string | null {
  try {
    changeSession({ activeTeam: 'inside' });
  } catch (error) {
    return error instanceof TypeError ? error.message : String(error);
  }
  return null;
}

/** An operation module over a pooled PGlite, and a way to run its operations. */
async function operated(
  operations: (setup: Awaited<ReturnType<typeof pooled>>) => Readonly<Record<string, unknown>>,
) {
  const setup = await pooled();
  const { engine, session } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
    [MODULE]: operations(setup),
  });
  return { ...setup, operate: async (name: string) => engine.operate(session, callOf(name)) };
}

describe('a session change asked in a transaction of a pool connection', () => {
  it(
    'is refused inside Drizzle’s transaction, whose rows roll back, and taken after it returns',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { operate, pg } = await operated(({ orm }) => {
        return {
          after: async (): Promise<void> => {
            await orm.transaction(async (tx) => {
              await tx.insert(tasks).values({ id: 't3', title: 'Kept' });
            });
            changeSession({ activeTeam: 'after' });
          },
          inside: async (): Promise<string | null> => {
            let refused: string | null = null;
            try {
              await orm.transaction(async (tx) => {
                await tx.insert(tasks).values({ id: 't2', title: 'Undone' });
                refused = refusalOf();
                throw new Error('rolled back');
              });
            } catch {
              // The operation goes on.
            }
            return refused;
          },
        };
      });

      const inside = await operate('inside');
      const after = await operate('after');

      expect(inside.result).toContain('once they have returned');
      expect(inside).not.toHaveProperty('sessionChange');
      expect(after.sessionChange).toStrictEqual({ activeTeam: 'after' });
      await expect(pg.query('SELECT id FROM tasks ORDER BY id')).resolves.toMatchObject({
        rows: [{ id: 't3' }],
      });
    },
  );

  it(
    'is taken after a connection’s COMMIT, before it is released',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { operate } = await operated(({ tracked }) => {
        return {
          committed: async (): Promise<void> => {
            const client = await tracked.connect();
            try {
              await client.query('BEGIN');
              await client.query("INSERT INTO tasks VALUES ('t2', 'Kept')");
              await client.query('COMMIT');
              changeSession({ activeTeam: 'committed' });
            } finally {
              client.release();
            }
          },
        };
      });

      const receipt = await operate('committed');

      expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'committed' });
    },
  );

  it(
    'is taken after a connection is released in its transaction, with no COMMIT or ROLLBACK',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { operate } = await operated(({ tracked }) => {
        return {
          released: async (): Promise<void> => {
            const client = await tracked.connect();
            await client.query('BEGIN');
            await client.query("INSERT INTO tasks VALUES ('t2', 'Undone')");
            client.release();
            changeSession({ activeTeam: 'released' });
          },
        };
      });

      const receipt = await operate('released');

      expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'released' });
    },
  );

  it(
    'sees a transaction END ended: a call before release is taken',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { operate } = await operated(({ tracked }) => {
        return {
          ended: async (): Promise<void> => {
            const client = await tracked.connect();
            try {
              await client.query('BEGIN');
              await client.query("INSERT INTO tasks VALUES ('t2', 'Kept')");
              await client.query('END');
              changeSession({ activeTeam: 'after-end' });
            } finally {
              client.release();
            }
          },
        };
      });

      const receipt = await operate('ended');

      expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'after-end' });
    },
  );

  it.each([
    'BEGIN;',
    'START TRANSACTION',
    'BEGIN ISOLATION LEVEL SERIALIZABLE, READ WRITE',
    'BEGIN -- note',
    "BEGIN; INSERT INTO tasks VALUES ('t2', 'Undone')",
  ])(
    'is refused in a transaction opened as %s, whose rows roll back',
    async (opening) => {
      const { operate, pg } = await operated(({ tracked }) => {
        return {
          opened: async (): Promise<string | null> => {
            const client = await tracked.connect();
            try {
              await client.query(opening);
              const refused = refusalOf();
              await client.query('ROLLBACK');
              return refused;
            } finally {
              client.release();
            }
          },
        };
      });

      const receipt = await operate('opened');

      expect(receipt.result).toContain('once they have returned');
      expect(receipt).not.toHaveProperty('sessionChange');
      await expect(pg.query('SELECT id FROM tasks')).resolves.toMatchObject({ rows: [] });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is refused in a transaction opened through the callback form of query',
    async () => {
      const { operate } = await operated(({ tracked }) => {
        return {
          opened: async (): Promise<string | null> => {
            const client = await tracked.connect();
            try {
              await new Promise<void>((resolve, reject) => {
                client.query('BEGIN', (error: Error | null | undefined) => {
                  if (error === undefined || error === null) resolve();
                  else reject(error);
                });
              });
              const refused = refusalOf();
              await client.query('ROLLBACK');
              return refused;
            } finally {
              client.release();
            }
          },
        };
      });

      const receipt = await operate('opened');

      expect(receipt.result).toContain('once they have returned');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'takes a call after Drizzle’s BEGIN failed, which never released its connection',
    async () => {
      const { operate } = await operated(({ orm }) => {
        return {
          failed: async (): Promise<void> => {
            try {
              await orm.transaction(
                async () => {
                  await Promise.resolve();
                },
                { isolationLevel: 'bogus' as never },
              );
            } catch {
              // The operation goes on.
            }
            changeSession({ activeTeam: 'after-failed-begin' });
          },
        };
      });

      const receipt = await operate('failed');

      expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'after-failed-begin' });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a session change asked in PGlite’s own state', () => {
  it(
    'is refused between a raw BEGIN and its ROLLBACK, and taken after',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      const { engine, session } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
        [MODULE]: {
          raw: async (): Promise<string | null> => {
            await setup.orm.execute(sql`BEGIN`);
            await setup.orm.execute(sql`INSERT INTO tasks VALUES ('t2', 'Undone')`);
            const refused = refusalOf();
            await setup.orm.execute(sql`ROLLBACK`);
            changeSession({ activeTeam: 'after-rollback' });
            return refused;
          },
        },
      });

      const receipt = await engine.operate(session, callOf('raw'));

      expect(receipt.result).toContain('once they have returned');
      expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'after-rollback' });
    },
  );

  it(
    'takes a call after a nested transaction PGlite’s own refused',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      const { engine, session } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
        [MODULE]: {
          nested: async (): Promise<void> => {
            await setup.orm.$client.transaction(async (tx) => {
              try {
                await (tx as unknown as { transaction: () => Promise<void> }).transaction();
              } catch {
                // The outer transaction goes on.
              }
            });
            changeSession({ activeTeam: 'after-nested' });
          },
        },
      });

      const receipt = await engine.operate(session, callOf('nested'));

      expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'after-nested' });
    },
  );
});

describe('a session change asked beside another run’s PGlite transaction', () => {
  it(
    'is still refused by a run in its own raw BEGIN, and taken after its ROLLBACK',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      const { engine, session } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
        [MODULE]: {
          raw: async (): Promise<(string | null)[]> => {
            await setup.orm.execute(sql`BEGIN`);
            const inside = refusalOf();
            await setup.orm.execute(sql`ROLLBACK`);
            return [inside, refusalOf()];
          },
        },
      });

      const receipt = await engine.operate(session, callOf('raw'));

      const [inside, after] = receipt.result as (string | null)[];

      expect(inside).toContain('once they have returned');
      expect(after).toBeNull();
    },
  );

  it(
    'is still refused inside the run’s own transaction',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      const { engine, session } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
        [MODULE]: {
          own: async (): Promise<string | null> => {
            let refused: string | null = null;
            await setup.orm.transaction(async (tx) => {
              await tx.select().from(tasks);
              refused = refusalOf();
            });
            return refused;
          },
        },
      });

      const receipt = await engine.operate(session, callOf('own'));

      expect(receipt.result).toContain('once they have returned');
    },
  );
});
