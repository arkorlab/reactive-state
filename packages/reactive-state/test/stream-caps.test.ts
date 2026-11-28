import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AssertedSession } from '../src/asserted.ts';
import { Engine } from '../src/authority/index.ts';
import type { Watched } from '../src/authority/model.ts';
import {
  MAX_STREAMS,
  MAX_STREAMS_PER_SESSION,
  MAX_STREAMS_PER_USER,
} from '../src/authority/stream-admission.ts';
import type { SessionId } from '../src/client/contract.ts';
import { EventStreams } from '../src/cloudflare/stream.ts';
import type { RootRequest } from '../src/program.ts';
import { type PipedReader, pipedReader } from './support/piped-reader.ts';
import { application, BUILD } from './support/program.ts';

/** The caps on the event streams one authority holds, where a stream is admitted. */

const PAGE: RootRequest = {
  build: BUILD,
  component: 'components/project',
  props: { filter: 'all', projectId: 'p1', selectedId: 't1' },
};
const REFUSED = { code: 'TOO_MANY_STREAMS', status: 429 };
/** What a stream of the Durable Object's host says as it opens, and to say it is alive. */
const OPENING = ': open\n\n';
const HEARTBEAT = ': heartbeat\n\n';

function open(sessions: 'asserted' | 'demo' = 'demo'): Engine {
  const engine = new Engine({ ...application, sessions });
  onTestFinished(async () => {
    await engine.close();
  });
  return engine;
}

/** The `n`th admission of `session`, which a refusal throws. */
function admitAll(engine: Engine, session: SessionId, count: number): (() => void)[] {
  return Array.from({ length: count }, () => engine.admitStream(session));
}

/** A session of `user`'s that the application's server asserts under `key`, for an hour. */
function assertedOf(user: string, key: string): AssertedSession {
  return { expires: Date.now() + 3_600_000, id: key, user };
}

/**
 * `count` streams of `user`'s, admitted over sessions asserted for it — each of a key of its own,
 * `<user>-<n>`, holding as many as a session may — which a refusal throws.
 */
function admitUser(engine: Engine, user: string, count: number): (() => void)[] {
  const admitted: (() => void)[] = [];
  for (let held = 0; held < count; held += MAX_STREAMS_PER_SESSION) {
    const session = assertedOf(user, `${user}-${held.toString()}`);
    admitted.push(...admitAll(engine, session, Math.min(MAX_STREAMS_PER_SESSION, count - held)));
  }
  return admitted;
}

/** A session's page: the session, and the subscription its render of the page was issued with. */
interface Page {
  readonly session: SessionId;
  readonly subscription: string;
}

/** The page of `session` — a demo session of `user`'s, signed in here, unless given — rendered. */
async function pageOf(engine: Engine, user: string, session?: AssertedSession): Promise<Page> {
  const presented = session ?? (await engine.login(user)).sessionId;
  const { frame } = await engine.render(presented, PAGE);
  return { session: presented, subscription: frame.subscription };
}

/** A stream of `page`'s, opened through `streams`, whose reader has taken its opening comment. */
async function readerOf(streams: EventStreams, page: Page): Promise<PipedReader> {
  const reader = pipedReader(await streams.open(page.session, page.subscription));
  onTestFinished(async () => {
    await reader.stop();
  });
  await reader.opened;
  return reader;
}

/** `count` streams of `page`'s, each with its reader (`readerOf`). */
async function readersOf(streams: EventStreams, page: Page, count: number): Promise<PipedReader[]> {
  const readers: PipedReader[] = [];
  for (let opened = 0; opened < count; opened += 1) {
    readers.push(await readerOf(streams, page));
  }
  return readers;
}

/** What each reader has taken so far. */
function takenBy(readers: readonly PipedReader[]): (readonly string[])[] {
  return readers.map((reader) => [...reader.taken]);
}

/** `count` readers' worth of `taken`. */
function each(count: number, taken: readonly string[]): (readonly string[])[] {
  return Array.from({ length: count }, () => taken);
}

/** What `pending` was refused with, once it settles; `undefined` where it was fulfilled. */
async function refusalOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * `count` streams of `page`'s asked for at once, as a page of `count` live roots asks for them:
 * each admitted one's stream, which is cancelled as the test ends, or its refusal.
 */
async function together(streams: EventStreams, page: Page, count: number): Promise<unknown[]> {
  const answers = await Promise.allSettled(
    Array.from({ length: count }, async () => streams.open(page.session, page.subscription)),
  );
  return answers.map((answer): unknown => {
    if (answer.status === 'fulfilled') {
      const stream = answer.value;
      onTestFinished(async () => {
        await stream.cancel();
      });
      return stream;
    }
    return answer.reason as unknown;
  });
}

/** `count` streams of `page`'s, left unread: each gives its place back at once as it is cancelled. */
async function bodiesOf(
  streams: EventStreams,
  page: Page,
  count: number,
): Promise<ReadableStream<Uint8Array>[]> {
  const bodies: ReadableStream<Uint8Array>[] = [];
  for (let opened = 0; opened < count; opened += 1) {
    const body = await streams.open(page.session, page.subscription);
    onTestFinished(async () => {
      await body.cancel();
    });
    bodies.push(body);
  }
  return bodies;
}

/** A stream asked for: how it stands so far — waiting, admitted, or the code it was refused with. */
interface Asked {
  readonly state: () => string;
  readonly settled: Promise<unknown>;
}

/** `pending`, a stream asked for, followed as it settles (`Asked`). */
function followed(pending: Promise<ReadableStream<Uint8Array>>): Asked {
  const seen = { state: 'waiting' };
  const settled = (async (): Promise<unknown> => {
    try {
      const stream = await pending;
      seen.state = 'admitted';
      onTestFinished(async () => {
        await stream.cancel();
      });
      return stream;
    } catch (error) {
      seen.state = (error as { code?: string }).code ?? 'failed';
      return error;
    }
  })();
  return { settled, state: () => seen.state };
}

/**
 * The next `count` renders of a stream's root held until `resume`, as a root whose first render
 * reads a database over the network holds its stream's place while it waits.
 */
function holdRenders(
  engine: Engine,
  count: number,
): { readonly entered: Promise<undefined>; readonly resume: () => void } {
  const watch = engine.watch.bind(engine);
  const entered = Promise.withResolvers<undefined>();
  const held = Promise.withResolvers<undefined>();
  const spy = vi.spyOn(engine, 'watch');
  const waiting = { left: count };
  const holding = async (session: unknown, subscription: unknown): Promise<Watched> => {
    waiting.left -= 1;
    if (waiting.left === 0) {
      entered.resolve(undefined);
    }
    await held.promise;
    return watch(session, subscription);
  };
  for (let render = 0; render < count; render += 1) {
    spy.mockImplementationOnce(holding);
  }
  onTestFinished(() => {
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

describe('the caps on event streams', () => {
  it('admits a session its share of streams and refuses the next with 429', async () => {
    const engine = open();
    const { sessionId } = await engine.login('alice');

    admitAll(engine, sessionId, MAX_STREAMS_PER_SESSION);

    expect(() => engine.admitStream(sessionId)).toThrow(expect.objectContaining(REFUSED));
  });

  it('admits another once one is released, and a release counts once', async () => {
    const engine = open();
    const { sessionId } = await engine.login('alice');
    const [first, ...rest] = admitAll(engine, sessionId, MAX_STREAMS_PER_SESSION);

    first?.();
    first?.();
    rest[0]?.();
    engine.admitStream(sessionId);
    engine.admitStream(sessionId);

    expect(() => engine.admitStream(sessionId)).toThrow(expect.objectContaining(REFUSED));
  });

  it('leaves a second session unaffected', async () => {
    const engine = open();
    const alice = await engine.login('alice');
    const bob = await engine.login('bob');
    admitAll(engine, alice.sessionId, MAX_STREAMS_PER_SESSION);

    expect(() => engine.admitStream(bob.sessionId)).not.toThrow();
  });

  it('refuses a session that does not stand as the sign-in it needs, holding no place', () => {
    const engine = open();

    expect(() => engine.admitStream('nobody')).toThrow(expect.objectContaining({ status: 401 }));
  });

  it('refuses across sessions once the authority holds its total', async () => {
    const engine = open();
    const sessions: string[] = [];
    for (let held = 0; held < MAX_STREAMS; held += MAX_STREAMS_PER_SESSION) {
      const { sessionId } = await engine.login(held % 2 === 0 ? 'alice' : 'bob');
      sessions.push(sessionId);
      admitAll(engine, sessionId, MAX_STREAMS_PER_SESSION);
    }
    const another = await engine.login('alice');

    expect(() => engine.admitStream(another.sessionId)).toThrow(expect.objectContaining(REFUSED));
    expect(() => engine.admitStream(sessions[0] ?? '')).toThrow(expect.objectContaining(REFUSED));
  });
});

/**
 * A user of the application's own sessions holds its share over every session its server asserted
 * for it, so that one signing in again and again, each sign-in a key of its own, cannot hold the
 * authority's total.
 */
describe('the cap on a user’s streams', () => {
  it('admits a user its share over its sessions and refuses the next with 429', () => {
    const engine = open('asserted');
    admitUser(engine, 'alice', MAX_STREAMS_PER_USER);

    expect(() => engine.admitStream(assertedOf('alice', 'another'))).toThrow(
      expect.objectContaining(REFUSED),
    );
  });

  it('admits another user while one is at its cap', () => {
    const engine = open('asserted');
    admitUser(engine, 'alice', MAX_STREAMS_PER_USER);

    expect(admitUser(engine, 'bob', MAX_STREAMS_PER_USER)).toHaveLength(MAX_STREAMS_PER_USER);
  });

  it('gives the user’s place back as a stream closes, once', () => {
    const engine = open('asserted');
    const [first] = admitUser(engine, 'alice', MAX_STREAMS_PER_USER);
    const another = assertedOf('alice', 'another');

    first?.();
    first?.();
    engine.admitStream(another);

    expect(() => engine.admitStream(another)).toThrow(expect.objectContaining(REFUSED));
  });

  it('gives the user’s places back of every stream of a session that ends', async () => {
    const engine = open('asserted');
    const ending = await pageOf(engine, 'alice', assertedOf('alice', 'ending'));
    const streams = new EventStreams(engine);
    await readersOf(streams, ending, MAX_STREAMS_PER_SESSION);
    admitUser(engine, 'alice', MAX_STREAMS_PER_USER - MAX_STREAMS_PER_SESSION);
    const another = assertedOf('alice', 'another');

    expect(() => engine.admitStream(another)).toThrow(expect.objectContaining(REFUSED));

    await engine.endSession('ending');
    await vi.waitFor(() => {
      expect(streams.size).toBe(0);
    });

    expect(admitAll(engine, another, MAX_STREAMS_PER_SESSION)).toHaveLength(
      MAX_STREAMS_PER_SESSION,
    );
  });

  it('refuses at once a stream past its user’s cap of a session short of its own, writing to none', async () => {
    const engine = open('asserted');
    const alice = await pageOf(engine, 'alice', assertedOf('alice', 'page'));
    const streams = new EventStreams(engine);
    const readers = await readersOf(streams, alice, 2);
    admitUser(engine, 'alice', MAX_STREAMS_PER_USER - 2);

    await expect(streams.open(alice.session, alice.subscription)).rejects.toMatchObject(REFUSED);

    expect(takenBy(readers)).toStrictEqual(each(2, [OPENING]));
  });

  it('refuses across users once the authority holds its total', () => {
    const engine = open('asserted');
    for (let held = 0; held < MAX_STREAMS; held += MAX_STREAMS_PER_USER) {
      admitUser(engine, `user-${held.toString()}`, MAX_STREAMS_PER_USER);
    }

    expect(() => engine.admitStream(assertedOf('another', 'another'))).toThrow(
      expect.objectContaining(REFUSED),
    );
  });

  it('counts a demo session by no user, whom anybody may sign in as', async () => {
    const engine = open();
    const admitted: (() => void)[] = [];
    for (let held = 0; held <= MAX_STREAMS_PER_USER; held += MAX_STREAMS_PER_SESSION) {
      const { sessionId } = await engine.login('alice');
      admitted.push(...admitAll(engine, sessionId, MAX_STREAMS_PER_SESSION));
    }

    expect(admitted).toHaveLength(MAX_STREAMS_PER_USER + MAX_STREAMS_PER_SESSION);
  });
});

describe('the caps on the Durable Object host’s streams', () => {
  it('refuses the stream past the cap before it renders or listens, and frees a place as one ends', async () => {
    const engine = open();
    const { sessionId } = await engine.login('alice');
    const { frame } = await engine.render(sessionId, PAGE);
    const streams = new EventStreams(engine);
    const bodies: ReadableStream<Uint8Array>[] = [];
    for (let held = 0; held < MAX_STREAMS_PER_SESSION; held += 1) {
      bodies.push(await streams.open(sessionId, frame.subscription));
    }
    const listened = vi.spyOn(engine, 'onCommit');
    const watched = vi.spyOn(engine, 'watch');

    await expect(streams.open(sessionId, frame.subscription)).rejects.toMatchObject(REFUSED);
    expect(listened).not.toHaveBeenCalled();
    expect(watched).not.toHaveBeenCalled();
    expect(streams.size).toBe(MAX_STREAMS_PER_SESSION);

    await bodies[0]?.cancel();
    const next = await streams.open(sessionId, frame.subscription);
    await next.cancel();

    expect(listened).toHaveBeenCalledTimes(1);

    for (const body of bodies.slice(1)) {
      await body.cancel();
    }

    expect(streams.size).toBe(0);
  });

  it('frees the place of a stream whose first render is refused', async () => {
    const engine = open();
    const { sessionId } = await engine.login('alice');
    const streams = new EventStreams(engine);

    for (let tried = 0; tried <= MAX_STREAMS_PER_SESSION; tried += 1) {
      await expect(streams.open(sessionId, 'not-a-subscription')).rejects.toMatchObject({
        status: 403,
      });
    }
    const { frame } = await engine.render(sessionId, PAGE);

    await (await streams.open(sessionId, frame.subscription)).cancel();
  });
});

/**
 * On Cloudflare a browser that closes its event stream is not seen leaving by the Function that
 * proxies it: the object holds the stream's place until a write finds the reader gone. A stream
 * refused at its session's cap has each of the session's streams written a heartbeat first, and
 * waits, in line with every other refused meanwhile, as many as the session may hold, for places
 * given back, each asked for by the stream first in line alone. A reader that left is played
 * by a pipe whose next write fails, which cancels the stream only on the chunk after its opening
 * comment, as a Function's failed write to a browser that left does.
 */
describe('the Durable Object host’s writes to a session’s streams at its cap', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits the stream past the cap once a stream whose reader left unseen fails the heartbeat written to it', async () => {
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    const staying = await readersOf(streams, alice, MAX_STREAMS_PER_SESSION - 1);
    const leaving = await readerOf(streams, alice);
    leaving.leave();

    const next = pipedReader(await streams.open(alice.session, alice.subscription));
    onTestFinished(async () => {
      await next.stop();
    });
    await leaving.piped;
    await next.opened;

    expect(leaving.failed()).toBe(true);
    expect(leaving.taken).toStrictEqual([OPENING]);
    expect(takenBy(staying)).toStrictEqual(each(MAX_STREAMS_PER_SESSION - 1, [OPENING, HEARTBEAT]));
    expect(next.taken).toStrictEqual([OPENING]);
    expect(streams.size).toBe(MAX_STREAMS_PER_SESSION);
  });

  it('asks for the place once more as soon as a stream gives one back, before the wait is over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    await readersOf(streams, alice, MAX_STREAMS_PER_SESSION - 1);
    const leaving = await readerOf(streams, alice);
    leaving.leave();

    const opened = streams.open(alice.session, alice.subscription);
    await vi.advanceTimersByTimeAsync(299);
    const first = await Promise.race([opened, Promise.resolve('still waiting')]);

    expect(first).toBeInstanceOf(ReadableStream);

    await (await opened).cancel();
  });

  it('admits each of a page’s streams asked for at once while its session’s streams are written to', async () => {
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    const leaving = await readersOf(streams, alice, MAX_STREAMS_PER_SESSION);
    for (const reader of leaving) {
      reader.leave();
    }

    const answers = await together(streams, alice, 3);
    await Promise.all(leaving.map(async (reader) => reader.piped));

    expect(answers.map((answer) => answer instanceof ReadableStream)).toStrictEqual([
      true,
      true,
      true,
    ]);
    expect(leaving.every((reader) => reader.failed())).toBe(true);
    expect(streams.size).toBe(3);
  });

  it('refuses each of a page’s streams asked for at once where every stream is still read, writing to them once', async () => {
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    const readers = await readersOf(streams, alice, MAX_STREAMS_PER_SESSION);

    const answers = await together(streams, alice, 3);

    expect(answers).toMatchObject([REFUSED, REFUSED, REFUSED]);
    expect(takenBy(readers)).toStrictEqual(each(MAX_STREAMS_PER_SESSION, [OPENING, HEARTBEAT]));
  });

  it('writes to the session’s streams where streams still rendering for the first time hold its last places', async () => {
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    const leaving = await readersOf(streams, alice, MAX_STREAMS_PER_SESSION - 2);
    for (const reader of leaving) {
      reader.leave();
    }
    const renders = holdRenders(engine, 2);
    const rendering = together(streams, alice, 2);
    await renders.entered;

    const [third] = await together(streams, alice, 1);
    renders.resume();
    const answers = await rendering;

    expect(third).toBeInstanceOf(ReadableStream);
    expect(answers.map((answer) => answer instanceof ReadableStream)).toStrictEqual([true, true]);

    await Promise.all(leaving.map(async (reader) => reader.piped));

    expect(leaving.every((reader) => reader.failed())).toBe(true);
  });

  it('has a place given back asked for by the stream first in line alone, each admitted stream refused by its subscription giving its own back in turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    const [leaving] = await readersOf(streams, alice, MAX_STREAMS_PER_SESSION);
    const forged = `${alice.subscription}x`;
    const waiting = Array.from({ length: 4 }, async () =>
      refusalOf(streams.open(alice.session, forged)),
    );
    await vi.advanceTimersByTimeAsync(0);
    const asks = vi.spyOn(engine, 'admitStream');

    await leaving?.stop();
    await vi.advanceTimersByTimeAsync(299);
    const asked = asks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    const refusals = await Promise.all(waiting);

    // One ask a place given back: each stream asks once, is admitted, and gives its place back.
    expect(asked).toBe(4);
    expect(refusals.map((refused) => (refused as { code?: string }).code)).not.toContain(
      REFUSED.code,
    );
    expect(streams.size).toBe(MAX_STREAMS_PER_SESSION - 1);
  });

  it('admits the stream first in line for a place given back, and leaves the others waiting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    const [ending] = await bodiesOf(streams, alice, MAX_STREAMS_PER_SESSION);
    const line = Array.from({ length: 4 }, () =>
      followed(streams.open(alice.session, alice.subscription)),
    );
    await vi.advanceTimersByTimeAsync(0);

    await ending?.cancel();
    await vi.advanceTimersByTimeAsync(10);
    const early = line.map((asked) => asked.state());
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all(line.map(async (asked) => asked.settled));

    expect(early).toStrictEqual(['admitted', 'waiting', 'waiting', 'waiting']);
    expect(line.map((asked) => asked.state())).toStrictEqual([
      'admitted',
      REFUSED.code,
      REFUSED.code,
      REFUSED.code,
    ]);
  });

  it('has a stream woken for a place another took wait first in line for the next', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    const [taken, next] = await bodiesOf(streams, alice, MAX_STREAMS_PER_SESSION);
    const first = followed(streams.open(alice.session, alice.subscription));
    const second = followed(streams.open(alice.session, alice.subscription));
    await vi.advanceTimersByTimeAsync(0);

    // A place given back, and taken in the same run by a stream asked for then: `first` is woken
    // for it, and finds it taken.
    const cancelled = taken?.cancel();
    const direct = followed(streams.open(alice.session, alice.subscription));
    await cancelled;
    await vi.advanceTimersByTimeAsync(10);
    const afterTaken = [first.state(), second.state(), direct.state()];
    await next?.cancel();
    await vi.advanceTimersByTimeAsync(10);
    const afterNext = [first.state(), second.state()];
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([first.settled, second.settled, direct.settled]);

    expect(afterTaken).toStrictEqual(['waiting', 'waiting', 'admitted']);
    expect(afterNext).toStrictEqual(['admitted', 'waiting']);
    expect(second.state()).toBe(REFUSED.code);
  });

  it('hands a place on to the next in line where the stream woken for it is refused by its session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const engine = open('asserted');
    const now = Date.now();
    // One key, asserted twice: once about to expire, once for an hour.
    const asserted = { expires: now + 3_600_000, id: 'k1', user: 'alice' };
    const lasting = await pageOf(engine, 'alice', asserted);
    const expiring = await pageOf(engine, 'alice', { ...asserted, expires: now + 100 });
    const streams = new EventStreams(engine);
    const [ending] = await bodiesOf(streams, lasting, MAX_STREAMS_PER_SESSION);
    const expired = followed(streams.open(expiring.session, expiring.subscription));
    const waiting = followed(streams.open(lasting.session, lasting.subscription));
    await vi.advanceTimersByTimeAsync(150);

    await ending?.cancel();
    await vi.advanceTimersByTimeAsync(10);
    const afterRelease = [expired.state(), waiting.state()];
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([expired.settled, waiting.settled]);

    expect(afterRelease).toStrictEqual(['UNAUTHENTICATED', 'admitted']);
  });

  it('refuses at once a stream past as many waiting as the session may hold', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    await readersOf(streams, alice, MAX_STREAMS_PER_SESSION);
    const asked = MAX_STREAMS_PER_SESSION + 1;
    const settled = Array.from({ length: asked }, () => false);
    const answers = Array.from({ length: asked }, async (_, index) => {
      const refused = await refusalOf(streams.open(alice.session, alice.subscription));
      settled[index] = true;
      return refused;
    });

    await vi.advanceTimersByTimeAsync(299);
    const early = [...settled];
    await vi.advanceTimersByTimeAsync(1);

    expect(early).toStrictEqual([...Array.from({ length: asked - 1 }, () => false), true]);
    await expect(Promise.all(answers)).resolves.toMatchObject(
      Array.from({ length: asked }, () => REFUSED),
    );
  });

  it('refuses a stream waiting for places as its session is refused, once the session ends', async () => {
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    await readersOf(streams, alice, MAX_STREAMS_PER_SESSION);

    const waiting = refusalOf(streams.open(alice.session, alice.subscription));
    await engine.logout(alice.session);

    await expect(waiting).resolves.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('refuses the stream past the cap as before where every stream is still read, each written a heartbeat', async () => {
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    const readers = await readersOf(streams, alice, MAX_STREAMS_PER_SESSION);

    await expect(streams.open(alice.session, alice.subscription)).rejects.toMatchObject(REFUSED);

    expect(takenBy(readers)).toStrictEqual(each(MAX_STREAMS_PER_SESSION, [OPENING, HEARTBEAT]));
    expect(streams.size).toBe(MAX_STREAMS_PER_SESSION);
  });

  it('writes to a session’s streams once a second at most, however often it asks', async () => {
    const start = Date.now();
    vi.useFakeTimers({ now: start, toFake: ['Date'] });
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    const readers = await readersOf(streams, alice, MAX_STREAMS_PER_SESSION);

    const refusals = [await refusalOf(streams.open(alice.session, alice.subscription))];
    vi.setSystemTime(start + 999);
    refusals.push(await refusalOf(streams.open(alice.session, alice.subscription)));
    const within = takenBy(readers);
    vi.setSystemTime(start + 1000);
    refusals.push(await refusalOf(streams.open(alice.session, alice.subscription)));

    expect(refusals).toMatchObject([REFUSED, REFUSED, REFUSED]);
    expect(within).toStrictEqual(each(MAX_STREAMS_PER_SESSION, [OPENING, HEARTBEAT]));
    expect(takenBy(readers)).toStrictEqual(
      each(MAX_STREAMS_PER_SESSION, [OPENING, HEARTBEAT, HEARTBEAT]),
    );
  });

  it('writes nothing to another session’s streams, at its own cap too', async () => {
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const bob = await pageOf(engine, 'bob');
    const streams = new EventStreams(engine);
    const bobs = await readersOf(streams, bob, MAX_STREAMS_PER_SESSION);
    const alices = await readersOf(streams, alice, MAX_STREAMS_PER_SESSION);

    await expect(streams.open(alice.session, alice.subscription)).rejects.toMatchObject(REFUSED);

    expect(takenBy(alices)).toStrictEqual(each(MAX_STREAMS_PER_SESSION, [OPENING, HEARTBEAT]));
    expect(takenBy(bobs)).toStrictEqual(each(MAX_STREAMS_PER_SESSION, [OPENING]));
  });

  it('writes nothing where the authority holds its total and the session is short of its own cap', async () => {
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine);
    const readers = await readersOf(streams, alice, 2);
    for (let held = readers.length; held < MAX_STREAMS; held += MAX_STREAMS_PER_SESSION) {
      const { sessionId } = await engine.login('bob');
      admitAll(engine, sessionId, Math.min(MAX_STREAMS_PER_SESSION, MAX_STREAMS - held));
    }

    await expect(streams.open(alice.session, alice.subscription)).rejects.toMatchObject(REFUSED);

    expect(takenBy(readers)).toStrictEqual(each(2, [OPENING]));
  });

  it('counts an asserted session’s streams by its key, whatever expiry each was asserted with', async () => {
    const engine = open('asserted');
    const now = Date.now();
    const asserted = { expires: now + 3_600_000, id: 'k1', user: 'alice' };
    const sooner = await pageOf(engine, 'alice', asserted);
    const later = await pageOf(engine, 'alice', { ...asserted, expires: now + 7_200_000 });
    const another = await pageOf(engine, 'alice', { ...asserted, id: 'k2' });
    const streams = new EventStreams(engine);
    const half = MAX_STREAMS_PER_SESSION / 2;
    const keys = [
      ...(await readersOf(streams, sooner, half)),
      ...(await readersOf(streams, later, half)),
    ];
    const others = await readersOf(streams, another, 1);

    await expect(streams.open(sooner.session, sooner.subscription)).rejects.toMatchObject(REFUSED);

    expect(takenBy(keys)).toStrictEqual(each(MAX_STREAMS_PER_SESSION, [OPENING, HEARTBEAT]));
    expect(takenBy(others)).toStrictEqual([[OPENING]]);
  });

  it('says the next heartbeat an interval after the one written to find a reader gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const engine = open();
    const alice = await pageOf(engine, 'alice');
    const streams = new EventStreams(engine, 1000);
    const readers = await readersOf(streams, alice, MAX_STREAMS_PER_SESSION);
    await vi.advanceTimersByTimeAsync(600);
    const refused = refusalOf(streams.open(alice.session, alice.subscription));
    await vi.advanceTimersByTimeAsync(300);

    await expect(refused).resolves.toMatchObject(REFUSED);

    const probed = takenBy(readers);
    // Past the heartbeat the timer had due at 1000, and short of 1600, an interval after 600.
    await vi.advanceTimersByTimeAsync(650);
    const beforeDue = takenBy(readers);
    await vi.advanceTimersByTimeAsync(100);

    expect(probed).toStrictEqual(each(MAX_STREAMS_PER_SESSION, [OPENING, HEARTBEAT]));
    expect(beforeDue).toStrictEqual(probed);
    expect(takenBy(readers)).toStrictEqual(
      each(MAX_STREAMS_PER_SESSION, [OPENING, HEARTBEAT, HEARTBEAT]),
    );
  });
});
