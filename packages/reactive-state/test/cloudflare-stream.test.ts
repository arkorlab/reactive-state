import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AssertedSession } from '../src/asserted.ts';
import { refusal } from '../src/authority/errors.ts';
import { Engine } from '../src/authority/index.ts';
import type { Watched } from '../src/authority/model.ts';
import { ASSERTED } from '../src/authority/sessions.ts';
import { EventStreams } from '../src/cloudflare/stream.ts';
import type { RootRequest } from '../src/program.ts';
import { type EventReader, readEvents } from './support/event-stream.ts';
import { application, BUILD } from './support/program.ts';

const START = 1_000_000;
const LIFETIME_MS = 60_000;
const PAGE: RootRequest = {
  build: BUILD,
  component: 'components/project',
  props: { filter: 'all', projectId: 'p1', selectedId: 't1' },
};

interface Opened {
  readonly engine: Engine;
  readonly session: AssertedSession;
  readonly events: EventReader;
  readonly streams: EventStreams;
  readonly cleanups: Set<() => void>;
  readonly setTime: (now: number) => void;
}

/** An asserted stream on the same explicit clock as its real authority. */
async function open(
  options: { readonly expiryLagMs?: number; readonly lifetimeMs?: number } = {},
): Promise<Opened> {
  let now = START;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const engine = new Engine({ ...application, clock: () => now, sessions: 'asserted' });
  const cleanups = new Set<() => void>();
  const cancellations = new Set<() => Promise<void>>();
  onTestFinished(async () => {
    try {
      for (const cleanup of cleanups) cleanup();
      for (const cancel of cancellations) await cancel();
    } finally {
      try {
        await engine.close();
      } finally {
        clock.mockRestore();
      }
    }
  });
  const session = {
    expires: START + (options.lifetimeMs ?? LIFETIME_MS),
    id: 'stream',
    user: 'alice',
  };
  const rendered = await engine.render(session, PAGE);
  const expiresIn = engine.expiresIn.bind(engine);
  const expiry = vi.spyOn(engine, 'expiresIn').mockImplementationOnce(async (presented) => {
    const remaining = await expiresIn(presented);
    now += options.expiryLagMs ?? 0;
    return remaining;
  });
  cleanups.add(() => {
    expiry.mockRestore();
  });
  const streams = new EventStreams(engine);
  const events = readEvents(new Response(await streams.open(session, rendered.frame.subscription)));
  cancellations.add(async () => {
    await events.cancel();
  });
  return {
    cleanups,
    engine,
    events,
    session,
    setTime: (time) => {
      now = time;
    },
    streams,
  };
}

/** The next watch held before its read, after its read, or before a refusal. */
function holdWatch(opened: Opened, answer: 'live' | 'captured' | Error) {
  const entered = Promise.withResolvers<undefined>();
  const held = Promise.withResolvers<undefined>();
  const watch = opened.engine.watch.bind(opened.engine);
  const spy = vi
    .spyOn(opened.engine, 'watch')
    .mockImplementationOnce(async (session, subscription) => {
      let captured: Watched | undefined;
      if (answer === 'captured') captured = await watch(session, subscription);
      entered.resolve(undefined);
      await held.promise;
      if (answer instanceof Error) throw answer;
      return captured ?? watch(session, subscription);
    });
  opened.cleanups.add(() => {
    held.resolve(undefined);
    spy.mockRestore();
  });
  return {
    entered: entered.promise,
    resume: () => {
      held.resolve(undefined);
    },
  };
}

/** A real commit to records the project's root read. */
async function change(opened: Opened): Promise<void> {
  await opened.engine.operate(opened.session, {
    args: [{ json: 'p1' }],
    build: BUILD,
    module: 'actions/todos',
    name: 'completeProject',
    operationId: 'complete-project',
  });
}

/** The end of the stream and the release of its following. */
async function closed(opened: Opened): Promise<void> {
  await expect(opened.events.next()).rejects.toThrow('The event stream ended.');
  expect(opened.streams.size).toBe(0);
}

describe('asserted streams across a pending watch', () => {
  it('renews when a pending watch reads the session at its exact absolute expiry', async () => {
    const opened = await open();
    const held = holdWatch(opened, 'live');
    const next = opened.events.next();
    await change(opened);
    await held.entered;
    opened.setTime(opened.session.expires);
    held.resume();

    await expect(next).resolves.toStrictEqual({ data: {}, event: 'renew' });

    await closed(opened);
  });

  it.each([
    { timing: 'an immediate expiry result', expiryLagMs: 0 },
    { timing: 'a delayed expiry result', expiryLagMs: 1 },
  ])('renews instead of sending a completed render with $timing', async ({ expiryLagMs }) => {
    const opened = await open({ expiryLagMs });
    const held = holdWatch(opened, 'captured');
    const next = opened.events.next();
    await change(opened);
    await held.entered;
    opened.setTime(opened.session.expires);
    held.resume();

    await expect(next).resolves.toStrictEqual({ data: {}, event: 'renew' });

    await closed(opened);
  });

  it('renews at the reassertion deadline even while its asserted session still lasts', async () => {
    const opened = await open({ lifetimeMs: ASSERTED.reassertMs * 2 });
    const held = holdWatch(opened, 'captured');
    const next = opened.events.next();
    await change(opened);
    await held.entered;
    opened.setTime(START + ASSERTED.reassertMs);
    held.resume();

    await expect(next).resolves.toStrictEqual({ data: {}, event: 'renew' });

    await closed(opened);
  });

  it('revokes a session whose key is ended before its expiry', async () => {
    const opened = await open();
    const next = opened.events.next();
    await opened.engine.endSession(opened.session.id);

    await expect(next).resolves.toStrictEqual({
      data: { code: 'UNAUTHENTICATED', error: 'Sign in first.' },
      event: 'revoked',
    });

    await closed(opened);
  });

  it('renews a forbidden refusal once the session expires during the watch', async () => {
    const opened = await open();
    const held = holdWatch(opened, refusal(403, 'FORBIDDEN', 'Wrong subscription.'));
    const next = opened.events.next();
    await change(opened);
    await held.entered;
    opened.setTime(opened.session.expires);
    held.resume();

    await expect(next).resolves.toStrictEqual({ data: {}, event: 'renew' });

    await closed(opened);
  });

  it('retains a forbidden refusal while the session still lasts', async () => {
    const opened = await open();
    const held = holdWatch(opened, refusal(403, 'FORBIDDEN', 'Wrong subscription.'));
    const next = opened.events.next();
    await change(opened);
    await held.entered;
    held.resume();

    await expect(next).resolves.toStrictEqual({
      data: { code: 'FORBIDDEN', error: 'Wrong subscription.' },
      event: 'revoked',
    });

    await closed(opened);
  });

  it.each([
    { kind: 'an application fault', error: new Error('broken') },
    { kind: 'a build mismatch', error: refusal(409, 'BUILD_MISMATCH', 'Reload the page.') },
  ])('ends without an event for $kind even after expiry', async ({ error }) => {
    const opened = await open();
    const held = holdWatch(opened, error);
    const next = opened.events.next();
    await change(opened);
    await held.entered;
    opened.setTime(opened.session.expires);
    held.resume();

    await expect(next).rejects.toThrow('The event stream ended.');
    expect(opened.streams.size).toBe(0);
  });
});
