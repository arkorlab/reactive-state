import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool, type PoolClient, Query } from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';

import { type Json, type OperationCall } from '../src/program.ts';
import { changeSession } from '../src/server/index.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { engineOf, openedWith } from './support/drizzle.ts';

/**
 * A session change asked while a statement or a transaction of the application's own tables is
 * under way: refused, whether its `BEGIN` has been answered or not; and a callback-form checkout of
 * a full pool belongs to the run that made it, not to whichever releases the connection it waits for.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const DDL = `CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);`;
const BUILD = 'b_drizzle';
const MODULE = 'actions/session';
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 30_000;
/** How long a pool's `end()` is waited for, a connection of the test's being left checked out. */
const LEAKED_MS = 300;
const REFUSED = 'once they have returned';

/** The call of `name` of the test's module, sent `args` as JSON. */
function callOf(name: string, args: readonly Json[] = []): OperationCall {
  return {
    args: args.map((json) => ({ json })),
    build: BUILD,
    module: MODULE,
    name,
    operationId: crypto.randomUUID(),
  };
}

/** Waits `ms` on a timer. */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

/** A PGlite served to a `pg.Pool` of `max` connections the application's Drizzle is given. */
async function pooled(max: number) {
  const db = await PGlite.create();
  await db.exec(DDL);
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', maxConnections: 5, port: 0 });
  await server.start();
  const port = Number(server.getServerConn().split(':').at(-1));
  const config = { database: 'postgres', host: '127.0.0.1', port, ssl: false, user: 'postgres' };
  const connections = new Pool({ ...config, max });
  const store = new Client(config);
  await store.connect();
  const follow = followDrizzle({ tasks });
  for (const statement of follow.captureSql()) await store.query(statement);
  onTestFinished(async () => {
    await Promise.race([connections.end(), wait(LEAKED_MS)]);
    await store.end();
    await server.stop();
    await db.close();
  });
  return { follow, pg: store, tracked: follow.client(connections) };
}

/** An operation module over a pooled PGlite, and a way to run its operations. */
async function operated(
  max: number,
  operations: (setup: Awaited<ReturnType<typeof pooled>>) => Readonly<Record<string, unknown>>,
) {
  const setup = await pooled(max);
  const { engine, session } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
    [MODULE]: operations(setup),
  });
  return {
    ...setup,
    operate: async (name: string, ...args: Json[]) => engine.operate(session, callOf(name, args)),
  };
}

describe('a callback-form checkout of a full pool', () => {
  it(
    'is the run’s own, though the pool serves it as a connection is released',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { operate, pg } = await operated(1, ({ tracked }) => {
        return {
          racy: async (useCallback: boolean): Promise<string | null> => {
            const first: PoolClient = await tracked.connect();
            await first.query('BEGIN');
            const second: Promise<PoolClient> = useCallback
              ? new Promise((resolve, reject) => {
                  tracked.connect((error: Error | undefined, client: PoolClient | undefined) => {
                    if (error !== undefined || client === undefined)
                      reject(error ?? new Error('No client.'));
                    else resolve(client);
                  });
                })
              : tracked.connect();
            // Released in its transaction: destroyed, and the queue is pulsed as its socket ends.
            first.release();
            const client = await second;
            try {
              await client.query('BEGIN');
              await client.query("INSERT INTO tasks VALUES ('t2', 'Undone')");
              const refused = refusalOf();
              await client.query('ROLLBACK');
              return refused;
            } finally {
              client.release();
            }
          },
          warm: async (): Promise<void> => {
            const client = await tracked.connect();
            client.release();
          },
        };
      });

      await operate('warm');
      const callback = await operate('racy', true);
      await operate('warm');
      const promised = await operate('racy', false);

      expect(callback.result).toContain(REFUSED);
      expect(callback).not.toHaveProperty('sessionChange');
      expect(promised.result).toContain(REFUSED);
      await expect(pg.query('SELECT id FROM tasks')).resolves.toMatchObject({ rows: [] });
    },
  );
});

describe('a statement or a transaction under way', () => {
  it(
    'refuses a call while a pool connection’s BEGIN is sent and not answered',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { operate, pg } = await operated(3, ({ tracked }) => {
        return {
          pipelined: async (): Promise<string | null> => {
            const client = await tracked.connect();
            try {
              const begun = client.query('BEGIN');
              const inserted = client.query("INSERT INTO tasks VALUES ('t2', 'Undone')");
              const refused = refusalOf();
              await begun;
              await inserted;
              await client.query('ROLLBACK');
              return refused;
            } finally {
              client.release();
            }
          },
        };
      });

      const receipt = await operate('pipelined');

      expect(receipt.result).toContain(REFUSED);
      expect(receipt).not.toHaveProperty('sessionChange');
      await expect(pg.query('SELECT id FROM tasks')).resolves.toMatchObject({ rows: [] });
    },
  );

  it(
    'refuses a call beside a plain INSERT not yet awaited, and takes one once it is',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { operate } = await operated(3, ({ tracked }) => {
        return {
          plain: async (): Promise<string | null> => {
            const client = await tracked.connect();
            try {
              const inserted = client.query("INSERT INTO tasks VALUES ('t2', 'Kept')");
              const refused = refusalOf();
              await inserted;
              changeSession({ activeTeam: 'after' });
              return refused;
            } finally {
              client.release();
            }
          },
        };
      });

      const receipt = await operate('plain');

      expect(receipt.result).toContain(REFUSED);
      expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'after' });
    },
  );

  it(
    'refuses a call while PGlite’s transaction is called and not yet run',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await openedWith({ tasks }, DDL);
      const { engine, session } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
        [MODULE]: {
          voided: async (): Promise<string | null> => {
            const running = setup.orm.transaction(async (tx) => {
              await tx.insert(tasks).values({ id: 't2', title: 'Undone' });
              throw new Error('rolled back');
            });
            const refused = refusalOf();
            try {
              await running;
            } catch {
              // The transaction rolled back.
            }
            changeSession({ activeTeam: 'after' });
            return refused;
          },
        },
      });

      const receipt = await engine.operate(session, callOf('voided'));

      expect(receipt.result).toContain(REFUSED);
      expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'after' });
      await expect(setup.pg.query('SELECT id FROM tasks')).resolves.toMatchObject({ rows: [] });
    },
  );
});

/** `client.query(...args)` in its callback form, answered as the callback is called. */
function viaCallback(client: PoolClient, ...args: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const answer = (error: Error | null | undefined): void => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    };
    (client.query as (...all: unknown[]) => unknown)(...args, answer);
  });
}

describe('a statement sent with a callback or as a submittable', () => {
  it.each([
    ['query(text, cb)', [] as unknown[]],
    ['query(text, values, cb)', [[]] as unknown[]],
  ])(
    'is under way until its callback runs: %s',
    async (_form, extra) => {
      const { operate, pg } = await operated(3, ({ tracked }) => {
        return {
          called: async (): Promise<(string | null)[]> => {
            const client = await tracked.connect();
            try {
              const begun = viaCallback(client, 'BEGIN', ...extra);
              const before = refusalOf();
              await begun;
              await client.query("INSERT INTO tasks VALUES ('t2', 'Undone')");
              const inside = refusalOf();
              const rolledBack = viaCallback(client, 'ROLLBACK', ...extra);
              const midway = refusalOf();
              await rolledBack;
              return [before, inside, midway, refusalOf()];
            } finally {
              client.release();
            }
          },
        };
      });

      const receipt = await operate('called');

      const [before, inside, midway, after] = receipt.result as (string | null)[];

      expect(before).toContain(REFUSED);
      expect(inside).toContain(REFUSED);
      expect(midway).toContain(REFUSED);
      expect(after).toBeNull();
      await expect(pg.query('SELECT id FROM tasks')).resolves.toMatchObject({ rows: [] });
    },
    TEST_TIMEOUT_MS,
  );

  it('is under way until a submittable ends', { timeout: TEST_TIMEOUT_MS }, async () => {
    const { operate } = await operated(3, ({ tracked }) => {
      return {
        submitted: async (): Promise<(string | null)[]> => {
          const client = await tracked.connect();
          try {
            const query = new Query('BEGIN');
            const ended = new Promise<void>((resolve) => {
              query.once('end', () => {
                resolve();
              });
            });
            client.query(query);
            const before = refusalOf();
            await ended;
            await client.query('ROLLBACK');
            return [before, refusalOf()];
          } finally {
            client.release();
          }
        },
      };
    });

    const receipt = await operate('submitted');

    const [before, after] = receipt.result as (string | null)[];

    expect(before).toContain(REFUSED);
    expect(after).toBeNull();
  });
});

describe('a submittable with a callback of its own', () => {
  it.each([
    ['SELECT * FROM missing_table', 'PostgreSQL rejects'],
    ['SELECT 1', 'PostgreSQL answers'],
  ])(
    'is under way until its callback, %s (%s)',
    async (statement) => {
      const { operate } = await operated(3, ({ tracked }) => {
        return {
          called: async (): Promise<(string | null)[]> => {
            const client = await tracked.connect();
            try {
              const { promise: answered, resolve } = Promise.withResolvers<undefined>();
              client.query(
                new Query(statement, () => {
                  resolve(undefined);
                }),
              );
              const before = refusalOf();
              await answered;

              return [before, refusalOf()];
            } finally {
              client.release();
            }
          },
        };
      });

      const receipt = await operate('called');

      const [before, after] = receipt.result as (string | null)[];

      expect(before).toContain(REFUSED);
      expect(after).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
