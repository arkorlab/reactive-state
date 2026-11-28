import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { eq, sql as raw } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool } from 'pg';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/node-engine.ts';
import { type OperationCall, PROTOCOL_VERSION } from '../src/program.ts';
import { database, table, text as field } from '../src/server/schema.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { engineOf, openedWith } from './support/drizzle.ts';

/**
 * A server operation that writes the application's own tables runs once, however often it is sent:
 * its record is made before its first statement that may write, and its answer says what it may
 * have done — a failure, not a refusal, once a write may have landed; unsettled where its time ran
 * out after one — while a statement the database refused, or a transaction rolled back, leaves the
 * answer as before. An attempt answered as of an outcome unknown sends no more statements.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const schema = { tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);
  INSERT INTO tasks VALUES ('t1', 'Write docs');
`;
const BUILD = 'b_drizzle';
const MODULE = 'actions/writes';
/** How long a call may run in a test of its time, and how long one waits that runs past it. */
const TIME = { pastMs: 600, timeoutMs: 200 } as const;
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;
/** Long enough that only `poke()` reads the log in a test. */
const IDLE_POLL_MS = 60_000;
/** A pool's connections, and those of the store's client and of the socket's spare. */
const CONNECTIONS = { pool: 3, served: 5 } as const;

/** What a test's engine follows: the tables, the database, and the Drizzle that writes them. */
type Setup = Parameters<typeof engineOf>[0];

/** What `promise` was rejected with; a test fails when it was not. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was not rejected.');
}

/** What `error` says, with what caused it: Drizzle's error of a query holds the client's as its cause. */
function said(error: unknown): string {
  return error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error);
}

/** Waits `ms` on a timer. */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The call of `name` of the test's module, under `operationId`. */
function callOf(name: string, operationId = crypto.randomUUID()): OperationCall {
  return { args: [], build: BUILD, module: MODULE, name, operationId };
}

/** The ids of the tasks the database holds, in order. */
async function heldIds(pg: {
  readonly query: (sql: string) => Promise<{ readonly rows: readonly unknown[] }>;
}): Promise<readonly unknown[]> {
  const { rows } = await pg.query('SELECT id FROM tasks ORDER BY id');
  return rows.map((row) => (row as { readonly id: unknown }).id);
}

/** A file in a directory of the test's own, removed when it finishes. */
async function databaseFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-writes-'));
  onTestFinished(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  return path.join(dir, 'authority.sqlite');
}

/** An engine of `operations`, of the test's module, following `setup`'s tables; of a call's time. */
async function withOperations(
  setup: Setup,
  operations: Readonly<Record<string, unknown>>,
  timeoutMs?: number,
) {
  return engineOf(
    setup,
    (_props, $) => $.h('p', null, 'shown'),
    { [MODULE]: operations },
    timeoutMs === undefined ? {} : { timeoutMs },
  );
}

/**
 * An engine of `operations` whose database is the file `filename`, following `setup`'s tables: one
 * a test closes itself, as an authority that stops.
 */
function engineAt(
  setup: Setup,
  filename: string,
  operations: Readonly<Record<string, unknown>>,
): Engine {
  return new Engine({
    buildId: BUILD,
    database: database(setup.follow.tables),
    externalPollMs: IDLE_POLL_MS,
    filename,
    operations: { [MODULE]: operations },
    programs: [
      {
        buildId: BUILD,
        component: 'components/writes',
        evaluate: (_props, $) => $.h('p', null, 'shown'),
        protocolVersion: PROTOCOL_VERSION,
        updaters: {},
        writable: [],
      },
    ],
    stores: { [setup.follow.storeName]: setup.follow.store(setup.pg) },
    timeoutMs: TIME.timeoutMs,
  });
}

/** A statement `pg` was sent, and the outcomes the operations table held as it went. */
interface SentWhen {
  readonly sql: string;
  readonly outcomes: readonly unknown[];
}

/** What the operations table of `file` held as each statement `pg` was sent went. */
function outcomesAsSent(pg: PGlite, file: DatabaseSync): readonly SentWhen[] {
  const recorded: SentWhen[] = [];
  const query = pg.query.bind(pg);
  vi.spyOn(pg, 'query').mockImplementation((sql, ...rest) => {
    const rows = file.prepare('SELECT outcome FROM operations').all();
    recorded.push({ outcomes: rows.map((row) => row['outcome']), sql });
    return query(sql, ...rest);
  });
  return recorded;
}

describe(
  'an operation that writes tables of a Drizzle schema in PGlite',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it('answers a failure, not a refusal, of an operation that wrote and then threw, and runs it once', async () => {
      const setup = await openedWith(schema, DDL);
      let runs = 0;
      const { engine, session } = await withOperations(setup, {
        wrote: async (): Promise<void> => {
          runs += 1;
          await setup.orm.insert(tasks).values({ id: 't2', title: 'Written' });
          throw new Error('after writing');
        },
      });
      const call = callOf('wrote');

      const first = await rejection(engine.operate(session, call));
      const again = await rejection(engine.operate(session, call));

      expect(first).toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
      expect((first as Error).message).toContain('may have written');
      expect((first as Error).message).toContain('after writing');
      expect(again).toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
      expect(runs).toBe(1);
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    });

    it('answers the refusal of an operation whose one write the database refused, and keeps it', async () => {
      const setup = await openedWith(schema, DDL);
      let runs = 0;
      const { engine, session } = await withOperations(setup, {
        taken: async (): Promise<void> => {
          runs += 1;
          await setup.orm.insert(tasks).values({ id: 't1', title: 'Again' });
        },
      });
      const call = callOf('taken');

      const first = await rejection(engine.operate(session, call));
      const again = await rejection(engine.operate(session, call));

      expect(first).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      expect(again).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      expect(runs).toBe(1);
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1']);
    });

    it('answers the refusal of an operation that read and then threw', async () => {
      const setup = await openedWith(schema, DDL);
      const { engine, session } = await withOperations(setup, {
        read: async (): Promise<void> => {
          await setup.orm.select().from(tasks).where(eq(tasks.id, 't1'));
          throw new Error('no such task');
        },
      });

      const answer = await rejection(engine.operate(session, callOf('read')));

      expect(answer).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
    });

    it('answers an operation that ran past its time after a write as unsettled, and sends no more of its statements', async () => {
      const setup = await openedWith(schema, DDL);
      let runs = 0;
      const later = Promise.withResolvers<unknown>();
      const slow = async (): Promise<void> => {
        runs += 1;
        await setup.orm.insert(tasks).values({ id: 't2', title: 'First' });
        await wait(TIME.pastMs);
        try {
          await setup.orm.insert(tasks).values({ id: 't3', title: 'Second' });
          later.resolve('sent');
        } catch (error) {
          later.resolve(error);
        }
      };
      const { engine, session } = await withOperations(setup, { slow }, TIME.timeoutMs);
      const call = callOf('slow');

      const first = await rejection(engine.operate(session, call));
      const again = await rejection(engine.operate(session, call));
      const sent = await later.promise;

      expect(first).toMatchObject({ code: 'OPERATION_UNSETTLED', status: 500 });
      expect(again).toMatchObject({ code: 'OPERATION_UNSETTLED', status: 500 });
      expect(said(sent)).toContain('sends no more statements');
      expect(runs).toBe(1);
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    });

    it('sends no statement of an attempt that ran past its time before it wrote, and runs the operation again', async () => {
      const setup = await openedWith(schema, DDL);
      const later = Promise.withResolvers<unknown>();
      const attempts = [
        async (): Promise<void> => {
          await wait(TIME.pastMs);
          try {
            await setup.orm.insert(tasks).values({ id: 'late', title: 'Late' });
            later.resolve('sent');
          } catch (error) {
            later.resolve(error);
          }
        },
        async (): Promise<void> => {
          await setup.orm.insert(tasks).values({ id: 'now', title: 'Again' });
        },
      ];
      let runs = 0;
      const late = async (): Promise<void> => {
        const attempt = attempts[runs];
        runs += 1;
        await attempt?.();
      };
      const { engine, session } = await withOperations(setup, { late }, TIME.timeoutMs);
      const call = callOf('late');

      const first = await rejection(engine.operate(session, call));
      const sent = await later.promise;
      const again = await engine.operate(session, call);

      expect((first as Error).message).toContain('did not settle within');
      expect(said(sent)).toContain('sends no more statements');
      expect(again).toMatchObject({ deduplicated: false, result: null });
      expect(runs).toBe(2);
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['now', 't1']);
    });

    it('makes the operation’s record before its first write goes, and answers a resend after a restart as unsettled', async () => {
      const setup = await openedWith(schema, DDL);
      const filename = await databaseFile();
      let runs = 0;
      const operations = {
        hung: async (): Promise<void> => {
          runs += 1;
          await setup.orm.insert(tasks).values({ id: 't2', title: 'Written' });
          await new Promise(() => {
            // Never settles: the authority stops with the operation under way.
          });
        },
      };
      const first = engineAt(setup, filename, operations);
      const file = new DatabaseSync(filename, { readOnly: true });
      onTestFinished(() => {
        file.close();
      });
      const recorded = outcomesAsSent(setup.pg, file);
      const { sessionId } = await first.login('alice');
      const call = callOf('hung', 'op-hung');

      const unsettled = await rejection(first.operate(sessionId, call));
      await first.close();
      const second = engineAt(setup, filename, operations);
      onTestFinished(async () => {
        await second.close();
      });
      const again = await rejection(second.operate(sessionId, call));
      const inserts = recorded.filter((each) => /^\s*insert\b/iu.test(each.sql));

      expect(unsettled).toMatchObject({ code: 'OPERATION_UNSETTLED' });
      expect(again).toMatchObject({ code: 'OPERATION_UNSETTLED', status: 500 });
      expect(inserts.map((each) => each.outcomes)).toStrictEqual([
        ['{"committed":{"revision":0},"external":true}'],
      ]);
      expect(runs).toBe(1);
    });

    it('answers the refusal of an operation that threw in a transaction it rolled back', async () => {
      const setup = await openedWith(schema, DDL);
      const { engine, session } = await withOperations(setup, {
        rolledBack: async (): Promise<void> => {
          await setup.orm.transaction(async (tx) => {
            await tx.insert(tasks).values({ id: 't2', title: 'Undone' });
            throw new Error('no room');
          });
        },
      });
      const call = callOf('rolledBack');

      const first = await rejection(engine.operate(session, call));
      const again = await rejection(engine.operate(session, call));

      expect(first).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      expect((first as Error).message).toContain('no room');
      expect(again).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1']);
    });

    it('answers a failure of an operation that committed a transaction and then threw', async () => {
      const setup = await openedWith(schema, DDL);
      const { engine, session } = await withOperations(setup, {
        committed: async (): Promise<void> => {
          await setup.orm.transaction(async (tx) => {
            await tx.insert(tasks).values({ id: 't2', title: 'Kept' });
          });
          throw new Error('after the commit');
        },
      });

      const answer = await rejection(engine.operate(session, callOf('committed')));

      expect(answer).toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    });

    it('answers a failure of an operation whose procedure committed a row and then raised', async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.exec(`
        CREATE PROCEDURE add_then_fail() LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO tasks VALUES ('t2', 'Committed');
          COMMIT;
          RAISE EXCEPTION 'after the commit';
        END $$;
      `);
      const { engine, session } = await withOperations(setup, {
        called: async (): Promise<void> => {
          await setup.orm.execute(raw`CALL add_then_fail()`);
        },
      });

      const answer = await rejection(engine.operate(session, callOf('called')));

      expect(answer).toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    });

    it('rolls back a transaction whose commit comes after the time ran out', async () => {
      const setup = await openedWith(schema, DDL);
      const later = Promise.withResolvers<unknown>();
      const slow = async (): Promise<void> => {
        try {
          await setup.orm.transaction(async (tx) => {
            await tx.insert(tasks).values({ id: 't2', title: 'Too late' });
            await wait(TIME.pastMs);
          });
          later.resolve('committed');
        } catch (error) {
          later.resolve(error);
        }
      };
      const { engine, session } = await withOperations(setup, { slow }, TIME.timeoutMs);

      const answer = await rejection(engine.operate(session, callOf('slow')));
      const committed = await later.promise;

      expect(answer).toMatchObject({ code: 'OPERATION_UNSETTLED' });
      expect(said(committed)).toContain('sends no more statements');
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1']);
    });

    it('answers what an operation returned that caught the refusal of a statement of its transaction', async () => {
      const setup = await openedWith(schema, DDL);
      const { engine, session } = await withOperations(setup, {
        caught: async (): Promise<string> => {
          try {
            await setup.orm.transaction(async (tx) => {
              await tx.insert(tasks).values({ id: 't1', title: 'Taken' });
            });
          } catch {
            return 'taken';
          }
          return 'written';
        },
      });

      await expect(engine.operate(session, callOf('caught'))).resolves.toMatchObject({
        result: 'taken',
      });
    });

    it('answers a resend of an operation that wrote and committed the authority’s own records as the first', async () => {
      const setup = await openedWith(schema, DDL);
      const declared = database({
        ...setup.follow.tables,
        notes: table({ body: field({ maxLength: 64 }) }),
      });
      const both = async (): Promise<string> => {
        await setup.orm.insert(tasks).values({ id: 't2', title: 'Written' });
        await declared.transaction(async () => {
          await declared.notes.insert({ body: 'noted' });
        });
        return 'done';
      };
      const { engine, session } = await engineOf(
        setup,
        (_props, $) => $.h('p', null, 'shown'),
        { [MODULE]: { both } },
        { database: declared },
      );
      const call = callOf('both');

      const first = await engine.operate(session, call);
      const again = await engine.operate(session, call);

      expect(first).toMatchObject({ deduplicated: false, result: 'done' });
      expect(first.committedRevision).toStrictEqual(expect.any(Number));
      expect(again).toStrictEqual({ ...first, deduplicated: true });
    });
  },
);

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

describe(
  'an operation that writes tables of a Drizzle schema through a pg.Pool',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it('answers a failure of an operation that wrote and then threw, and runs it once', async () => {
      const setup = await pooled();
      let runs = 0;
      const { engine, session } = await withOperations(setup, {
        wrote: async (): Promise<void> => {
          runs += 1;
          await setup.orm.insert(tasks).values({ id: 't2', title: 'Written' });
          throw new Error('after writing');
        },
      });
      const call = callOf('wrote');

      const first = await rejection(engine.operate(session, call));
      const again = await rejection(engine.operate(session, call));

      expect(first).toMatchObject({ code: 'OPERATION_FAILED' });
      expect(again).toMatchObject({ code: 'OPERATION_FAILED' });
      expect(runs).toBe(1);
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    });

    it('answers the refusal of an operation that threw in a transaction it rolled back', async () => {
      const setup = await pooled();
      const { engine, session } = await withOperations(setup, {
        rolledBack: async (): Promise<void> => {
          await setup.orm.transaction(async (tx) => {
            await tx.insert(tasks).values({ id: 't2', title: 'Undone' });
            throw new Error('no room');
          });
        },
      });

      const answer = await rejection(engine.operate(session, callOf('rolledBack')));

      expect(answer).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1']);
    });

    it('answers a failure of an operation that committed a transaction and then threw', async () => {
      const setup = await pooled();
      const { engine, session } = await withOperations(setup, {
        committed: async (): Promise<void> => {
          await setup.orm.transaction(async (tx) => {
            await tx.insert(tasks).values({ id: 't2', title: 'Kept' });
          });
          throw new Error('after the commit');
        },
      });

      const answer = await rejection(engine.operate(session, callOf('committed')));

      expect(answer).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    });

    it('answers a failure of an operation whose transaction ended unseen before another was rolled back', async () => {
      const setup = await pooled();
      const { engine, session } = await withOperations(setup, {
        ended: async (): Promise<void> => {
          const connection = await setup.tracked.connect();
          try {
            await connection.query('BEGIN');
            await connection.query("INSERT INTO tasks VALUES ('t2', 'Kept')");
            await connection.query('END');
            await connection.query('BEGIN');
            await connection.query('ROLLBACK');
          } finally {
            connection.release();
          }
          throw new Error('after the end');
        },
      });

      const answer = await rejection(engine.operate(session, callOf('ended')));

      expect(answer).toMatchObject({ code: 'OPERATION_FAILED' });
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1', 't2']);
    });

    it('refuses the late commit of a transaction opened in a form Drizzle does not write', async () => {
      const setup = await pooled();
      const later = Promise.withResolvers<unknown>();
      const slow = async (): Promise<void> => {
        const connection = await setup.tracked.connect();
        try {
          await connection.query('BEGIN;');
          await connection.query("INSERT INTO tasks VALUES ('t2', 'Too late')");
          await wait(TIME.pastMs);
          try {
            await connection.query('COMMIT');
            later.resolve('committed');
          } catch (error) {
            await connection.query('ROLLBACK');
            later.resolve(error);
          }
        } finally {
          connection.release();
        }
      };
      const { engine, session } = await withOperations(setup, { slow }, TIME.timeoutMs);

      const answer = await rejection(engine.operate(session, callOf('slow')));
      const committed = await later.promise;

      expect(answer).toMatchObject({ code: 'OPERATION_UNSETTLED' });
      expect(said(committed)).toContain('sends no more statements');
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1']);
    });

    it('rolls back a transaction whose commit comes after the time ran out', async () => {
      const setup = await pooled();
      const later = Promise.withResolvers<unknown>();
      // eslint-disable-next-line sonarjs/no-identical-functions -- PGlite's operation, of the pool's client, which rolls it back on its own.
      const slow = async (): Promise<void> => {
        try {
          await setup.orm.transaction(async (tx) => {
            await tx.insert(tasks).values({ id: 't2', title: 'Too late' });
            await wait(TIME.pastMs);
          });
          later.resolve('committed');
        } catch (error) {
          later.resolve(error);
        }
      };
      const { engine, session } = await withOperations(setup, { slow }, TIME.timeoutMs);

      const answer = await rejection(engine.operate(session, callOf('slow')));
      const committed = await later.promise;

      expect(answer).toMatchObject({ code: 'OPERATION_UNSETTLED' });
      expect(said(committed)).toContain('sends no more statements');
      await expect(heldIds(setup.pg)).resolves.toStrictEqual(['t1']);
    });
  },
);
