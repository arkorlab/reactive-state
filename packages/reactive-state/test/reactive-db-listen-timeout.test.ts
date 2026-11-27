import { type AddressInfo, connect, createServer } from 'node:net';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { hostOf } from '../src/authority/database-host.ts';
import { reactiveDb } from '../src/sql/db.ts';

/**
 * The connection `LISTEN` holds answers within a time of its own: a link that stalls once the
 * connection is made, before the server answers `LISTEN`, leaves the authority's start to a socket
 * that may take hours to fail, as `connectionTimeoutMillis` ended with the handshake.
 */

const schema = { tasks: pgTable('tasks', { id: text().primaryKey() }) };
/** The authority waits as long as a read of the log may take, a few seconds. */
const TEST_TIMEOUT_MS = 20_000;

/** A server of a PGlite, and a link to it that passes all but what asks for `LISTEN`. */
async function listenedThrough(): Promise<void> {
  const pg = await PGlite.create();
  const server = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', maxConnections: 6, port: 0 });
  await server.start();
  const port = Number(server.getServerConn().split(':').at(-1));
  const sockets = new Set<ReturnType<typeof connect>>();
  const proxy = createServer((near) => {
    const far = connect(port, '127.0.0.1');
    sockets.add(near).add(far);
    near.on('error', vi.fn());
    far.on('error', vi.fn());
    let muted = false;
    near.on('data', (chunk: Buffer) => {
      muted ||= chunk.includes('LISTEN');
      if (!muted) far.write(chunk);
    });
    far.pipe(near);
  });
  await new Promise<void>((resolve) => {
    proxy.listen(0, '127.0.0.1', resolve);
  });
  process.env['DATABASE_URL'] =
    `postgres://postgres@127.0.0.1:${String((proxy.address() as AddressInfo).port)}/postgres`;
  onTestFinished(async () => {
    delete process.env['DATABASE_URL'];
    for (const socket of sockets) socket.destroy();
    proxy.close();
    await server.stop();
    await pg.close();
  });
}

describe('the connection of `LISTEN`', () => {
  it(
    'gives up on a server that made the connection and never answers `LISTEN`',
    async () => {
      await listenedThrough();
      const { db } = await reactiveDb(schema);

      await expect(hostOf(db)?.listen(vi.fn())).rejects.toThrow(/timeout/u);
    },
    TEST_TIMEOUT_MS,
  );
});
