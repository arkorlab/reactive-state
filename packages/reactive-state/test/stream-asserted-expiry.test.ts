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
 * stream must tell the two apart by the time: a refusal after the session's expiry is the expiry's.
 * Here the engine's refusal is made to come after the expiry by moving the clock as the render
 * runs, in place of the load that makes it come late in a run of the Durable Object's suites
 * (`cloudflare/asserted.test.ts`).
 */

/** How long the session lasts, from the instant the stream opens at the clock's zero. */
const LASTS_MS = 500;
const READ = 'todos:t1';
const SIGNED_OUT = 'Sign in first.';

/** What the root's render shows, which depends on `READ` alone. */
const SHOWN: Watched = {
  dependsOn: (event) => event.changed.includes(READ),
  digest: 'shown',
  issued: 'shown',
  revision: 0,
};

/** The session the application's server asserts, expiring when the stream's expiry does. */
const ASSERTED: AssertedSession = { expires: LASTS_MS, id: 'k1', user: 'alice' };
/** A session the demo's sign-in opened, which is a bare id. */
const DEMO = 'demo-session';

type Clock = 'at' | 'before' | 'past';

interface Row {
  readonly id: string;
  readonly session: SessionId;
  /** Where the clock stands as the render the engine refuses runs, against the session's expiry. */
  readonly clock: Clock;
  readonly failure: Error;
  /** The events the stream says after it opens, by name, and what each carries. */
  readonly said: readonly { readonly data: unknown; readonly event: string }[];
}

const unauthenticated = (): Error => refusal(401, 'UNAUTHENTICATED', SIGNED_OUT);
const revoked = { code: 'UNAUTHENTICATED', error: SIGNED_OUT };

const ROWS: readonly Row[] = [
  {
    clock: 'past',
    failure: unauthenticated(),
    id: 'an asserted session refused after its expiry is renewed',
    said: [{ data: {}, event: 'renew' }],
    session: ASSERTED,
  },
  {
    clock: 'at',
    failure: unauthenticated(),
    id: 'an asserted session refused at the instant it expires is renewed',
    said: [{ data: {}, event: 'renew' }],
    session: ASSERTED,
  },
  {
    clock: 'past',
    failure: refusal(403, 'FORBIDDEN', 'Not allowed.'),
    id: 'an asserted session refused with a forbidding status after its expiry is renewed',
    said: [{ data: {}, event: 'renew' }],
    session: ASSERTED,
  },
  {
    clock: 'before',
    failure: unauthenticated(),
    id: 'an asserted session refused before its expiry has ended, and is revoked',
    said: [{ data: revoked, event: 'revoked' }],
    session: ASSERTED,
  },
  {
    clock: 'past',
    failure: unauthenticated(),
    id: 'a demo session refused after its expiry is revoked, as it was',
    said: [{ data: revoked, event: 'revoked' }],
    session: DEMO,
  },
  {
    clock: 'before',
    failure: unauthenticated(),
    id: 'a demo session refused before its expiry is revoked',
    said: [{ data: revoked, event: 'revoked' }],
    session: DEMO,
  },
  {
    clock: 'past',
    failure: new Error('did not settle within 5000 ms'),
    id: 'a fault after the expiry ends the stream without saying anything',
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
    const expiresAt = LASTS_MS;
    if (row.clock !== 'before') {
      vi.setSystemTime(row.clock === 'at' ? expiresAt : expiresAt + 1000);
    }
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
    expiresIn: () => Promise.resolve(LASTS_MS),
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
  openEventStream(req as unknown as IncomingMessage, res as unknown as ServerResponse, {
    engine,
    expiresIn: LASTS_MS,
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
    // it, by the clock the stream reads, with no timer of the stream's firing before.
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
