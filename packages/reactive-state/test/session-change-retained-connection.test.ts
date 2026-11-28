import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool, type PoolClient } from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';

import { type OperationCall } from '../src/program.ts';
import { changeSession } from '../src/server/index.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { engineOf } from './support/drizzle.ts';

/**
 * `changeSession` of an operation that uses a connection it did not check out: one the application
 * took from the pool before the operation began, and keeps. The operation's own transaction on it
 * is one the package cannot follow, as on a connection the operation took itself, so the change is
 * refused while it is open and taken after it returns.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const DDL = `CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);`;
const BUILD = 'b_drizzle';
const MODULE = 'actions/session';
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;
/** A pool's connections, and those of the store's client and the socket's spare. */
const CONNECTIONS = { pool: 3, served: 5 } as const;

/** The call of `name` of the test's module. */
function callOf(name: string): OperationCall {
  return { args: [], build: BUILD, module: MODULE, name, operationId: crypto.randomUUID() };
}

/** The message of the `TypeError` that asking for a session change throws, or none if it is taken. */
function refusalOf(): string | null {
  try {
    changeSession({ activeTeam: 'asked' });
  } catch (error) {
    return error instanceof TypeError ? error.message : String(error);
  }
  return null;
}

/**
 * A PGlite served to a `pg.Pool` of the application's, a connection of which it checked out before
 * any operation began, and an engine whose operations `operations` makes of that connection.
 */
async function retained(operations: (held: PoolClient) => Readonly<Record<string, unknown>>) {
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
  const tracked = follow.client(connections);
  // Taken before any operation: no operation is under way where the pool answers it.
  const held = await tracked.connect();
  onTestFinished(async () => {
    held.release();
    await connections.end();
    await store.end();
    await server.stop();
    await db.close();
  });
  const { engine, session } = await engineOf(
    { follow, pg: store },
    (_props, $) => $.h('p', null, 'shown'),
    { [MODULE]: operations(held) },
  );
  return { held, operate: async (name: string) => engine.operate(session, callOf(name)) };
}

describe('a session change asked of an operation that uses a connection kept from before it', () => {
  it(
    'is refused in a transaction the operation opened on it, and taken after the rollback',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { operate } = await retained((held) => {
        return {
          inside: async (): Promise<string | null> => {
            await held.query('BEGIN');
            await held.query("INSERT INTO tasks VALUES ('t2', 'Undone')");
            const refused = refusalOf();
            await held.query('ROLLBACK');
            changeSession({ activeTeam: 'after' });
            return refused;
          },
        };
      });

      const receipt = await operate('inside');

      expect(receipt.result).toContain('once they have returned');
      expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'after' });
    },
  );

  it(
    'is refused in a transaction opened as `BEGIN;`, which the pool’s client does not read',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { operate } = await retained((held) => {
        return {
          opened: async (): Promise<string | null> => {
            await held.query('BEGIN;');
            const refused = refusalOf();
            await held.query('ROLLBACK');
            return refused;
          },
        };
      });

      const receipt = await operate('opened');

      expect(receipt.result).toContain('once they have returned');
      expect(receipt).not.toHaveProperty('sessionChange');
    },
  );

  it(
    'is taken after the connection’s COMMIT, which the connection is kept after',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { operate } = await retained((held) => {
        return {
          committed: async (): Promise<void> => {
            await held.query('BEGIN');
            await held.query("INSERT INTO tasks VALUES ('t2', 'Kept')");
            await held.query('COMMIT');
            changeSession({ activeTeam: 'committed' });
          },
        };
      });

      const receipt = await operate('committed');

      expect(receipt.sessionChange).toStrictEqual({ activeTeam: 'committed' });
    },
  );
});
