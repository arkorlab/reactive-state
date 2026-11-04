import { assertedSessionOf } from '../asserted.ts';
import type { AuthorityEngine } from '../authority/engine.ts';
import { AuthorityError } from '../authority/errors.ts';
import type { CommitEvent, Watched } from '../authority/model.ts';
import type { SessionId } from '../client/contract.ts';
import { REVOKING_STATUSES } from '../status.ts';

/**
 * A session's server-sent events for a page's root, by the subscription its frame was issued with,
 * as the Durable Object hands them over its RPC: a byte stream the caller pipes into its response,
 * written as the Node authority writes its own (`authority/sse.ts`) — a comment as it opens; a
 * `frame` event saying the revision of a render of the root that shows something other than the
 * page does, at once where the first render already does; `revoked` when the session ends; and a
 * heartbeat comment whenever it has said nothing for a while.
 *
 * The stream is pulled. Each pull waits for a commit that may change what the root renders, and
 * then renders the root as it is now, once: commits that landed while the reader was busy come
 * together in that one render, so a slow reader is told of the newest render rather than of every
 * one in between. A render that shows what the page shows says nothing, and the pull waits again —
 * for the heartbeat too, which is due an interval after the stream last said anything, however
 * many commits came between. The wait holds nothing of the engine, whose queue every request of
 * the object joins; only the render does, for as long as a render takes. A commit counts where it
 * changed what the root's last render read — a record, a query's answer, the session — or where it
 * came while a render was under way, which may not show it; another project's write wakes nothing.
 *
 * No commit says that a session expired, so a wait also ends when the session does: the root is
 * rendered once more then, which a session that ended answers with `revoked`, and the stream ends
 * whatever the render says, as the Node authority's does. An asserted session's stream is renewed
 * then instead (`renew`), rendered by nobody here: its page opens it again at once, through the
 * application's route, which asks the application whether its session still stands. It is the
 * same wait, for the soonest of the three, and no timer of its own keeps the object in memory.
 */

/** How long a stream says nothing before it says it is alive, under what proxies close idle at. */
const HEARTBEAT_MS = 15_000;
const HEARTBEAT = ': heartbeat\n\n';
/**
 * What a stream says as it opens, which no client reads as an event: what stands between the
 * object and the browser — the application's route, a Function, an edge — may hold the headers
 * back until the body's first bytes, which would otherwise be the first heartbeat's.
 */
const OPENING = ': open\n\n';

const encoder = new TextEncoder();

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * What a `frame` event says: the revision of a render that shows something other than the page
 * does, and nothing more, as the Node authority's does. The page renders its root again itself,
 * through the application's own route, so a commit costs the stream no more than that there is
 * something newer to show.
 */
function announcement(watched: Watched): { readonly frame: { readonly revision: number } } {
  return { frame: { revision: watched.revision } };
}

/** What a wait for the next commit ended with. */
type Woken = 'commit' | 'ended' | 'expired' | 'heartbeat';

/** What one open stream follows, and where it is counted. */
interface Following {
  readonly engine: AuthorityEngine;
  readonly sessionId: SessionId;
  /** The signed subscription of the root, as the page's frame was issued with it. */
  readonly subscription: string;
  readonly heartbeatMs: number;
  /** The streams open now, which a follower leaves as it ends. */
  readonly open: Set<Follower>;
}

class Follower {
  readonly #following: Following;
  readonly #unsubscribe: () => void;
  /** Ends this stream's following of the external stores' logs (`AuthorityEngine.following`). */
  readonly #unfollow: () => void;
  /** The newest revision a commit that may change the render announced, and the last render's. */
  #announced = 0;
  #rendered = 0;
  /** What the page shows, as the last frame sent — or the subscription issued — says. */
  #shown = '';
  /** Whether a commit changes what the root's last render read; none until a render has said. */
  #dependsOn: ((event: CommitEvent) => boolean) | undefined;
  /** Whether a render is under way, which may not show a commit made meanwhile. */
  #rendering = false;
  /** When the session expires, by this isolate's clock: the stream renders the root again then. */
  #expiresAt = Infinity;
  /** When the stream last said anything, by this isolate's clock: the heartbeat follows a silence. */
  #saidAt = 0;
  /** Ends the wait under way, if one is. */
  #wake: ((woken: Woken) => void) | undefined;
  #ended = false;

  constructor(following: Following) {
    this.#following = following;
    // Listening before the first render, so that a commit between that render and the stream's
    // first pull is not lost: it announces a revision newer than the render before it.
    this.#unsubscribe = following.engine.onCommit((committed) => {
      if (this.#counts(committed)) {
        this.#announced = Math.max(this.#announced, committed.revision);
        this.#wake?.('commit');
      }
    });
    this.#unfollow = following.engine.following();
  }

  /**
   * Whether a commit may change what the root renders. One that changed nothing its last render
   * read — another project's record, another session's sign-out — does not; while a render is
   * under way, or before the first has said what the root read, every commit may.
   */
  #counts(committed: CommitEvent): boolean {
    return this.#dependsOn === undefined || this.#rendering || this.#dependsOn(committed);
  }

  /**
   * Sends `text`, and notes when: the heartbeat is due an interval after. A stream that ended — its
   * reader gone while a wait or a render was under way — is sent nothing.
   */
  #say(controller: ReadableStreamDefaultController<Uint8Array>, text: string): void {
    if (this.#ended) {
      return;
    }
    controller.enqueue(encoder.encode(text));
    this.#saidAt = Date.now();
  }

  /**
   * The next event: a frame once a render shows something other than the page does, a heartbeat
   * while nothing does, or the end. A render that shows what the page shows is no event, and the
   * pull waits again — a pull that enqueued nothing would never be made again.
   */
  async #pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    while (!this.#ended) {
      // A session's expiry comes before another commit's render: a root that changes on and on
      // would otherwise keep a stream of a session open past it.
      if (Date.now() > this.#expiresAt) {
        await this.#expire(controller);
        return;
      }
      const answered =
        this.#announced > this.#rendered
          ? await this.#render(controller)
          : await this.#waited(controller);
      if (answered) {
        return;
      }
    }
  }

  /**
   * Ends the stream at its session's expiry: a demo session's root rendered once more — which one
   * that ended answers with `revoked` — and an asserted session's renewed instead (`renew`), which
   * its page opens again through the application's route.
   */
  async #expire(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (assertedSessionOf(this.#following.sessionId) === undefined) {
      await this.#render(controller);
    } else {
      this.#say(controller, event('renew', {}));
    }
    this.#finish(controller);
  }

  /**
   * Waits for what comes next, and answers it: a commit is rendered for by the pull, a heartbeat
   * is sent, and the stream ends at its session's expiry (`#expire`). Answers whether the pull has
   * its event.
   */
  async #waited(controller: ReadableStreamDefaultController<Uint8Array>): Promise<boolean> {
    const woken = await this.#next();
    switch (woken) {
      case 'commit': {
        return false;
      }
      case 'heartbeat': {
        this.#say(controller, HEARTBEAT);
        return true;
      }
      case 'expired': {
        await this.#expire(controller);
        return true;
      }
      case 'ended': {
        return true;
      }
    }
  }

  /**
   * Waits for the next commit, the heartbeat, the session's expiry or the end, whichever comes
   * first. The heartbeat is due an interval after the stream last said anything; the expiry is
   * waited for until a moment after it, by when the authority's clock has it expired as well.
   */
  async #next(): Promise<Woken> {
    if (this.#ended) {
      return 'ended';
    }
    const now = Date.now();
    const untilExpiry = Math.max(this.#expiresAt - now, 0) + 1;
    const untilHeartbeat = Math.max(this.#saidAt + this.#following.heartbeatMs - now, 0);
    const { promise, resolve } = Promise.withResolvers<Woken>();
    const timer = setTimeout(
      () => {
        resolve(untilExpiry <= untilHeartbeat ? 'expired' : 'heartbeat');
      },
      Math.min(untilExpiry, untilHeartbeat),
    );
    this.#wake = (woken) => {
      clearTimeout(timer);
      resolve(woken);
    };
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
      this.#wake = undefined;
    }
  }

  /**
   * Renders the root as it is now, and says so where it shows something other than the page does;
   * a refusal of the session ends the stream with `revoked`, and any other failure without it.
   * Answers whether the pull has its event: a frame was sent, or the stream ended.
   */
  async #render(controller: ReadableStreamDefaultController<Uint8Array>): Promise<boolean> {
    const { engine, sessionId, subscription } = this.#following;
    let watched: Watched;
    this.#rendering = true;
    try {
      watched = await engine.watch(sessionId, subscription);
    } catch (error) {
      // Only a refusal of the session ends the subscription for good; anything else — a fault of
      // the application's code too — only ends this stream, which the browser opens again.
      if (error instanceof AuthorityError && REVOKING_STATUSES.has(error.status)) {
        this.#say(controller, event('revoked', { code: error.code, error: error.message }));
      }
      this.#finish(controller);
      return true;
    } finally {
      this.#rendering = false;
    }
    this.#rendered = watched.revision;
    this.#dependsOn = watched.dependsOn;
    // A reader that went away while the root was rendered is sent nothing: its stream is cancelled.
    return this.#ended || this.#show(controller, watched);
  }

  /** Says that there is a newer render, where it shows something other than the page does. */
  #show(controller: ReadableStreamDefaultController<Uint8Array>, watched: Watched): boolean {
    if (watched.digest === this.#shown) {
      return false;
    }
    this.#shown = watched.digest;
    this.#say(controller, event('frame', announcement(watched)));
    return true;
  }

  /** Ends the stream where nothing has ended it yet: its reader is told it is over. */
  #finish(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (!this.#ended) {
      this.end();
      controller.close();
    }
  }

  /**
   * The stream of the root as `initial` rendered it, once this follower listened, for a session
   * that expires `expiresIn` milliseconds from now: after its opening, its first event is a frame
   * where the render shows something other than what the subscription was issued for.
   */
  stream(initial: Watched, expiresIn: number): ReadableStream<Uint8Array> {
    this.#rendered = initial.revision;
    this.#dependsOn = initial.dependsOn;
    this.#shown = initial.issued;
    this.#expiresAt = Date.now() + expiresIn;
    this.#following.open.add(this);
    return new ReadableStream<Uint8Array>({
      cancel: () => {
        this.end();
      },
      pull: async (controller) => this.#pull(controller),
      start: (controller) => {
        this.#say(controller, OPENING);
        this.#show(controller, initial);
      },
    });
  }

  /** Stops listening and waiting, once: for a reader that went away, or a stream that is over. */
  end(): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#unsubscribe();
    this.#unfollow();
    this.#following.open.delete(this);
    this.#wake?.('ended');
  }
}

/** The object's event streams: each opened for a session its root renders for, and counted. */
export class EventStreams {
  readonly #engine: AuthorityEngine;
  readonly #heartbeatMs: number;
  readonly #open = new Set<Follower>();

  constructor(engine: AuthorityEngine, heartbeatMs = HEARTBEAT_MS) {
    this.#engine = engine;
    this.#heartbeatMs = heartbeatMs;
  }

  /** How many streams are open now. */
  get size(): number {
    return this.#open.size;
  }

  /**
   * The session's stream for the root `subscription` follows. The root is rendered here first,
   * before there is any stream: a refusal of it — no session, a subscription of another session's
   * or of another build — is thrown, for the caller to answer as an ordinary refusal.
   */
  async open(sessionId: SessionId, subscription: string): Promise<ReadableStream<Uint8Array>> {
    const follower = new Follower({
      engine: this.#engine,
      heartbeatMs: this.#heartbeatMs,
      open: this.#open,
      sessionId,
      subscription,
    });
    let initial: Watched;
    let expiresIn: number;
    try {
      initial = await this.#engine.watch(sessionId, subscription);
      expiresIn = await this.#engine.expiresIn(sessionId);
    } catch (error) {
      follower.end();
      throw error;
    }
    return follower.stream(initial, expiresIn);
  }
}
