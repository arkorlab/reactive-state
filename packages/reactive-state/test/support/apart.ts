import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { onTestFinished } from 'vitest';

import type { ExternalStore } from '../../src/authority/external.ts';
import { followDrizzle } from '../../src/sql/index.ts';
import { type Opened, openedWith } from './drizzle.ts';
import { storeThrough } from './follow-store.ts';

/**
 * The tests of an operation apart from the queue share a table of tasks in a PGlite, followed
 * directly or through a `pg.Pool` served by one, and the waits they use.
 */

export const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
export const schema = { tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);
  INSERT INTO tasks VALUES ('a', 'one');
`;
/**
 * How long a call that should be answered at once is given, and how long one that should wait is.
 */
export const WAIT = { answeredMs: 3000, blockedMs: 300 } as const;
/** A pool's connections, and those of the store's own pool and of the socket's spare. */
const CONNECTIONS = { pool: 3, served: 5 } as const;
/**
 * How long a step of the teardown is given, which a test that failed may leave waiting for good.
 */
const TEARDOWN_MS = 2000;

/** A PGlite of the tasks, followed. */
export async function inPglite(): Promise<Opened<typeof schema>> {
  const setup = await openedWith(schema, DDL);
  return setup;
}

/**
 * A PGlite of the tasks, served to a `pg.Pool` and to a pool of one connection the store reads
 * through, as `reactiveDb`'s store does on a server: a follow is given no `pg.Client`.
 */
export async function inPool(): Promise<PoolSetup> {
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
  const reads = new Pool({ ...config, max: 1 });
  const follow = followDrizzle(schema);
  for (const statement of follow.captureSql()) await reads.query(statement);
  // Each step is bounded: a pool waits for a connection a failed test never gave back.
  onTestFinished(async () => {
    await bounded(connections.end());
    await bounded(reads.end());
    await bounded(server.stop());
    await bounded(db.close());
  });
  const orm = drizzle({ client: follow.client(connections), schema });
  // The log, read through the store's own connection: by a follow of the same tables, given it.
  const reader = followDrizzle(schema);
  return { follow, orm, pg: reads, store: () => storeThrough(reader, reads) };
}

/**
 * The tasks followed through a `pg.Pool`: the follow, the pool's Drizzle, the store's connection,
 * and the store that reads the log through it.
 */
export interface PoolSetup {
  readonly follow: Opened<typeof schema>['follow'];
  readonly orm: NodePgDatabase<typeof schema>;
  readonly pg: Pool;
  readonly store: () => ExternalStore;
}

export type Setup = Opened<typeof schema> | PoolSetup;

/** Waits `ms` on a timer. */
export async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What `promise` settles to, or `'waiting'` if it has not within `ms`. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'waiting'> {
  const waiting = (async () => {
    await wait(ms);
    return 'waiting' as const;
  })();
  return Promise.race([promise, waiting]);
}

/**
 * Waits for `step` at most `TEARDOWN_MS`, and goes on: a teardown that waits on its own never ends.
 */
export async function bounded(step: Promise<unknown>): Promise<void> {
  const ended = (async () => {
    try {
      await step;
    } catch {
      // A step that failed has ended all the same.
    }
  })();
  await Promise.race([ended, wait(TEARDOWN_MS)]);
}

/**
 * `promise`'s answer, or a failure after `ms`: a test fails in its own time, never waits for good.
 */
export async function settled<T>(promise: Promise<T>, ms: number = WAIT.answeredMs): Promise<T> {
  const answer = await within(promise, ms);
  if (answer === 'waiting') {
    throw new Error(`Nothing was answered within ${String(ms)} ms.`);
  }
  return answer;
}

/** Opens `gate` as the test ends, before its engine closes, so that no run stays paused. */
export function openedAtEnd(gate: PromiseWithResolvers<undefined>): void {
  onTestFinished(() => {
    gate.resolve(undefined);
  });
}
