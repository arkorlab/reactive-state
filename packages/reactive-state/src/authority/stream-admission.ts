import { HTTP_TOO_MANY_REQUESTS } from '../status.ts';
import { AuthorityError, refusal } from './errors.ts';

/**
 * How many event streams one session holds open at once: room for many open tabs, and no more than
 * a replayed subscription may register.
 */
export const MAX_STREAMS_PER_SESSION = 16;
/**
 * How many event streams one user of the application's own sessions holds open at once, over every
 * session its server asserted for the user: sixteen sessions' worth — more browsers and devices
 * signed in at once, each at its own cap, than anyone uses — and a sixteenth of the authority's, so
 * that a user who signs in again and again leaves every other user room.
 */
export const MAX_STREAMS_PER_USER = 256;
/**
 * How many event streams the authority holds open for every session together, so that no number of
 * sessions grows what a commit announces to, and what the streams render, without bound.
 */
export const MAX_STREAMS = 4096;

/**
 * Whose places each place an admission took is counted among — the session's, or the key's of an
 * asserted session — by the function that gives the place back. A host reads it (`holderOf`), and
 * nothing the package's entries export does: it is no part of what `admitStream` answers.
 */
const HOLDERS = new WeakMap<() => void, string>();
/**
 * The holder each refusal at the holder's own cap was made for, beside what the refusal says, which
 * is the same for every cap: a refusal of the user's or the authority's cap alone has none
 * (`holderRefused`).
 */
const REFUSED = new WeakMap<AuthorityError, string>();

/** Whose places `release` gives one back to; none for a function no admission answered. */
export function holderOf(release: () => void): string | undefined {
  return HOLDERS.get(release);
}

/**
 * The holder whose own cap `error` refused a stream at — its places all taken, whatever the user's
 * or the authority's — or none: a refusal of the user's or the authority's cap alone, or any other
 * error.
 */
export function holderRefused(error: unknown): string | undefined {
  return error instanceof AuthorityError ? REFUSED.get(error) : undefined;
}

/** `counts` with one place fewer of `holder`'s, whose entry is let go of with its last place. */
function giveBack(counts: Map<string, number>, holder: string): void {
  const left = (counts.get(holder) ?? 1) - 1;
  if (left === 0) {
    counts.delete(holder);
  } else {
    counts.set(holder, left);
  }
}

/**
 * The event streams the authority holds, by session and by user: a stream is counted from its
 * admission, before it renders or listens, until it releases its place, which it does once.
 */
export class StreamAdmission {
  readonly #held = new Map<string, number>();
  /**
   * The streams of each user of an asserted session that holds any: an entry is let go of with the
   * user's last place, so there are no more entries than streams (`MAX_STREAMS`), each keyed by an
   * id of a record's shape, 64 characters at most (`assertedSessionOf`).
   */
  readonly #users = new Map<string, number>();
  #total = 0;

  /**
   * Takes a place for a stream of `session` — and of `user`, the user the application's server
   * asserted the session for; none for a demo session, whose user anybody may sign in as — or
   * refuses; the function answered gives it back.
   */
  admit(session: string, user: string | undefined): () => void {
    const held = this.#held.get(session) ?? 0;
    const ofUser = user === undefined ? 0 : (this.#users.get(user) ?? 0);
    if (
      held >= MAX_STREAMS_PER_SESSION ||
      ofUser >= MAX_STREAMS_PER_USER ||
      this.#total >= MAX_STREAMS
    ) {
      const refused = refusal(
        HTTP_TOO_MANY_REQUESTS,
        'TOO_MANY_STREAMS',
        'Too many event streams are open: close one, or ask again shortly.',
      );
      if (held >= MAX_STREAMS_PER_SESSION) {
        REFUSED.set(refused, session);
      }
      throw refused;
    }
    this.#held.set(session, held + 1);
    if (user !== undefined) {
      this.#users.set(user, ofUser + 1);
    }
    this.#total += 1;
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      this.#total -= 1;
      giveBack(this.#held, session);
      if (user !== undefined) {
        giveBack(this.#users, user);
      }
    };
    HOLDERS.set(release, session);
    return release;
  }
}
