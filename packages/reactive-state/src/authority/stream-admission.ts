import { HTTP_TOO_MANY_REQUESTS } from '../status.ts';
import { refusal } from './errors.ts';

/**
 * How many event streams one session holds open at once: room for many open tabs, and no more than
 * a replayed subscription may register.
 */
export const MAX_STREAMS_PER_SESSION = 16;
/**
 * How many event streams the authority holds open for every session together, so that no number of
 * sessions grows what a commit announces to, and what the streams render, without bound.
 */
export const MAX_STREAMS = 4096;

/**
 * The event streams the authority holds, by session: a stream is counted from its admission, before
 * it renders or listens, until it releases its place, which it does once.
 */
export class StreamAdmission {
  readonly #held = new Map<string, number>();
  #total = 0;

  /** Takes a place for a stream of `session`, or refuses; the function answered gives it back. */
  admit(session: string): () => void {
    const held = this.#held.get(session) ?? 0;
    if (held >= MAX_STREAMS_PER_SESSION || this.#total >= MAX_STREAMS) {
      throw refusal(
        HTTP_TOO_MANY_REQUESTS,
        'TOO_MANY_STREAMS',
        'Too many event streams are open: close one, or ask again shortly.',
      );
    }
    this.#held.set(session, held + 1);
    this.#total += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#total -= 1;
      const left = (this.#held.get(session) ?? 1) - 1;
      if (left === 0) {
        this.#held.delete(session);
      } else {
        this.#held.set(session, left);
      }
    };
  }
}
