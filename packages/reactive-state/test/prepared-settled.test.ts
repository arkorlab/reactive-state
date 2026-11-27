import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Pool } from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/node-engine.ts';
import type { OperationCall, RenderScope } from '../src/program.ts';
import { prepared } from '../src/server/index.ts';
import { inPglite, settled } from './support/apart.ts';
import { db } from './support/app/db.ts';
import { engineOf } from './support/drizzle.ts';
import { application, BUILD } from './support/program.ts';

/**
 * `prepared()` after the operation's evaluation settled: code a library runs in the async context
 * of an earlier run — a timer the operation left behind, a callback of a pooled socket — is not
 * handed that run's preparation, which belongs to one user's call.
 */

/** What `read` answered, or the error it threw as text. */
function attempt(read: () => unknown): { answered: unknown } | { threw: string } {
  try {
    return { answered: read() };
  } catch (error) {
    return { threw: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

describe('prepared() once the operation settled', () => {
  it('is a TypeError in a timer the operation left behind', async () => {
    const late = Promise.withResolvers<unknown>();
    const engine = new Engine({
      ...application,
      operations: {
        ...application.operations,
        'actions/settled': {
          leave: () => {
            setTimeout(() => {
              late.resolve(attempt(() => prepared()));
            }, 20);
            return 'returned';
          },
        },
      },
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const { sessionId } = await engine.login('alice');

    const receipt = await engine.operate(sessionId, {
      args: [],
      build: BUILD,
      module: 'actions/settled',
      name: 'leave',
      operationId: 'op-late',
      prepared: { secret: 'the-preparation' },
    });
    const read = (await late.promise) as { answered?: unknown; threw?: string };

    expect(receipt.result).toBe('returned');
    expect(read.answered).toBeUndefined();
    expect(read.threw).toContain('TypeError');
    expect(read.threw).toContain('after the server operation that started it had settled');
  });

  it('still answers in the transaction body of the operation while it runs', async () => {
    const engine = new Engine({
      ...application,
      operations: {
        ...application.operations,
        'actions/settled': {
          inTransaction: () => {
            return db.transaction(async () => {
              await Promise.resolve();
              return prepared();
            });
          },
        },
      },
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const { sessionId } = await engine.login('alice');

    const receipt = await engine.operate(sessionId, {
      args: [],
      build: BUILD,
      module: 'actions/settled',
      name: 'inTransaction',
      operationId: 'op-tx',
      prepared: { inside: true },
    });

    expect(receipt.result).toStrictEqual({ inside: true });
  });

  it(
    'hands no run the value of another, in a callback of a pooled connection',
    {
      timeout: 60_000,
    },
    async () => {
      const raw = await PGlite.create();
      const server = new PGLiteSocketServer({
        db: raw,
        host: '127.0.0.1',
        maxConnections: 3,
        port: 0,
      });
      await server.start();
      const port = Number(server.getServerConn().split(':').at(-1));
      const pool = new Pool({
        database: 'postgres',
        host: '127.0.0.1',
        max: 1,
        port,
        ssl: false,
        user: 'postgres',
      });
      onTestFinished(async () => {
        await pool.end();
        await server.stop();
        await raw.close();
      });
      const module = 'actions/apart';
      const setup = await inPglite();
      const { engine, session } = await engineOf(
        setup,
        (_props, $: RenderScope) => Promise.resolve($.h('p', null, 'x')),
        {
          [module]: {
            viaCallback: async (): Promise<unknown> => {
              const before = prepared();
              const inCallback = await new Promise<unknown>((resolve) => {
                pool.query('SELECT pg_sleep(0.05)', () => {
                  resolve(attempt(() => prepared()));
                });
              });
              return { after: prepared(), before, inCallback };
            },
          },
        },
      );
      const bob = (await engine.login('bob')).sessionId;
      const sessions = [session, bob, session, bob];
      const calls: OperationCall[] = ['A', 'B', 'C', 'D'].map((who) => {
        return {
          args: [],
          build: 'b_drizzle',
          module,
          name: 'viaCallback',
          operationId: crypto.randomUUID(),
          prepared: { who },
        };
      });

      const seen: {
        after: unknown;
        before: unknown;
        inCallback: { answered?: unknown; threw?: string };
      }[] = [];
      // One after another: no two runs at once, the pool's one connection reused.
      for (const [index, call] of calls.entries()) {
        const receipt = await settled(engine.operate(sessions[index] ?? session, call), 30_000);
        seen.push(receipt.result as (typeof seen)[number]);
      }

      expect(seen.map((run) => [run.before, run.after])).toStrictEqual(
        ['A', 'B', 'C', 'D'].map((who) => [{ who }, { who }]),
      );

      // A callback of the first run's connection, once that run has settled: B, C and D are refused.
      const later = seen.slice(1).map((run) => run.inCallback);

      expect(later.map((read) => read.answered)).toStrictEqual([undefined, undefined, undefined]);
      expect(later.map((read) => read.threw?.startsWith('TypeError'))).toStrictEqual([
        true,
        true,
        true,
      ]);
      // Its own run's callback, where it ran in time, reads its own value.
      expect([undefined, { who: 'A' }]).toContainEqual(seen[0]?.inCallback.answered);
    },
  );
});
