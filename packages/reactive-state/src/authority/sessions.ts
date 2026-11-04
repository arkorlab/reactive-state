import { randomBytes } from 'node:crypto';

import { assertedSessionOf } from '../asserted.ts';
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND } from '../status.ts';
import type { Database } from './database.ts';
import { refusal } from './errors.ts';
import type { Session } from './model.ts';
import { DEMO_USERS } from './schema.ts';

/**
 * Who a call is made for. The demo's sessions are opened by the authority itself, on a sign-in
 * with no password, and kept in its database until they end. An application's own sessions are
 * its sign-in's, which its server vouches for with every call (`AssertedSession`): the authority
 * keeps nothing of one — its read path writes nothing — but the keys the application ended, and
 * its operations' receipts, a resend reads.
 */

/** Which sessions an authority admits: the demo's, or the ones the application's server asserts. */
export type SessionMode = 'asserted' | 'demo';

/** How long a demo session lasts: a day. */
const SESSION_TTL_MS = 86_400_000;
/** The bytes of a demo session's id. */
const SESSION_BYTES = 32;

/** Where every asserted session's id starts: no demo session's id, base64url, holds a dot. */
const ASSERTED_PREFIX = 'app.';

/**
 * The lifetimes of what is kept of asserted sessions, and the longest an asserted session's stream
 * goes before its page asks the application again whether the session still stands.
 */
export const ASSERTED = {
  /** A stream of an asserted session is renewed this often, whenever its session expires. */
  reassertMs: 300_000,
  /**
   * The furthest an asserted session's expiry may be: thirty days on. One asserted to last longer
   * is none — the application asserts its sign-in's session to the nearer end, anew with each
   * call — so that every session admitted before its key was ended has expired once the key is let
   * go of (`endedForMs`).
   */
  lifetimeMs: 2_592_000_000,
  /** An ended key is kept this long: as long as any session admitted under it before could last. */
  endedForMs: 2_592_000_000,
  /** A receipt outlives every resend of its operation by this long. */
  receiptsForMs: 86_400_000,
  /** What no asserted session needs any more is let go of at most this often. */
  sweepEveryMs: 3_600_000,
} as const;

/** The refusal of a demo sign-in where the application signs its users in itself. */
function noDemoSessions(): Error {
  return refusal(
    HTTP_NOT_FOUND,
    'NO_DEMO_SESSIONS',
    'The application signs its users in itself: there is no demo sign-in.',
  );
}

/** The id an asserted session goes by inside the authority: of its key and its user both. */
function assertedId(key: string, user: string): string {
  return `${ASSERTED_PREFIX}${key}.${user}`;
}

/** The resource a commit names to end every stream of `session` (`Watched.dependsOn`). */
export function endedResource(session: Session): string {
  return session.key === undefined ? `session:${session.id}` : `session-key:${session.key}`;
}

/** The sessions an authority admits, as its mode says, over its database. */
export class Sessions {
  readonly #db: Database;
  readonly #clock: () => number;
  /** When what no asserted session needs any more was last let go of. */
  #swept = -Infinity;
  readonly mode: SessionMode;

  constructor(db: Database, clock: () => number, mode: SessionMode = 'demo') {
    this.#db = db;
    this.#clock = clock;
    this.mode = mode;
  }

  /**
   * The session `presented` names, while it lasts: a demo session by the id its cookie carries, or
   * a session the application's server asserts, while it has not expired and its key was not
   * ended. A presentation of the other mode's names none.
   */
  resolve(presented: unknown): Session | undefined {
    const now = this.#clock();
    if (this.mode === 'asserted') {
      const asserted = assertedSessionOf(presented);
      if (
        asserted === undefined ||
        asserted.expires <= now ||
        asserted.expires > now + ASSERTED.lifetimeMs
      ) {
        return undefined;
      }
      const until = this.#db.endedUntil(asserted.id);
      if (until !== undefined && until > now) {
        return undefined;
      }
      return {
        expires: asserted.expires,
        id: assertedId(asserted.id, asserted.user),
        key: asserted.id,
        userId: asserted.user,
      };
    }
    const row = typeof presented === 'string' ? this.#db.session(presented) : undefined;
    return row?.active !== true || row.expires <= now
      ? undefined
      : { expires: row.expires, id: row.id, userId: row.userId };
  }

  /**
   * `session`, resolved earlier in the call, while it still lasts: a demo session read again by its
   * id, an asserted one while it has not expired and its key was not ended since.
   */
  current(session: Session): Session | undefined {
    if (session.key === undefined) {
      return this.resolve(session.id);
    }
    const now = this.#clock();
    const until = this.#db.endedUntil(session.key);
    return session.expires <= now || (until !== undefined && until > now) ? undefined : session;
  }

  /** A demo session opened for one of the demo's users; refused where the application signs in. */
  login(userId: unknown): { readonly sessionId: string; readonly userId: string } {
    if (this.mode === 'asserted') {
      throw noDemoSessions();
    }
    if (typeof userId !== 'string' || !DEMO_USERS.includes(userId)) {
      throw refusal(
        HTTP_BAD_REQUEST,
        'INVALID_USER',
        `The demo's users are ${DEMO_USERS.join(', ')}.`,
      );
    }
    const sessionId = randomBytes(SESSION_BYTES).toString('base64url');
    // Each sign-in lets go of the sessions that have expired, so they do not pile up.
    this.#db.transaction(() => {
      this.#db.endExpiredSessions(this.#clock());
      this.#db.insertSession(sessionId, userId, this.#clock() + SESSION_TTL_MS);
    });
    return { sessionId, userId };
  }

  /**
   * How long a stream of `session` goes before it is read again — a visitor of none's, a day — and
   * an asserted session's at most `ASSERTED.reassertMs`, whose page then asks again.
   */
  expiresIn(session: Session | undefined): number {
    if (session === undefined) {
      return SESSION_TTL_MS;
    }
    const lasts = session.expires - this.#clock();
    return session.key === undefined ? lasts : Math.min(lasts, ASSERTED.reassertMs);
  }

  /** What a commit that ends `session` writes beside it: its row, and its operations with it. */
  ending(session: Session): () => void {
    if (session.key === undefined) {
      return () => {
        this.#db.endSession(session.id);
      };
    }
    return this.keyEnding(session.key);
  }

  /**
   * What a commit that ends the key `key` writes beside it: the key, ended for longer than any
   * session asserted under it lasts, and every receipt of its sessions' operations.
   */
  keyEnding(key: string): () => void {
    return () => {
      this.#db.endKey(key, this.#clock() + ASSERTED.endedForMs, `${ASSERTED_PREFIX}${key}.`);
    };
  }

  /**
   * What ends the key `key` the application's server asserted sessions under — its sign-out — as a
   * commit: the resource that ends each stream of its sessions, and what lands beside it. Refused
   * where the authority admits the demo's sessions (404), and for what names no key (400).
   */
  keyEnd(key: unknown): { readonly resource: string; readonly with: () => void } {
    if (this.mode !== 'asserted') {
      throw refusal(
        HTTP_NOT_FOUND,
        'NO_ASSERTED_SESSIONS',
        "The authority admits the demo's sessions: no session is asserted under a key.",
      );
    }
    if (!isSessionKey(key)) {
      throw refusal(HTTP_BAD_REQUEST, 'INVALID_SESSION_KEY', 'The session key is not valid.');
    }
    return { resource: `session-key:${key}`, with: this.keyEnding(key) };
  }

  /**
   * Lets go of what no asserted session needs any more — ended keys past their while, receipts no
   * resend presents again — at most once in `ASSERTED.sweepEveryMs`, inside a commit's transaction.
   */
  sweep(): void {
    const now = this.#clock();
    if (this.mode !== 'asserted' || now - this.#swept < ASSERTED.sweepEveryMs) {
      return;
    }
    this.#swept = now;
    this.#db.sweepAsserted(now, now - ASSERTED.receiptsForMs, ASSERTED_PREFIX);
  }
}

/** Whether `key` may name the sessions an application's server asserted: a record id's shape. */
function isSessionKey(key: unknown): key is string {
  return assertedSessionOf({ expires: 0, id: key, user: 'x' }) !== undefined;
}
