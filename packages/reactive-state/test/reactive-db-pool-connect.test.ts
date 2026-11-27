import { type AddressInfo, createServer, type Socket } from 'node:net';

import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { hostOf } from '../src/authority/database-host.ts';
import { startAuthority } from '../src/authority/index.ts';
import { reactiveDb } from '../src/sql/db.ts';

/**
 * The application's pool gives up on a connection its server never answers: a server that takes the
 * connection and says nothing, as one behind a proxy that lost its backend, would else hold the
 * authority's start for good, at its first call of the pool, and say nothing of it.
 */

const schema = { tasks: pgTable('tasks', { id: text().primaryKey() }) };
const BUILD = 'b_pool_connect';
/** A connection is given up on after a few seconds, and each test makes one. */
const TEST_TIMEOUT_MS = 20_000;

/** A server that takes each connection and never answers, which `DATABASE_URL` names. */
async function silent(): Promise<void> {
  const taken = new Set<Socket>();
  const server = createServer((socket) => {
    taken.add(socket);
    socket.on('error', vi.fn());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  process.env['DATABASE_URL'] = `postgres://postgres@127.0.0.1:${String(port)}/postgres`;
  onTestFinished(() => {
    delete process.env['DATABASE_URL'];
    for (const socket of taken) socket.destroy();
    server.close();
  });
}

describe('the application’s pool of a server that never answers', () => {
  it(
    'fails the authority’s start, which checks the server first',
    async () => {
      await silent();
      const { db } = await reactiveDb(schema);

      await expect(startAuthority({ buildId: BUILD, database: db, programs: [] })).rejects.toThrow(
        /timeout|terminated/iu,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails the migrations and first records that `reactive dev` runs before it',
    async () => {
      await silent();
      const { db } = await reactiveDb(schema);

      await expect(hostOf(db)?.alone(vi.fn().mockResolvedValue(undefined))).rejects.toThrow(
        /timeout|terminated/iu,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
