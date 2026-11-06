import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import type { AuthorityEngine as Engine } from '../src/authority/engine.ts';
import { refusal } from '../src/authority/errors.ts';
import type { CommitEvent, Watched } from '../src/authority/model.ts';
import { openEventStream } from '../src/authority/sse.ts';

/** The record the followed root read, and the one it did not. */
const READ = 'todos:t1';
const UNREAD = 'todos:t3';

/**
 * A render of the root at `revision` showing `digest`, which depends on `READ` alone, for a page
 * that shows `shown`.
 */
function watched(revision: number, digest: string): Watched {
  return {
    dependsOn: (event) => event.changed.includes(READ),
    digest,
    issued: 'shown',
    revision,
  };
}

/**
 * A response whose client takes nothing written until the test says, as a slow client's does — or,
 * made not `full`, takes everything at once.
 */
// eslint-disable-next-line unicorn/prefer-event-target -- a Node response is an EventEmitter, which the stream listens to
class SlowResponse extends EventEmitter {
  #full: boolean;
  readonly destroyed = false;
  readonly socket = { destroyed: false };
  readonly written: string[] = [];
  ended = false;

  constructor(full = true) {
    super();
    this.#full = full;
  }

  writeHead(): this {
    return this;
  }

  write(chunk: string): boolean {
    this.written.push(chunk);
    return !this.#full;
  }

  end(): void {
    this.ended = true;
    this.emit('close');
  }

  /** The client takes what was written, and takes what comes next at once. */
  drain(): void {
    this.#full = false;
    this.emit('drain');
  }

  /** The frames written, by their revision. */
  frames(): readonly number[] {
    return this.written
      .filter((chunk) => chunk.startsWith('event: frame'))
      .map((chunk) => {
        const data = JSON.parse(chunk.split('data: ', 2)[1] ?? '{}') as {
          frame: { revision: number };
        };
        return data.frame.revision;
      });
  }
}

/**
 * An authority as a stream sees one: it renders the root as `render` does, and announces each
 * commit, as changing `READ` unless it says otherwise.
 */
function authority(render: () => Promise<Watched>): {
  readonly engine: Engine;
  readonly commit: (changed?: readonly string[]) => void;
  readonly watch: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(event: CommitEvent) => void>();
  const watch = vi.fn(render);
  const engine = {
    onCommit: (listener: (event: CommitEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // What a stream holds while it is open: the external stores' logs followed, of which it has none.
    following: () => unfollowed,
    revision: () => 0,
    watch,
  } as unknown as Engine;
  return {
    commit: (changed = [READ]) => {
      for (const listener of listeners) {
        listener({ changed, kind: 'state', revision: 1, rows: [] });
      }
    },
    engine,
    watch,
  };
}

/** The end of a following the fake engine never began. */
function unfollowed(): void {
  // Nothing was followed.
}

/** Opens a stream of the root onto `res`, whose page shows what `initial` was issued for. */
function open(engine: Engine, res: SlowResponse, initial: Watched = watched(0, 'shown')): void {
  // eslint-disable-next-line unicorn/prefer-event-target -- a Node request is an EventEmitter too
  const req = Object.assign(new EventEmitter(), { destroyed: false });
  openEventStream(req as unknown as IncomingMessage, res as unknown as ServerResponse, {
    engine,
    expiresIn: 60_000,
    initial,
    sessionId: 'session',
    streams: new Set(),
    subscription: 'subscription',
  });
}

describe('an event stream', () => {
  it('announces at once a render that shows something other than the page, and nothing otherwise', () => {
    const behind = new SlowResponse(false);
    const current = new SlowResponse(false);

    open(authority(() => Promise.resolve(watched(2, 'newer'))).engine, behind, watched(2, 'newer'));
    open(authority(() => Promise.resolve(watched(0, 'shown'))).engine, current);

    expect(behind.frames()).toStrictEqual([2]);
    expect(current.frames()).toStrictEqual([]);

    behind.end();
    current.end();
  });

  it('renders the root again for a commit to what it read, and for none other', async () => {
    const { commit, engine, watch } = authority(() => Promise.resolve(watched(1, 'changed')));
    const res = new SlowResponse(false);
    open(engine, res);

    commit([UNREAD]);
    commit(['session:another']);
    await sleep(10);

    expect(watch).not.toHaveBeenCalled();

    commit([READ]);

    await vi.waitFor(() => {
      expect(res.frames()).toStrictEqual([1]);
    });

    expect(watch).toHaveBeenCalledExactlyOnceWith('session', 'subscription');

    res.end();
  });

  it('announces a render again only where it shows something else', async () => {
    let digest = 'shown';
    const { commit, engine, watch } = authority(() => Promise.resolve(watched(1, digest)));
    const res = new SlowResponse(false);
    open(engine, res);

    commit();
    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledTimes(1);
    });
    digest = 'changed';
    commit();

    await vi.waitFor(() => {
      expect(res.frames()).toStrictEqual([1]);
    });

    expect(watch).toHaveBeenCalledTimes(2);

    res.end();
  });

  it('renders nothing for a client that has yet to take the last frame, and the newest once it has', async () => {
    const { commit, engine, watch } = authority(() => Promise.resolve(watched(3, 'newest')));
    const res = new SlowResponse();
    open(engine, res, watched(1, 'older'));

    commit();
    commit();
    commit();
    await sleep(10);

    expect(watch).not.toHaveBeenCalled();
    expect(res.frames()).toStrictEqual([1]);

    res.drain();

    await vi.waitFor(() => {
      expect(res.frames()).toStrictEqual([1, 3]);
    });

    expect(watch).toHaveBeenCalledExactlyOnceWith('session', 'subscription');

    res.end();
  });

  it('ends with `revoked` when a render is refused the session, and without it on a fault', async () => {
    const signedOut = 'Sign in first.';
    const refused = authority(() => Promise.reject(refusal(401, 'UNAUTHENTICATED', signedOut)));
    const failed = authority(() => Promise.reject(new Error('did not settle within 5000 ms')));
    const revokedRes = new SlowResponse(false);
    const failedRes = new SlowResponse(false);
    open(refused.engine, revokedRes);
    open(failed.engine, failedRes);

    refused.commit();
    failed.commit();

    await vi.waitFor(() => {
      expect(revokedRes.ended && failedRes.ended).toBe(true);
    });

    expect(revokedRes.written.at(-1)).toBe(
      `event: revoked\ndata: ${JSON.stringify({ code: 'UNAUTHENTICATED', error: signedOut })}\n\n`,
    );
    // A fault ends this stream alone: the browser opens another, whose render may well succeed.
    expect(failedRes.written.some((chunk) => chunk.startsWith('event: revoked'))).toBe(false);
  });
});
