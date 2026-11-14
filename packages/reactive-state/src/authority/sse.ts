import type { IncomingMessage, ServerResponse } from 'node:http';

import { assertedSessionOf } from '../asserted.ts';
import type { SessionId } from '../client/contract.ts';
import { HTTP_OK, REVOKING_STATUSES } from '../status.ts';
import type { AuthorityEngine as Engine } from './engine.ts';
import { AuthorityError } from './errors.ts';
import type { CommitEvent, Watched } from './model.ts';

/** How often an idle stream says it is alive, under what proxies and the edge close idle at. */
const HEARTBEAT_MS = 15_000;
/** The longest wait a timer takes; a stream whose session lasts longer is read again then. */
const LONGEST_TIMER_MS = 2_147_483_647;
/** What a stream says as it opens, which no client reads as an event. */
const OPENING = ': open\n\n';

export interface EventStream {
  readonly engine: Engine;
  readonly sessionId: SessionId;
  /** The signed subscription the stream follows a page's root by. */
  readonly subscription: string;
  /** The root as it was rendered before the stream opened; its errors are answered as refusals. */
  readonly initial: Watched;
  /** How long the session had, when the stream opened, before it expires. */
  readonly expiresIn: number;
  /** The open streams, which the authority closes when it closes. */
  readonly streams: Set<ServerResponse>;
}

/**
 * What a `frame` event says: the revision of a render that shows something other than the page
 * does, and nothing more. The page renders its root again itself, through the application's own
 * route, so the stream sends nothing on a commit but that there is something newer to show.
 */
function announcement(watched: Watched): { readonly frame: { readonly revision: number } } {
  return { frame: { revision: watched.revision } };
}

class Follower {
  readonly #res: ServerResponse;
  readonly #stream: EventStream;
  readonly #heartbeat: ReturnType<typeof setInterval>;
  readonly #expiry: ReturnType<typeof setTimeout>;
  /** Whether the session is one the application's server asserts, whose stream is renewed. */
  readonly #asserted: boolean;
  /** When the session expires, by this process's clock: what the expiry's timer is set for. */
  readonly #expiresAt: number;
  readonly #unsubscribe: () => void;
  /** Ends this stream's following of the external stores' logs (`AuthorityEngine.following`). */
  readonly #unfollow: () => void;
  #closed = false;
  /** What the page shows, as the last frame sent — or the subscription issued — says. */
  #shown: string;
  /** Whether a commit changes what the root's last render read. */
  #dependsOn: (event: CommitEvent) => boolean;
  /** Whether a read is queued that has not begun: it reads whatever commits before it begins. */
  #waiting = false;
  /** Whether a read is under way, whose render may not show a commit made meanwhile. */
  #reading = false;
  /** Whether the client has yet to take what was written: frames wait for the response's drain. */
  #full = false;
  /** Whether a commit came while the client was behind, so the root is read again on drain. */
  #behind = false;
  /** The reads queued so far: one at a time, in commit order. */
  #tail: Promise<void> = Promise.resolve();

  constructor(res: ServerResponse, stream: EventStream) {
    this.#res = res;
    this.#stream = stream;
    this.#shown = stream.initial.issued;
    this.#dependsOn = stream.initial.dependsOn;
    this.#heartbeat = setInterval(() => {
      if (!this.#closed && !this.#full) {
        this.#write(': heartbeat\n\n');
      }
    }, HEARTBEAT_MS);
    // A client that reads slowly is told of the newest render once it has taken the last, not of
    // each one in between: what the authority holds for a stream stays bounded.
    res.on('drain', () => {
      this.#full = false;
      if (this.#behind) {
        this.#behind = false;
        this.changed();
      }
    });
    // No commit says that a session expired: the stream reads again once it has, which a session
    // that ended answers with `revoked`, and ends whatever the read says. An asserted session's is
    // renewed instead, read again by nobody here: its page opens the stream again at once, through
    // the application's route, which asks the application whether its session still stands.
    this.#asserted = assertedSessionOf(stream.sessionId) !== undefined;
    this.#expiresAt = Date.now() + Math.max(stream.expiresIn, 0);
    this.#expiry = setTimeout(
      () => {
        this.#queue(async () => {
          if (this.#asserted) {
            this.send('renew', {});
          } else {
            await this.#read();
          }
          this.close();
        });
      },
      Math.min(Math.max(stream.expiresIn, 0) + 1, LONGEST_TIMER_MS),
    );
    this.#unsubscribe = stream.engine.onCommit((event) => {
      this.#committed(event);
    });
    this.#unfollow = stream.engine.following();
    stream.streams.add(res);
  }

  /** Writes to the response, and notes when the client has yet to take what it holds. */
  #write(chunk: string): void {
    if (!this.#res.write(chunk)) {
      this.#full = true;
    }
  }

  /** Runs `step` after the reads queued so far, in their order. */
  #queue(step: () => Promise<void>): void {
    const previous = this.#tail;
    this.#tail = (async () => {
      await previous;
      await step();
    })();
  }

  /** Renders the root again, and answers its own failure, so the chain of reads never rejects. */
  async #read(): Promise<void> {
    if (this.#closed) {
      return;
    }
    const { engine, sessionId, subscription } = this.#stream;
    this.#reading = true;
    try {
      const watched = await engine.watch(sessionId, subscription);
      this.#dependsOn = watched.dependsOn;
      if (this.#full) {
        this.#behind = true;
        return;
      }
      this.show(watched);
    } catch (error) {
      // Only a refusal of the session ends the subscription for good; anything else — a fault of
      // the application's code too — only ends this stream, which the browser opens again. A read
      // waits in the engine's queue, so one queued before the expiry can run after it, where the
      // engine refuses the session as it refuses one that ended: an asserted session's refusal
      // once its expiry has come is renewed (`renew`), as its expiry's own step would have.
      if (error instanceof AuthorityError && REVOKING_STATUSES.has(error.status)) {
        if (this.#asserted && Date.now() >= this.#expiresAt) {
          this.send('renew', {});
        } else {
          this.send('revoked', { code: error.code, error: error.message });
        }
      }
      this.close();
    } finally {
      this.#reading = false;
    }
  }

  /**
   * A commit that changed nothing the root's last render read — a record of another project's,
   * another session's sign-out — renders nothing again. While a render is under way every commit
   * counts.
   */
  #committed(event: CommitEvent): void {
    if (!this.#reading && !this.#dependsOn(event)) {
      return;
    }
    this.changed();
  }

  /** Says that there is a newer render, where it shows something other than the page does. */
  show(watched: Watched): void {
    if (watched.digest !== this.#shown) {
      this.#shown = watched.digest;
      this.send('frame', announcement(watched));
    }
  }

  send(event: string, data: unknown): void {
    if (!this.#closed) {
      this.#write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  changed(): void {
    if (this.#full) {
      this.#behind = true;
      return;
    }
    // A read that has not begun reads every commit made before it begins, so one waiting is
    // enough, however many commits come meanwhile: a burst costs a stream two reads at most.
    if (this.#waiting) {
      return;
    }
    this.#waiting = true;
    this.#queue(async () => {
      this.#waiting = false;
      await this.#read();
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    clearInterval(this.#heartbeat);
    clearTimeout(this.#expiry);
    this.#unsubscribe();
    this.#unfollow();
    this.#stream.streams.delete(this.#res);
    this.#res.end();
  }
}

/**
 * A session's subscription to a page's root, as server-sent events: a `frame` whenever a commit
 * it depends on makes the root render something other than the page shows — at once, as the
 * stream opens, where it already does — and `revoked` when the session ends, after which the
 * stream ends. The listener is registered after the first render: a commit in between is read
 * again for.
 */
export function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  stream: EventStream,
): void {
  // The root was rendered before the stream opened; a client that left meanwhile has no stream to
  // follow, and nothing would ever close one opened for it.
  if (req.destroyed || res.destroyed || res.socket?.destroyed !== false) {
    res.end();
    return;
  }
  res.writeHead(HTTP_OK, {
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  });
  // A comment, at once: a stream whose page shows what the root renders now has nothing to say
  // yet, and what stands between the authority and the browser — the application's route, a
  // Function, an edge — may hold the headers back until the body's first bytes, which would
  // otherwise be its first heartbeat's. Written past the follower: it is no frame a slow client
  // is behind on.
  res.write(OPENING);
  const follower = new Follower(res, stream);
  const close = (): void => {
    follower.close();
  };
  req.on('close', close);
  res.on('close', close);
  follower.show(stream.initial);
  if (stream.engine.revision() > stream.initial.revision) {
    follower.changed();
  }
}
