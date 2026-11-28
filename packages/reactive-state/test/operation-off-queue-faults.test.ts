import { describe, expect, it, onTestFinished } from 'vitest';

import { AuthorityEngine } from '../src/authority/engine.ts';
import { nodeSql } from '../src/authority/node-sql.ts';
import { PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import { inPglite, openedAtEnd, settled, wait } from './support/apart.ts';
import { databaseFor } from './support/drizzle.ts';

/**
 * A storage that fails the authority's last look at the session of an operation apart from the
 * queue is the call's fault: answered as a fault is, not kept, and told to the application, though
 * the code returned or threw before.
 */

const BUILD = 'b_drizzle';
const MODULE = 'actions/faults';
const TEST_TIMEOUT_MS = 20_000;

/** What `promise` settles to, or the error it is rejected with. */
async function outcome(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}
/** Long enough that the hook, called on a turn of its own, has run. */
const HOOK_MS = 50;

describe('a storage that fails the session’s last read', () => {
  it(
    'answers the fault, tells the application of it and of the code’s throw, and keeps nothing',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await inPglite();
      const gate = Promise.withResolvers<undefined>();
      const started = Promise.withResolvers<undefined>();
      const failing = { on: false };
      const told: unknown[] = [];
      let runs = 0;
      const real = nodeSql(':memory:');
      const engine = new AuthorityEngine({
        buildId: BUILD,
        database: databaseFor(setup),
        externalPollMs: 60_000,
        onError: (error) => {
          told.push(error);
        },
        operations: {
          [MODULE]: {
            late: async (): Promise<void> => {
              runs += 1;
              started.resolve(undefined);
              await gate.promise;
              throw new Error('no room');
            },
          },
        },
        programs: [
          {
            buildId: BUILD,
            component: 'components/faults',
            evaluate: (_props, $: RenderScope) => $.h('p', null, 'shown'),
            protocolVersion: PROTOCOL_VERSION,
            updaters: {},
            writable: [],
          },
        ],
        sql: {
          ...real,
          get: (query, ...parameters) => {
            if (failing.on && query.startsWith('SELECT * FROM sessions')) {
              throw new Error('disk I/O error');
            }
            return real.get(query, ...parameters);
          },
        },
      });
      onTestFinished(async () => {
        failing.on = false;
        await engine.close();
      });
      openedAtEnd(gate);
      const { sessionId } = await engine.login('alice');
      const call = {
        args: [],
        build: BUILD,
        module: MODULE,
        name: 'late',
        operationId: crypto.randomUUID(),
      };
      const first = outcome(engine.operate(sessionId, call));
      await settled(started.promise);
      failing.on = true;
      gate.resolve(undefined);

      const answer = await settled(first);
      failing.on = false;
      await wait(HOOK_MS);
      const again = await settled(outcome(engine.operate(sessionId, call)));

      expect(answer).toMatchObject({ message: 'disk I/O error' });
      expect(told.map((error) => (error as Error).message)).toStrictEqual([
        'no room',
        'disk I/O error',
      ]);
      expect(again).toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });
      expect(runs).toBe(2);
    },
  );
});
