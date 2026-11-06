import type { Table } from '../server/schema.ts';
import type { RowChange } from './dependencies.ts';
import { describeThrown } from './errors.ts';
import { ExternalFollower, type ExternalStore } from './external.ts';
import { nextTurn } from './turns.ts';

/**
 * How the authority follows an external store while a stream or a retained rendering needs it.
 * The host schedules each turn: a Node timer, or the Durable Object's one alarm shared with
 * delivery. No store is read in a page's first render to start following. A log is read outside
 * the engine's queue; its changes enter as a commit inside it, before its cursor is advanced.
 */

/** How often a store's log is read while anything needs it. */
const EVERY_MS = 1000;
const RETRY = { firstMs: 100, maxMs: 30_000 } as const;
/** The longest a timer waits: one asked to wait longer, Node runs after 1 ms instead. */
const LONGEST_TIMER_MS = 2_147_483_647;

/** A host arming, or its delayed retry, whose completion belongs to this deadline alone. */
interface Arming {
  readonly at: number;
}

export interface ExternalTailOptions {
  readonly stores: ReadonlyMap<string, ExternalStore>;
  readonly tables: ReadonlyMap<string, Table>;
  readonly ingest: (rows: readonly RowChange[]) => Promise<void>;
  readonly everyMs?: number | undefined;
  /** How long a read of a store's log may take before it is a failed one: the call timeout. */
  readonly readTimeoutMs?: number | undefined;
  /** Whether any retained rendering reads an external table. */
  readonly retained?: (() => boolean) | undefined;
  readonly clock?: (() => number) | undefined;
  /** The host's alarm; absent on Node, where a timer schedules each turn. */
  readonly schedule?: ((at: number) => Promise<void>) | undefined;
  readonly keep?: ((work: Promise<unknown>) => void) | undefined;
}

/**
 * How often a store's log is read, as the host gives it: a second unless given. A wait longer than
 * a timer waits is refused as the authority is made, rather than read as another by each turn:
 * Node would run the timer after 1 ms, and each turn would find the read not due, and wait again.
 */
export function pollIntervalOf(everyMs: number = EVERY_MS): number {
  if (!Number.isSafeInteger(everyMs) || everyMs <= 0 || everyMs > LONGEST_TIMER_MS) {
    throw new TypeError(
      `externalPollMs must be a positive whole number of milliseconds, at most ${String(LONGEST_TIMER_MS)}.`,
    );
  }
  return everyMs;
}

export class ExternalTail {
  readonly #followers: readonly ExternalFollower[];
  readonly #ingest: (rows: readonly RowChange[]) => Promise<void>;
  readonly #everyMs: number;
  readonly #retained: () => boolean;
  readonly #clock: () => number;
  readonly #schedule: ((at: number) => Promise<void>) | undefined;
  readonly #keep: ((work: Promise<unknown>) => void) | undefined;
  #following = 0;
  #due: number | undefined;
  #scheduled: number | undefined;
  #arming: Arming | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reading: Promise<void> | undefined;
  #next: Promise<void> | undefined;
  #polling = false;
  #refreshing = false;
  #stopped = false;

  constructor(options: ExternalTailOptions) {
    const { stores, tables } = options;
    const everyMs = pollIntervalOf(options.everyMs);
    const byStore = new Map<ExternalStore, Map<string, Table>>();
    for (const [name, store] of stores) {
      const table = tables.get(name);
      if (table === undefined) continue;
      let read = byStore.get(store);
      if (read === undefined) {
        read = new Map();
        byStore.set(store, read);
      }
      read.set(name, table);
    }
    const { readTimeoutMs } = options;
    this.#followers = [...byStore].map(
      ([store, read]) => new ExternalFollower(store, read, readTimeoutMs),
    );
    this.#ingest = options.ingest;
    this.#everyMs = everyMs;
    this.#retained = options.retained ?? (() => false);
    this.#clock = options.clock ?? Date.now;
    this.#schedule = options.schedule;
    this.#keep = options.keep;
  }

  async #readEach(): Promise<void> {
    let fault: { readonly error: unknown } | undefined;
    for (const follower of this.#followers) {
      if (this.#stopped) break;
      try {
        await follower.changed(async (rows) => {
          if (!this.#stopped) await this.#ingest(rows);
        });
      } catch (error) {
        // Other stores still progress, and this one's cursor stays before the failed ingest.
        fault ??= { error };
      }
    }
    if (fault !== undefined) throw fault.error;
  }

  #active(): boolean {
    return (
      !this.#stopped && this.#followers.length > 0 && (this.#following > 0 || this.#retained())
    );
  }

  #cancel(): void {
    this.#scheduled = undefined;
    this.#arming = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #arm(at: number, delay: number): void {
    const schedule = this.#schedule;
    if (schedule === undefined) return;
    const attempt = { at };
    this.#arming = attempt;
    const work = (async () => {
      try {
        await schedule(at);
        if (this.#arming !== attempt) return;
        this.#arming = undefined;
        this.#scheduled = at;
        if (!this.#active()) this.refresh();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          `An external store's next poll could not be scheduled: ${describeThrown(error)}`,
        );
        if (this.#arming !== attempt) return;
        if (!this.#active()) {
          this.refresh();
          return;
        }
        // Keep only the write attempt. Canceling this timer leaves no pending waitUntil promise.
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          if (this.#arming !== attempt) return;
          if (!this.#active()) {
            this.refresh();
            return;
          }
          this.#arm(at, Math.min(delay * 2, RETRY.maxMs));
        }, delay);
        (this.#timer as { unref?: () => void }).unref?.();
      }
    })();
    this.#keep?.(work);
  }

  /** Retention is checked after the answer, without a tick for an engine with no external store. */
  refreshLater(): void {
    if (this.#followers.length === 0 || this.#stopped || this.#refreshing) return;
    this.#refreshing = true;
    const refresh = (async () => {
      await nextTurn();
      this.#refreshing = false;
      this.refresh();
    })();
    this.#keep?.(refresh);
  }

  /** The next read, while streams or retained renderings need a store. */
  refresh(): void {
    if (!this.#active()) {
      this.#due = undefined;
      this.#cancel();
      return;
    }
    if (this.#polling) return;
    this.#due ??= this.#clock() + this.#everyMs;
    if (this.#scheduled === this.#due || this.#arming?.at === this.#due) return;
    if (this.#schedule === undefined) {
      this.#scheduled = this.#due;
      clearTimeout(this.#timer);
      this.#timer = setTimeout(
        () => {
          const work = (async () => {
            try {
              await this.run();
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error(describeThrown(error));
            }
          })();
          this.#keep?.(work);
        },
        Math.max(0, this.#due - this.#clock()),
      );
      (this.#timer as { unref?: () => void }).unref?.();
    } else {
      this.#arm(this.#due, RETRY.firstMs);
    }
  }

  /** A stream's hold, released once the stream closes. */
  follow(): () => void {
    this.#following += 1;
    this.refresh();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#following -= 1;
      this.refresh();
    };
  }

  /**
   * A host alarm or Node timer: only a due read runs, and a failed read is retried next turn.
   * Delivery may have consumed an earlier shared alarm, so the next read is armed again either way.
   */
  async run(): Promise<void> {
    if (this.#polling) return;
    this.#cancel();
    if (
      this.#stopped ||
      (this.#following === 0 && !this.#retained()) ||
      this.#due === undefined ||
      this.#clock() < this.#due
    ) {
      this.refresh();
      return;
    }
    this.#polling = true;
    try {
      await this.read();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `An external store's change log could not be ingested: ${describeThrown(error)}`,
      );
    } finally {
      this.#polling = false;
      this.#due = undefined;
      this.#scheduled = undefined;
      this.refresh();
    }
  }

  /**
   * One read now (poke): calls made during it share at most one read after it. A failure of
   * the previous read never leaves that queued read stuck on a rejected promise.
   */
  async read(): Promise<void> {
    if (this.#stopped) return;
    if (this.#reading !== undefined) {
      const previous = this.#reading;
      this.#next ??= (async () => {
        try {
          await previous;
        } catch {
          /* A queued read retries the failed one. */
        }
        this.#next = undefined;
        await this.read();
      })();
      return this.#next;
    }
    this.#reading = (async () => {
      try {
        await this.#readEach();
      } finally {
        this.#reading = undefined;
      }
    })();
    return this.#reading;
  }

  /** No read is scheduled after the authority closes. */
  stop(): void {
    this.#stopped = true;
    this.refresh();
  }
}
