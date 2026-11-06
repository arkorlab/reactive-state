import type { Entry } from './shared-entry.ts';

/** One view's retry: the view it is of, and its timer. */
interface Retry {
  readonly entry: Entry;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The followed views to be tried again behind a fault's backoff (`SharedJobs.faulted`), by key, each
 * with its timer: one at a time for each key, let go of with its view (`drop`) — a view taken in
 * under the key after it is none of its — or as the authority closes (`clear`).
 */
export class ViewRetries {
  readonly #byKey = new Map<string, Retry>();

  /** Whether a retry of the view of `key` waits. */
  has(key: string): boolean {
    return this.#byKey.has(key);
  }

  /** Calls `fire` `delay` ms on, for `entry`, unless it is let go of first. */
  arm(entry: Entry, delay: number, fire: () => void): void {
    const timer = setTimeout(() => {
      this.#byKey.delete(entry.key);
      fire();
    }, delay);
    this.#byKey.set(entry.key, { entry, timer });
  }

  /** `entry` let go of: its retry with it, where one waits — never another view's of its key. */
  drop(entry: Entry): void {
    const retry = this.#byKey.get(entry.key);
    if (retry?.entry === entry) {
      clearTimeout(retry.timer);
      this.#byKey.delete(entry.key);
    }
  }

  /** Every retry let go of, as the authority closes. */
  clear(): void {
    for (const { timer } of this.#byKey.values()) {
      clearTimeout(timer);
    }
    this.#byKey.clear();
  }
}
