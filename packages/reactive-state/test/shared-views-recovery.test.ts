import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import {
  type ComponentProgram,
  type Json,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../src/program.ts';
import {
  type GateAnswer,
  GENERATION_HEADER,
  type RouteRegistration,
  type SharedEvent,
} from '../src/routing.ts';
import { boolean, database, table, text } from '../src/server/index.ts';
import { bodyOf, follow } from './support/shared-fixture.ts';

/**
 * A shared view whose evaluation faults, and how it recovers: a view a commit changed is revoked
 * while it is undecided — its pages told it is denied, nothing it published answered again — and a
 * view a page follows is tried again behind a backoff, republished once the fault passes; a view no
 * commit changed since it was decided — kept before the authority started — is left as it was. And
 * a view whose next generation's artifacts the site failed to answer, which a page follows: tried
 * again behind the same backoff, and published once the site answers — or, given up while no page
 * followed it, made again as a page follows it once more. Against an application of its own: a note
 * every visitor is shown, whose root faults while the note says it is broken, or while the test says
 * so, and whose site answers 503 while the test says it is down.
 */

const NOTE = '/notes/[id]';
const NOTE_BUILD = 'b_recovery';
/** Past the first wait before a followed view whose evaluation faulted is tried again. */
const RETRIED_MS = 3000;

interface Notes {
  readonly engine: Engine;
  /** The gate's answer to a request for the note `n1`. */
  readonly ask: () => Promise<GateAnswer>;
  /** The token of the view a page of the note holds, as its render handed it. */
  readonly token: () => Promise<string>;
  /** Marks the note `n1` broken, or mended, as Alice. */
  readonly setBroken: (broken: boolean) => Promise<void>;
  /** Writes the note `n1`'s body, as Alice. */
  readonly setBody: (body: string) => Promise<void>;
  /** Writes the note `n2`'s body, as Alice: nothing the view of the note `n1` reads. */
  readonly setOther: (body: string) => Promise<void>;
  /** An operation that holds the authority's queue until `queueHeld.until` settles. */
  readonly hold: () => Promise<void>;
  /** Signs Alice in again, for the operations from now on: her session lasts a day. */
  readonly signIn: () => Promise<void>;
  /** Closes the engine, once: when the test finishes, unless the test closed it before. */
  readonly close: () => Promise<void>;
}

/** Whether the note's root faults whatever the note says: what a test turns on and off. */
const failing = { now: false };
/** Whether the site answers every page 503: what a test turns on and off. */
const siteDown = { now: false };
/**
 * What the operation `hold` says as it starts, and what it waits for, the queue held meanwhile: what
 * a test sets.
 */
const queueHeld: { entered: () => void; until: Promise<unknown> } = {
  entered: () => {
    // Nothing waits for it unless a test does.
  },
  until: Promise.resolve(),
};
/** A day, by the authority's clock: past what it keeps a view nobody asks for. */
const DAY_MS = 86_400_000;

/**
 * The application, over `filename` where given, by `clock` where given, its site rendering the
 * note's page.
 */
async function notes(
  options: { readonly filename?: string; readonly clock?: () => number } = {},
): Promise<Notes> {
  const { clock, filename } = options;
  const db = database(
    { notes: table({ body: text({ maxLength: 200 }), broken: boolean() }) },
    {
      seed: {
        notes: { n1: { body: 'hello', broken: false }, n2: { body: 'other', broken: false } },
      },
    },
  );
  const note: ComponentProgram = {
    buildId: NOTE_BUILD,
    component: 'components/note',
    evaluate: async (props: Readonly<Record<string, unknown>>, $: RenderScope) => {
      const found = await db.notes.get(String(props['id']));
      if (failing.now || found?.broken === true) {
        throw new Error('The note cannot be shown.');
      }
      return $.h('p', null, found?.body ?? 'none');
    },
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: [],
  };
  const route: RouteRegistration = {
    blocking: true,
    middleware: [],
    page: 'notes/[id]/page.tsx',
    params: ['id'],
    props: { id: 'id' },
    root: note.component,
    route: NOTE,
    shared: true,
  };
  const engine = new Engine({
    buildId: NOTE_BUILD,
    ...(clock !== undefined && { clock }),
    database: db,
    ...(filename !== undefined && { filename }),
    operations: {
      'actions/notes': {
        async hold(): Promise<void> {
          queueHeld.entered();
          await queueHeld.until;
        },
        async setBroken(broken: unknown): Promise<void> {
          await db.transaction(async () => {
            await db.notes.update('n1', { broken: broken === true });
          });
        },
        async setBody(body: unknown): Promise<void> {
          await db.transaction(async () => {
            await db.notes.update('n1', { body: String(body) });
          });
        },
        async setOther(body: unknown): Promise<void> {
          await db.transaction(async () => {
            await db.notes.update('n2', { body: String(body) });
          });
        },
      },
    },
    programs: [note],
    routes: [route],
  });
  let closed: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    closed ??= engine.close();
    await closed;
  };
  onTestFinished(close);
  engine.site(async (_path, headers) => {
    if (siteDown.now) {
      return new Response(null, { status: 503 });
    }
    const answer = await engine.renderShared(null, {
      build: NOTE_BUILD,
      generation: headers[GENERATION_HEADER],
      props: { id: 'n1' },
      route: NOTE,
    });
    return Response.json(answer.result.tree, {
      headers: { 'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html' },
    });
  });
  let { sessionId } = await engine.login('alice');
  let operations = 0;
  const operate = async (name: string, value: Json): Promise<void> => {
    operations += 1;
    await engine.operate(sessionId, {
      args: [{ json: value }],
      build: NOTE_BUILD,
      module: 'actions/notes',
      name,
      operationId: `${name}-${String(operations)}`,
    });
  };
  return {
    ask: async () => engine.gate({ headers: {}, method: 'GET', route: NOTE, url: '/notes/n1' }),
    close,
    engine,
    hold: async () => {
      await operate('hold', null);
    },
    setBody: async (body) => {
      await operate('setBody', body);
    },
    setBroken: async (broken) => {
      await operate('setBroken', broken);
    },
    setOther: async (body) => {
      await operate('setOther', body);
    },
    signIn: async () => {
      ({ sessionId } = await engine.login('alice'));
    },
    token: async () => {
      const shown = await engine.renderShared(null, {
        build: NOTE_BUILD,
        props: { id: 'n1' },
        route: NOTE,
      });
      return shown.kind === 'shared' ? shown.view.token : '';
    },
  };
}

/** Keeps the authority's log of what faulted out of the output, for the rest of the test. */
function silenced(): void {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {
    // What the authority logs of a view it could not evaluate, kept out of the output.
  });
  onTestFinished(() => {
    logged.mockRestore();
    failing.now = false;
    siteDown.now = false;
  });
}

/** A file in a directory of the test's own under the system's, removed when the test finishes. */
async function databaseFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-recovery-'));
  onTestFinished(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  return path.join(dir, 'authority.sqlite');
}

describe('a shared view whose evaluation faults', () => {
  it('revokes it once a commit changed what it read, and republishes it once the fault passes', async () => {
    silenced();
    const { ask, engine, setBroken, token } = await notes();

    await expect(ask()).resolves.toMatchObject({ status: 200 });

    const heard = await follow(engine, await token());

    // A commit whose view now faults: the page told at once, and nothing it held answered again.
    await setBroken(true);

    await expect
      .poll(() => heard)
      .toStrictEqual([
        { epoch: 1, generation: 1, kind: 'ready' },
        { epoch: 2, kind: 'denied' },
      ]);
    await expect(ask()).resolves.toMatchObject({ status: 503 });

    // The fault passes: tried again with nobody asking, its page told of what it shows now.
    await setBroken(false);

    await expect
      .poll(() => heard, { timeout: RETRIED_MS })
      .toStrictEqual([
        { epoch: 1, generation: 1, kind: 'ready' },
        { epoch: 2, kind: 'denied' },
        { epoch: 2, generation: 2, kind: 'ready' },
      ]);

    const answer = await ask();

    expect(answer).toMatchObject({ status: 200 });
    expect(bodyOf(answer)).toContain('hello');
  });

  it('leaves a view kept before the authority started, unchanged since, as it was decided', async () => {
    silenced();
    const filename = await databaseFile();
    const first = await notes({ filename });

    await expect(first.ask()).resolves.toMatchObject({ status: 200 });

    const token = await first.token();
    await first.close();
    // Started again, its view's code faults for a while: a page following it is told nothing.
    failing.now = true;
    const reopened = await notes({ filename });
    const heard = await follow(reopened.engine, token);

    await expect
      .poll(async () => (await reopened.engine.stats()).sharedEvaluations)
      .toBeGreaterThan(0);
    expect(heard).toStrictEqual([]);

    failing.now = false;

    await expect
      .poll(async () => (await reopened.ask()).kind === 'respond', { timeout: RETRIED_MS })
      .toBe(true);
    await expect(reopened.ask()).resolves.toMatchObject({ status: 200 });
    expect(heard).toStrictEqual([]);
  });

  it('revokes a view kept before the authority started once a commit since changed what it read and its evaluation faults', async () => {
    silenced();
    const filename = await databaseFile();
    const first = await notes({ filename });

    await expect(first.ask()).resolves.toMatchObject({ status: 200 });

    const token = await first.token();
    await first.close();
    // Started again, a commit changes what the kept view read, and its code faults on it: a page
    // that follows it with the token it held is told it is denied.
    const reopened = await notes({ filename });
    await reopened.setBroken(true);
    const heard = await follow(reopened.engine, token);

    await expect.poll(() => heard).toStrictEqual([{ epoch: 2, kind: 'denied' }]);
    await expect(reopened.ask()).resolves.toMatchObject({ status: 503 });

    // The fault passes: tried again with nobody asking, its page told of what it shows now.
    await reopened.setBroken(false);

    await expect
      .poll(() => heard, { timeout: RETRIED_MS })
      .toStrictEqual([
        { epoch: 2, kind: 'denied' },
        { epoch: 2, generation: 2, kind: 'ready' },
      ]);
  });

  it('leaves a view kept before the authority started as it was decided after a commit of nothing it read', async () => {
    silenced();
    const filename = await databaseFile();
    const first = await notes({ filename });

    await expect(first.ask()).resolves.toMatchObject({ status: 200 });

    const token = await first.token();
    await first.close();
    // Started again, another note's commit, and the view's code faults for a while: its page is
    // told nothing, as of a view no commit changed since.
    failing.now = true;
    const reopened = await notes({ filename });
    await reopened.setOther('changed');
    const heard = await follow(reopened.engine, token);

    await expect
      .poll(async () => (await reopened.engine.stats()).sharedEvaluations)
      .toBeGreaterThan(0);
    expect(heard).toStrictEqual([]);

    failing.now = false;

    await expect
      .poll(async () => (await reopened.ask()).kind === 'respond', { timeout: RETRIED_MS })
      .toBe(true);
    await expect(reopened.ask()).resolves.toMatchObject({ status: 200 });
    expect(heard).toStrictEqual([]);
  });
});

/** Waits `ms` on a timer. */
async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Past the first wait before a followed view whose evaluation faulted is tried again, and its tries. */
const RETRY_PASSED_MS = 2000;
/** Past the wait before a view a commit made dirty is evaluated again. */
const SETTLE_PASSED_MS = 50;

describe('a shared view whose next generation’s artifacts the site failed to answer', () => {
  it('is tried again behind a backoff while a page follows it, and published once the site answers', async () => {
    silenced();
    const { ask, engine, setBody, token } = await notes();

    await expect(ask()).resolves.toMatchObject({ status: 200 });

    const heard = await follow(engine, await token());

    // A commit the view shows, whose generation the site fails to answer, every attempt.
    siteDown.now = true;
    const failed = (await engine.stats()).generationFailures;
    await setBody('again');

    await expect.poll(async () => (await engine.stats()).generationFailures).toBe(failed + 3);

    // The site answers again: the view tried again with nobody asking, its page told of it.
    siteDown.now = false;

    await expect
      .poll(() => heard, { timeout: RETRIED_MS })
      .toStrictEqual([
        { epoch: 1, generation: 1, kind: 'ready' },
        { epoch: 1, generation: 2, kind: 'ready' },
      ]);
    expect(bodyOf(await ask())).toContain('again');
  });

  it('is made again as its page follows it once more, given up while no page followed it', async () => {
    silenced();
    const { ask, engine, setBody, token } = await notes();

    await expect(ask()).resolves.toMatchObject({ status: 200 });

    // A page that followed the note lets go of it — its stream closed — before a commit the view
    // shows, whose generation the site fails to answer, every attempt: given up, with no page
    // following it to try it again for.
    const held = await token();
    (await engine.followShared(held)).stop();
    siteDown.now = true;
    const failed = (await engine.stats()).generationFailures;
    await setBody('again');

    await expect.poll(async () => (await engine.stats()).generationFailures).toBe(failed + 3);

    // What the job does as it gives up done with, the site answers again; the page follows the
    // view once more, with the token it held: the generation made, nobody asking for the note.
    await pause(SETTLE_PASSED_MS);
    siteDown.now = false;
    const heard = await follow(engine, held);

    await expect
      .poll(() => heard, { timeout: RETRIED_MS })
      .toStrictEqual([{ epoch: 1, generation: 2, kind: 'ready' }]);
    expect(bodyOf(await ask())).toContain('again');
  });
});

describe('a shared view let go of', () => {
  it('lets go of the retry behind its fault with it, never trying it in place of the view taken in under its key after it', async () => {
    silenced();
    const clock = { now: Date.UTC(2026, 9, 17) };
    const { ask, engine, setBody, token } = await notes({ clock: () => clock.now });

    await expect(ask()).resolves.toMatchObject({ status: 200 });

    // A page follows the note while a commit has its view fault: to be tried again behind a
    // backoff — which its page stops following before, and which nobody asks for in a day.
    const following = await engine.followShared(await token());
    const heard: SharedEvent[] = [];
    const stop = following.listen((event) => {
      heard.push(event);
    });
    failing.now = true;
    await setBody('again');

    await expect.poll(() => heard).toStrictEqual([{ epoch: 2, kind: 'denied' }]);

    stop();
    failing.now = false;
    clock.now += 2 * DAY_MS;

    // Asked for, and followed, again: a view of its own, under the same key.
    await expect(ask()).resolves.toMatchObject({ status: 200 });

    const again = await follow(engine, await token());
    const before = await engine.stats();
    await pause(RETRY_PASSED_MS);
    const after = await engine.stats();

    expect(after.sharedEvaluations).toBe(before.sharedEvaluations);
    expect(after.generationFailures).toBe(before.generationFailures);
    expect(again).toStrictEqual([{ epoch: 3, generation: 1, kind: 'ready' }]);
  });

  it('tries the view taken in under the key of one let go of with its retry waiting again behind a backoff of its own', async () => {
    silenced();
    const clock = { now: Date.UTC(2026, 9, 17) };
    const { ask, engine, setBody, signIn, token } = await notes({ clock: () => clock.now });

    await expect(ask()).resolves.toMatchObject({ status: 200 });

    // As above: a fault behind a commit, its retry waiting, the page gone, a day on.
    const following = await engine.followShared(await token());
    const heard: SharedEvent[] = [];
    const stop = following.listen((event) => {
      heard.push(event);
    });
    failing.now = true;
    await setBody('again');

    await expect.poll(() => heard).toStrictEqual([{ epoch: 2, kind: 'denied' }]);

    stop();
    failing.now = false;
    clock.now += 2 * DAY_MS;

    await expect(ask()).resolves.toMatchObject({ status: 200 });

    // The view taken in under its key, followed, faults in turn: tried again once the fault passes.
    const again = await follow(engine, await token());
    await signIn();
    failing.now = true;
    await setBody('once more');

    await expect.poll(() => again.map(({ kind }) => kind)).toStrictEqual(['ready', 'denied']);

    failing.now = false;

    await expect
      .poll(() => again.map(({ kind }) => kind), { timeout: RETRIED_MS })
      .toStrictEqual(['ready', 'denied', 'ready']);
  });

  it('evaluates no view it let go of while its evaluation waited in the queue, nor makes its artifacts in place of the one its key holds after it', async () => {
    silenced();
    const clock = { now: Date.UTC(2026, 9, 17) };
    const { ask, hold, setBody } = await notes({ clock: () => clock.now });

    await expect(ask()).resolves.toMatchObject({ status: 200 });

    // A commit has the view evaluated again shortly, with the queue held meanwhile, a day on; a
    // request of the note waits behind it, and the evaluation behind that, once its time comes.
    await setBody('again');
    const { promise: released, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: entered, resolve: enter } = Promise.withResolvers<undefined>();
    Object.assign(queueHeld, {
      entered: () => {
        enter(undefined);
      },
      until: released,
    });
    const holding = hold();
    await entered;
    clock.now += 2 * DAY_MS;
    const asking = ask();
    await pause(SETTLE_PASSED_MS);
    release(undefined);
    await holding;
    const answer = await asking;

    expect(answer).toMatchObject({ kind: 'respond', status: 200 });
    expect(bodyOf(answer)).toContain('again');
  });
});
