import { describe, expect, it } from 'vitest';

import type { OperationCall, RenderScope } from '../src/program.ts';
import { database, table, text as field } from '../src/server/schema.ts';
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
import { engineOf } from './support/drizzle.ts';
import { followInternals } from './support/follow-store.ts';

/**
 * A server operation of an application whose every table is external runs apart from the
 * authority's queue: a page's render is answered while the operation awaits the application's own
 * database, and a resend of its id waits for it. An application that declares a table the
 * authority holds keeps the operation in the queue.
 */

const BUILD = 'b_drizzle';
const MODULE = 'actions/apart';
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;
/**
 * How long the awaiting operation may run: past any render under load, short of the test's time.
 */
const AWAITED_MS = 15_000;
/** What `promise` was rejected with; a test fails when it was not. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was not rejected.');
}

/** The call of `name` of the test's module, under `operationId`. */
function callOf(name: string): OperationCall {
  return { args: [], build: BUILD, module: MODULE, name, operationId: crypto.randomUUID() };
}

/** An engine of `operations` whose render lists the ids of the tasks the database holds. */
async function listing(
  setup: Setup,
  operations: Readonly<Record<string, unknown>>,
  timeoutMs?: number,
) {
  return engineOf(
    setup,
    async (_props, $: RenderScope) => {
      const rows = await setup.orm.select().from(tasks).orderBy(tasks.id);
      return $.h('p', null, rows.map((row) => row.id).join(','));
    },
    { [MODULE]: operations },
    timeoutMs === undefined ? {} : { timeoutMs },
  );
}

/** Which settles first: the render, with what it shows, or the operation. */
async function firstOf<T>(
  rendered: Promise<T>,
  running: Promise<unknown>,
): Promise<'operation' | { readonly shown: T }> {
  const shown = async (): Promise<{ readonly shown: T }> => ({ shown: await rendered });
  const operation = async (): Promise<'operation'> => {
    await running;
    return 'operation';
  };
  return Promise.race([shown(), operation()]);
}

/** An operation that reads, tells the test, and awaits `gate` before it returns. */
function awaiting(setup: Setup, started: PromiseWithResolvers<undefined>, gate: Promise<void>) {
  return async (): Promise<string> => {
    await setup.orm.select().from(tasks);
    started.resolve(undefined);
    await gate;
    return 'done';
  };
}

describe.each([
  ['PGlite', inPglite],
  ['a pg.Pool', inPool],
] as const)('an operation apart from the queue in %s', (_name, open) => {
  it('answers a render while the operation awaits', { timeout: TEST_TIMEOUT_MS }, async () => {
    const setup = await open();
    const started = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    const { engine, render, session } = await listing(
      setup,
      { slow: awaiting(setup, started, gate.promise) },
      AWAITED_MS,
    );
    openedAtEnd(gate);
    const running = engine.operate(session, callOf('slow'));
    await settled(started.promise);

    // The gate opens only once the render answered: in the queue, the render waits for the
    // operation, which settles first, by its time.
    const first = await firstOf(render(), running);
    const counted = await engine.stats();
    gate.resolve(undefined);

    expect(first).toStrictEqual({ shown: 'a' });
    expect(counted).toMatchObject({ operations: 0 });
    await expect(settled(running)).resolves.toMatchObject({ deduplicated: false, result: 'done' });
  });

  it(
    'runs one operation id once when it is sent twice at once',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await open();
      const started = Promise.withResolvers<undefined>();
      const gate = Promise.withResolvers<undefined>();
      let runs = 0;
      const { engine, session } = await listing(setup, {
        once: async (): Promise<string> => {
          runs += 1;
          return awaiting(setup, started, gate.promise)();
        },
      });
      openedAtEnd(gate);
      const call = callOf('once');

      const first = engine.operate(session, call);
      await settled(started.promise);
      const second = engine.operate(session, call);
      await wait(WAIT.blockedMs);
      gate.resolve(undefined);
      const answers = await settled(Promise.all([first, second]));

      expect(runs).toBe(1);
      expect(answers[0]).toMatchObject({ deduplicated: false, result: 'done' });
      expect(answers[1]).toStrictEqual({ ...answers[0], deduplicated: true });
    },
  );

  it('answers a refusal once to both calls of one id', { timeout: TEST_TIMEOUT_MS }, async () => {
    const setup = await open();
    const started = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    let runs = 0;
    const { engine, session } = await listing(setup, {
      refused: async (): Promise<void> => {
        runs += 1;
        await awaiting(setup, started, gate.promise)();
        throw new Error('no room');
      },
    });
    openedAtEnd(gate);
    const call = callOf('refused');

    const first = rejection(engine.operate(session, call));
    await settled(started.promise);
    const second = rejection(engine.operate(session, call));
    await wait(WAIT.blockedMs);
    gate.resolve(undefined);

    await expect(settled(first)).resolves.toMatchObject({
      code: 'OPERATION_REJECTED',
      status: 422,
    });
    await expect(settled(second)).resolves.toMatchObject({
      code: 'OPERATION_REJECTED',
      status: 422,
    });
    expect(runs).toBe(1);
  });

  it(
    'answers a failure after a write once to both calls of one id',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await open();
      const written = Promise.withResolvers<undefined>();
      const gate = Promise.withResolvers<undefined>();
      let runs = 0;
      const { engine, session } = await listing(setup, {
        wrote: async (): Promise<void> => {
          runs += 1;
          await setup.orm.insert(tasks).values({ id: 'b', title: 'two' });
          written.resolve(undefined);
          await gate.promise;
          throw new Error('after writing');
        },
      });
      openedAtEnd(gate);
      const call = callOf('wrote');

      const first = rejection(engine.operate(session, call));
      await settled(written.promise);
      const second = rejection(engine.operate(session, call));
      await wait(WAIT.blockedMs);
      gate.resolve(undefined);

      await expect(settled(first)).resolves.toMatchObject({
        code: 'OPERATION_FAILED',
        status: 500,
      });
      await expect(settled(second)).resolves.toMatchObject({
        code: 'OPERATION_FAILED',
        status: 500,
      });
      expect(runs).toBe(1);
    },
  );

  it(
    'lets close wait for the operation and refuses a later call',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await open();
      const started = Promise.withResolvers<undefined>();
      const gate = Promise.withResolvers<undefined>();
      const { engine, session } = await listing(setup, {
        slow: awaiting(setup, started, gate.promise),
      });
      openedAtEnd(gate);
      const running = engine.operate(session, callOf('slow'));
      await settled(started.promise);

      const closing = engine.close();
      const refused = await rejection(engine.operate(session, callOf('slow')));
      const early = await within(closing, WAIT.blockedMs);
      gate.resolve(undefined);

      expect(early).toBe('waiting');
      expect(refused).toBeInstanceOf(Error);
      await expect(settled(running)).resolves.toMatchObject({ result: 'done' });

      await settled(closing);

      await expect(engine.operate(session, callOf('slow'))).rejects.toBeInstanceOf(Error);
    },
  );

  it(
    'answers a resend that was waiting when close began, and refuses a new id',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await open();
      const started = Promise.withResolvers<undefined>();
      const gate = Promise.withResolvers<undefined>();
      const { engine, session } = await listing(setup, {
        slow: awaiting(setup, started, gate.promise),
      });
      openedAtEnd(gate);
      const call = callOf('slow');
      const first = engine.operate(session, call);
      await settled(started.promise);
      const waiting = engine.operate(session, call);
      await wait(WAIT.blockedMs);

      const closing = engine.close();
      const fresh = await rejection(engine.operate(session, callOf('slow')));
      gate.resolve(undefined);
      const answers = [await settled(first), await settled(waiting)];
      await settled(closing);

      expect(fresh).toBeInstanceOf(Error);
      expect(answers[0]).toMatchObject({ deduplicated: false, result: 'done' });
      expect(answers[1]).toStrictEqual({ ...answers[0], deduplicated: true });
    },
  );

  it(
    'answers two closes at once, and keeps the answer of the operation under way',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await open();
      const started = Promise.withResolvers<undefined>();
      const gate = Promise.withResolvers<undefined>();
      const { engine, session } = await listing(setup, {
        slow: awaiting(setup, started, gate.promise),
      });
      openedAtEnd(gate);
      const running = engine.operate(session, callOf('slow'));
      await settled(started.promise);

      const closes = [engine.close(), engine.close()];
      gate.resolve(undefined);

      await expect(settled(Promise.all(closes))).resolves.toStrictEqual([undefined, undefined]);
      await expect(settled(running)).resolves.toMatchObject({
        deduplicated: false,
        result: 'done',
      });
    },
  );

  it(
    'answers the outcome of an operation whose session ended, and keeps nothing',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await open();
      const started = Promise.withResolvers<undefined>();
      const gate = Promise.withResolvers<undefined>();
      const { engine, session } = await listing(setup, {
        slow: awaiting(setup, started, gate.promise),
      });
      openedAtEnd(gate);
      const call = callOf('slow');
      const running = engine.operate(session, call);
      await settled(started.promise);

      const ended = await within(engine.logout(session), WAIT.answeredMs);
      gate.resolve(undefined);
      const answered = await settled(running);
      const stats = await engine.stats();
      const resent = await rejection(engine.operate(session, call));

      expect(ended).toBeUndefined();
      expect(answered).toMatchObject({ deduplicated: false, result: 'done' });
      expect(stats.operations).toBe(0);
      expect(resent).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    },
  );
});

describe.each([
  ['PGlite', inPglite],
  ['a pg.Pool over a PGlite server', inPool],
] as const)('what a render reads while an operation’s transaction is open in %s', (_name, open) => {
  it(
    'never reads the uncommitted row, and the row once it commits',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await open();
      const opened = Promise.withResolvers<undefined>();
      const gate = Promise.withResolvers<undefined>();
      const { engine, render, session } = await listing(setup, {
        inserting: async (): Promise<void> => {
          await setup.orm.transaction(async (tx) => {
            await tx.insert(tasks).values({ id: 'b', title: 'two' });
            opened.resolve(undefined);
            await gate.promise;
          });
        },
      });
      openedAtEnd(gate);
      const running = engine.operate(session, callOf('inserting'));
      await settled(opened.promise);

      // PGlite has one session: a query of another connection waits for the transaction, never
      // reading inside it.
      const shown = render();
      const early = await within(shown, WAIT.blockedMs);
      gate.resolve(undefined);
      await settled(running);

      expect(early).toBe('waiting');
      await expect(settled(shown)).resolves.toBe('a,b');
    },
  );
});

/**
 * The database of the followed tables and a table the authority holds, which no public form mixes:
 * declared of the follow's tables, and given its store (`databaseFor`).
 */
function held(setup: Setup) {
  const notes = table({ body: field({ maxLength: 64 }) });
  return database({ ...followInternals(setup.follow).tables, notes });
}

describe('an application that declares a table the authority holds', () => {
  it(
    'keeps the operation in the queue: a render waits for it',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const setup = await inPglite();
      const started = Promise.withResolvers<undefined>();
      const gate = Promise.withResolvers<undefined>();
      const { engine, render, session } = await engineOf(
        setup,
        (_props, $: RenderScope) => $.h('p', null, 'shown'),
        { [MODULE]: { slow: awaiting(setup, started, gate.promise) } },
        { database: held(setup) },
      );
      openedAtEnd(gate);
      const running = engine.operate(session, callOf('slow'));
      await settled(started.promise);

      const shown = render();
      const early = await within(shown, WAIT.blockedMs);
      gate.resolve(undefined);
      await settled(running);

      expect(early).toBe('waiting');
      await expect(settled(shown)).resolves.toBe('shown');
    },
  );
});
