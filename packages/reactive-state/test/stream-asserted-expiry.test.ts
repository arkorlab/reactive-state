import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssertedSession } from '../src/asserted.ts';
import type { AuthorityEngine as Engine } from '../src/authority/engine.ts';
import { refusal } from '../src/authority/errors.ts';
import type { CommitEvent, Watched } from '../src/authority/model.ts';
import { openEventStream } from '../src/authority/sse.ts';
import type { SessionId } from '../src/client/contract.ts';
import { EventStreams } from '../src/cloudflare/stream.ts';

/**
 * A stream of an asserted session says `renew` at its session's expiry, and `revoked` only when the
 * session ended: the page opens a renewed stream again through the application's route, which asks
 * the application whether its session still stands. A render of the root waits in the engine's
 * queue, which every request of the authority joins, so one a commit asked for can run after the
 * session has expired, and the engine then refuses it the session as it refuses an ended one. The
 * stream must tell the two apart by the time: a refusal after the session's own expiry is the
 * expiry's. That time is the session's `expires`, which the engine compares with its clock, and not
 * the `expiresIn` the stream is opened with: the engine samples that earlier than the stream opens,
 * so it adds the time that passed between to the clock, and ends later than the session does.
 * Here the engine's refusal is made to come after the expiry by moving the clock as the render
 * runs, and the clock moves between the sampling and the stream's opening, in place of the load
 * that makes both happen in a run of the Durable Object's suites (`cloudflare/asserted.test.ts`).
 */

/** When the session the application's server asserts expires, the clock being at zero as it opens. */
const EXPIRES_AT = 500;
const READ = 'todos:t1';
const SIGNED_OUT = 'Sign in first.';

/** What the root's render shows, which depends on `READ` alone. */
const SHOWN: Watched = {
  dependsOn: (event) => event.changed.includes(READ),
  digest: 'shown',
  issued: 'shown',
  revision: 0,
};

/** The session the application's server asserts, which the engine samples 500 ms from its end. */
const ASSERTED: AssertedSession = { expires: EXPIRES_AT, id: 'k1', user: 'alice' };
/** One that lasts long after the page's first renewal, which the engine's `expiresIn` ends at. */
const LONG: AssertedSession = { expires: 10_000, id: 'k2', user: 'alice' };
/** A session the demo's sign-in opened, which is a bare id. */
const DEMO = 'demo-session';

interface Row {
  readonly id: string;
  readonly session: SessionId;
  /** What the engine samples as `expiresIn` at the clock's zero: how long the stream has. */
  readonly lasts: number;
  /** How far the clock moves between that sampling and the stream's opening. */
  readonly drift: number;
  /** Where the clock stands as the render the engine refuses runs. */
  readonly at: number;
  readonly failure: Error;
  /** The events the stream says after it opens, by name, and what each carries. */
  readonly said: readonly { readonly data: unknown; readonly event: string }[];
}

const unauthenticated = (): Error => refusal(401, 'UNAUTHENTICATED', SIGNED_OUT);
const revoked = { code: 'UNAUTHENTICATED', error: SIGNED_OUT };

const ROWS: readonly Row[] = [
  {
    at: 1500,
    drift: 0,
    failure: unauthenticated(),
    id: 'an asserted session refused after its expiry is renewed',
    lasts: EXPIRES_AT,
    said: [{ data: {}, event: 'renew' }],
    session: ASSERTED,
  },
  {
    at: EXPIRES_AT,
    drift: 0,
    failure: unauthenticated(),
    id: 'an asserted session refused at the instant it expires is renewed',
    lasts: EXPIRES_AT,
    said: [{ data: {}, event: 'renew' }],
    session: ASSERTED,
  },
  {
    at: 1500,
    drift: 0,
    failure: refusal(403, 'FORBIDDEN', 'Not allowed.'),
    id: 'an asserted session refused with a forbidding status after its expiry is renewed',
    lasts: EXPIRES_AT,
    said: [{ data: {}, event: 'renew' }],
    session: ASSERTED,
  },
  {
    // The stream opens 5 ms after the engine sampled `expiresIn`, so its own deadline is 505.
    at: EXPIRES_AT + 1,
    drift: 5,
    failure: unauthenticated(),
    id: 'an asserted session refused just after it expires, before its stream’s own deadline, is renewed',
    lasts: EXPIRES_AT,
    said: [{ data: {}, event: 'renew' }],
    session: ASSERTED,
  },
  {
    at: EXPIRES_AT - 1,
    drift: 5,
    failure: unauthenticated(),
    id: 'an asserted session refused just before it expires has ended, and is revoked',
    lasts: EXPIRES_AT,
    said: [{ data: revoked, event: 'revoked' }],
    session: ASSERTED,
  },
  {
    at: 0,
    drift: 0,
    failure: unauthenticated(),
    id: 'an asserted session refused long before its expiry has ended, and is revoked',
    lasts: EXPIRES_AT,
    said: [{ data: revoked, event: 'revoked' }],
    session: ASSERTED,
  },
  {
    // Its stream is to be renewed at 500, to ask the application again; the session ends at 10 000.
    at: 600,
    drift: 0,
    failure: unauthenticated(),
    id: 'an asserted session refused past its stream’s deadline but before its own expiry has ended, and is revoked',
    lasts: EXPIRES_AT,
    said: [{ data: revoked, event: 'revoked' }],
    session: LONG,
  },
  {
    at: 1500,
    drift: 0,
    failure: unauthenticated(),
    id: 'a demo session refused after its expiry is revoked, as it was',
    lasts: EXPIRES_AT,
    said: [{ data: revoked, event: 'revoked' }],
    session: DEMO,
  },
  {
    at: 0,
    drift: 0,
    failure: unauthenticated(),
    id: 'a demo session refused before its expiry is revoked',
    lasts: EXPIRES_AT,
    said: [{ data: revoked, event: 'revoked' }],
    session: DEMO,
  },
  {
    at: 1500,
    drift: 0,
    failure: new Error('did not settle within 5000 ms'),
    id: 'a fault after the expiry ends the stream without saying anything',
    lasts: EXPIRES_AT,
    said: [],
    session: ASSERTED,
  },
];

/** A render of the root, which shows what it showed. */
function shown(): Promise<Watched> {
  return Promise.resolve(SHOWN);
}

/** The end of a following the fake engine never began. */
function unfollowed(): void {
  // Nothing was followed.
}

/** What the engine does as a render of the root runs, once the test has it refuse. */
function refusing(row: Row): () => Promise<Watched> {
  return () => {
    vi.setSystemTime(row.at);
    return Promise.reject(row.failure);
  };
}

/**
 * An authority as a stream sees one: it renders the root as `SHOWN` until `refuse` says its next
 * render is the one refused, as `row` says, and announces each commit as changing `READ`.
 */
function authority(row: Row): {
  readonly commit: () => void;
  readonly engine: Engine;
  readonly refuse: () => void;
} {
  const listeners = new Set<(event: CommitEvent) => void>();
  let render = shown;
  const engine = {
    // Sampled at the clock's zero, as the engine's own is, and answered the later for the drift.
    expiresIn: () => {
      vi.setSystemTime(row.drift);
      return Promise.resolve(row.lasts);
    },
    // What a stream holds while it is open: the external stores' logs followed, of which it has none.
    following: () => unfollowed,
    onCommit: (listener: (event: CommitEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revision: () => 0,
    watch: async () => render(),
  } as unknown as Engine;
  return {
    commit: () => {
      for (const listener of listeners) {
        listener({ changed: [READ], kind: 'state', revision: 1, rows: [] });
      }
    },
    engine,
    refuse: () => {
      render = refusing(row);
    },
  };
}

/** The events in what a stream wrote, in order: its comments are no events. */
function eventsIn(text: string): Row['said'] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const [name = '', data = ''] = block.split('\n', 2);
      return {
        data: JSON.parse(data.slice('data: '.length)) as unknown,
        event: name.slice('event: '.length),
      };
    });
}

/** What the Durable Object's stream says once a commit's render is refused, until it ends. */
async function saidByObject(row: Row): Promise<Row['said']> {
  const { commit, engine, refuse } = authority(row);
  const stream = await new EventStreams(engine).open(row.session, 'subscription');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  refuse();
  commit();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return eventsIn(text);
    }
    text += decoder.decode(value);
  }
}

/** A response that takes everything written, as a Node response does, and records it. */
// eslint-disable-next-line unicorn/prefer-event-target -- a Node response is an EventEmitter, which the stream listens to
class Response extends EventEmitter {
  readonly destroyed = false;
  readonly socket = { destroyed: false };
  readonly written: string[] = [];
  ended = false;

  writeHead(): this {
    return this;
  }

  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }

  end(): void {
    this.ended = true;
    this.emit('close');
  }
}

/** What the Node authority's stream says once a commit's render is refused, until it ends. */
async function saidByNode(row: Row): Promise<Row['said']> {
  const { commit, engine, refuse } = authority(row);
  const res = new Response();
  // eslint-disable-next-line unicorn/prefer-event-target -- a Node request is an EventEmitter too
  const req = Object.assign(new EventEmitter(), { destroyed: false });
  // The HTTP route samples `expiresIn` at the clock's zero, and opens the stream the drift later.
  vi.setSystemTime(row.drift);
  openEventStream(req as unknown as IncomingMessage, res as unknown as ServerResponse, {
    engine,
    expiresIn: row.lasts,
    initial: SHOWN,
    sessionId: row.session,
    streams: new Set(),
    subscription: 'subscription',
  });
  refuse();
  commit();
  await vi.waitFor(() => {
    expect(res.ended).toBe(true);
  });
  return eventsIn(res.written.join(''));
}

describe.each([
  ['the Durable Object’s stream', saidByObject],
  ['the Node authority’s stream', saidByNode],
])('%s', (_name, said) => {
  beforeEach(() => {
    // Only the clock is moved: a render the engine refuses runs after the session's expiry, or at
    // it, by the clock the stream reads, with no timer of the stream's firing before. A real timer
    // of the stream, set for 500 ms, is cleared as the stream ends.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(ROWS)('$id', async (row) => {
    await expect(said(row)).resolves.toStrictEqual(row.said);
  });
});
