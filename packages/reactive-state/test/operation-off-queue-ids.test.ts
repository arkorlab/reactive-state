import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/node-engine.ts';
import {
  type OperationCall,
  PROTOCOL_VERSION,
  type ProgramUpdater,
  type RenderScope,
} from '../src/program.ts';
import { followedDb } from '../src/sql/index.ts';
import {
  inPglite,
  inPool,
  type Setup,
  tasks,
  WAIT,
  wait,
  within,
  openedAtEnd,
  settled,
} from './support/apart.ts';
import { COMPONENT, databaseFor, engineOf } from './support/drizzle.ts';
import { clientOf } from './support/frames.ts';

/**
 * What an operation apart from the queue keeps of its answer, by its session: an asserted session
 * keeps it though its assertion expired while the code ran; a demo session keeps it while its row
 * exists, and writes no record once it was ended. A field update of the id of a run under way waits
 * for the run.
 */

const BUILD = 'b_drizzle';
const MODULE = 'actions/ids';
const TEST_TIMEOUT_MS = 20_000;
const SET_TITLE = 'u_title';
/** The clock of an asserted test, and how far its assertions reach and the clock moves. */
const CLOCK = { assertedMs: 60_000, movedMs: 10_000, shortMs: 5000, start: 1_000_000 } as const;

/** The call of `name` under `operationId`. */
function callOf(name: string, operationId = crypto.randomUUID()): OperationCall {
  return { args: [], build: BUILD, module: MODULE, name, operationId };
}

/** The rows `sql` selects from the database the test's tasks are in. */
async function rowsOf(setup: Setup, sql: string): Promise<readonly Record<string, unknown>[]> {
  const client = setup.pg as unknown as {
    readonly query: (
      text: string,
    ) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  };
  return (await client.query(sql)).rows;
}

/** The ids of the tasks the database holds, in order. */
async function heldIds(setup: Setup): Promise<readonly unknown[]> {
  const rows = await rowsOf(setup, 'SELECT id FROM tasks ORDER BY id');
  return rows.map((row) => row['id']);
}

/** The assertion of the application's server for `alice`, to last until `expires`. */
function assertion(expires: number) {
  return { expires, id: 'key', user: 'alice' };
}

/** What `promise` settles to, or the error it is rejected with. */
async function outcome(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

/** The binding of the title state a render issued, which a page's setter sends. */
function titleBinding(tree: Parameters<typeof clientOf>[0]): string {
  const state = clientOf(tree, COMPONENT).part.states['title'];
  const binding = state !== undefined && 'field' in state ? state.binding : undefined;
  if (binding === undefined) {
    throw new Error('title is no state a setter writes.');
  }
  return binding;
}

/** An engine of the application's sessions, of a clock the test moves, with `operations`. */
function assertedEngine(setup: Setup, operations: Readonly<Record<string, unknown>>) {
  const now = { value: CLOCK.start };
  const engine = new Engine({
    buildId: BUILD,
    clock: () => now.value,
    database: databaseFor(setup),
    externalPollMs: 60_000,
    operations: { [MODULE]: operations },
    programs: [
      {
        buildId: BUILD,
        component: 'components/ids',
        evaluate: (_props, $: RenderScope) => $.h('p', null, 'shown'),
        protocolVersion: PROTOCOL_VERSION,
        updaters: {},
        writable: [],
      },
    ],
    sessions: 'asserted',
  });
  onTestFinished(async () => {
    await engine.close();
  });
  return { engine, now };
}

describe.each([
  ['without a tracked write', false],
  ['with a tracked write', true],
] as const)(
  'an asserted session whose assertion expires while the code runs, %s',
  (_name, writes) => {
    it(
      'answers the first receipt to a resend under a renewed assertion',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const setup = await inPglite();
        const gate = Promise.withResolvers<undefined>();
        const started = Promise.withResolvers<undefined>();
        let runs = 0;
        const { engine, now } = assertedEngine(setup, {
          slow: async (): Promise<string> => {
            runs += 1;
            if (writes) await setup.orm.insert(tasks).values({ id: 'w', title: 'written' });
            started.resolve(undefined);
            await gate.promise;
            return 'done';
          },
        });
        openedAtEnd(gate);
        const call = callOf('slow');

        const running = engine.operate(assertion(now.value + CLOCK.shortMs), call);
        await settled(started.promise);
        now.value += CLOCK.movedMs;
        gate.resolve(undefined);
        const first = await settled(running);
        const resent = await engine.operate(assertion(now.value + CLOCK.assertedMs), call);

        expect(first).toMatchObject({ deduplicated: false, result: 'done' });
        expect(resent).toStrictEqual({ ...first, deduplicated: true });
        expect(runs).toBe(1);
      },
    );
  },
);

describe('a demo session that ended while the code ran', () => {
  it(
    'writes no record of its operation, and its write lands',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await inPglite();
      const gate = Promise.withResolvers<undefined>();
      const started = Promise.withResolvers<undefined>();
      const { engine, session } = await engineOf(
        setup,
        (_props, $: RenderScope) => $.h('p', null, 'shown'),
        {
          [MODULE]: {
            late: async (): Promise<string> => {
              started.resolve(undefined);
              await gate.promise;
              await setup.orm.insert(tasks).values({ id: 'late', title: 'written' });
              return 'done';
            },
          },
        },
      );
      openedAtEnd(gate);
      const running = engine.operate(session, callOf('late'));
      await settled(started.promise);

      await within(engine.logout(session), WAIT.answeredMs);
      gate.resolve(undefined);
      const answered = await settled(running);
      const stats = await engine.stats();

      expect(answered).toMatchObject({ deduplicated: false, result: 'done' });
      expect(stats.operations).toBe(0);
      await expect(heldIds(setup)).resolves.toStrictEqual(['a', 'late']);
    },
  );
});

describe.each([
  ['PGlite', inPglite],
  ['a pg.Pool', inPool],
] as const)('a field update of an operation id a run is under way for, in %s', (_name, open) => {
  it(
    'waits for the run, is refused as another kind, and writes nothing',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await open();
      const started = Promise.withResolvers<undefined>();
      const gate = Promise.withResolvers<undefined>();
      const updaters: Readonly<Record<string, ProgramUpdater>> = {
        [SET_TITLE]: { keys: ['title'], kind: 'set' },
      };
      const db = followedDb(setup.follow);
      const { engine, rendered, session } = await engineOf(
        setup,
        (_props, $: RenderScope) => {
          return $.client({
            props: {},
            slots: {},
            states: { title: db.tasks.where(eq(tasks.id, 'a')).title },
          });
        },
        {
          [MODULE]: {
            slow: async (): Promise<string> => {
              started.resolve(undefined);
              await gate.promise;
              return 'done';
            },
          },
        },
        { updaters, writable: ['title'] },
      );
      openedAtEnd(gate);
      const binding = titleBinding((await rendered()).tree);
      const operationId = crypto.randomUUID();
      const running = engine.operate(session, callOf('slow', operationId));
      await settled(started.promise);

      const update = outcome(
        engine.update(session, { binding, operationId, updaterId: SET_TITLE, value: 'changed' }),
      );
      const early = await within(update, WAIT.blockedMs);
      gate.resolve(undefined);
      await settled(running);
      await wait(0);
      const refused = await settled(update);
      const rows = await rowsOf(setup, "SELECT title FROM tasks WHERE id = 'a'");

      expect(early).toBe('waiting');
      expect(refused).toMatchObject({ code: 'OPERATION_REUSED', status: 409 });
      expect(rows).toStrictEqual([{ title: 'one' }]);
    },
  );
});
