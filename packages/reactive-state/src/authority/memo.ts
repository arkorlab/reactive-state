import type { Dependencies, RowChange } from './dependencies.ts';
import type { Output } from './skeleton.ts';

/**
 * What one component rendered, with what it and every component it renders read: the memo's entry
 * for the component, its props, the user and the build. It holds no field's value and no binding —
 * those are read and signed for each render, for its session — so one user's sessions share it.
 */
export interface MemoEntry {
  readonly output: Output;
  readonly dependencies: Dependencies;
  /** How many components it rendered, itself included, toward a render's limit. */
  readonly instances: number;
  /**
   * What it, or a component it renders, read that only the request answers (`Call.requestBound`),
   * where it read one: kept with it, for a render that takes it from the memo to be the request's as
   * the render that evaluated it was — never a view every visitor shares (`keptOf`).
   */
  readonly requestBound?: string | undefined;
}

/** How many components the memo keeps the rendering of, the least recently used let go first. */
const MEMO_ENTRIES = 10_000;
/**
 * How long a rendering is kept, whatever commits: what a component read other than the database —
 * the clock, another service it asks — is read again at least this often.
 */
const MEMO_TTL_MS = 30_000;

/**
 * The renderings of components a commit has not changed what they read of, kept so that a render
 * of a page reads again only what a commit changed: each is let go of by the first commit that
 * changes a record it read or a record one of its queries names, before or after (`Dependencies`),
 * and once it is `MEMO_TTL_MS` old, since a component may read what no commit says the change of.
 * A render runs alone in the authority's queue, so nothing commits while one is made.
 */
export class Memo {
  readonly #entries = new Map<string, { readonly entry: MemoEntry; readonly at: number }>();
  readonly #clock: () => number;
  readonly #limit: number;
  readonly #ttlMs: number;

  constructor(clock: () => number = Date.now, limit = MEMO_ENTRIES, ttlMs = MEMO_TTL_MS) {
    this.#clock = clock;
    this.#limit = limit;
    this.#ttlMs = ttlMs;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Whether a live rendering still depends on one of `tables`; expired renderings are let go. */
  retains(tables: ReadonlySet<string>): boolean {
    let retained = false;
    const now = this.#clock();
    for (const [key, { at, entry }] of this.#entries) {
      if (now - at >= this.#ttlMs) {
        this.#entries.delete(key);
      } else if (entry.dependencies.reads(tables)) {
        retained = true;
      }
    }
    return retained;
  }

  get(key: string): MemoEntry | undefined {
    const kept = this.#entries.get(key);
    if (kept === undefined) {
      return undefined;
    }
    this.#entries.delete(key);
    if (this.#clock() - kept.at >= this.#ttlMs) {
      return undefined;
    }
    // The most recently used, last.
    this.#entries.set(key, kept);
    return kept.entry;
  }

  set(key: string, entry: MemoEntry): void {
    this.#entries.delete(key);
    this.#entries.set(key, { at: this.#clock(), entry });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#limit) {
        break;
      }
      this.#entries.delete(oldest);
    }
  }

  /** Lets go of every rendering a commit of `rows` changed what it read of: how many it let go. */
  evict(rows: readonly RowChange[]): number {
    if (rows.length === 0) {
      return 0;
    }
    let evicted = 0;
    for (const [key, { entry }] of this.#entries) {
      if (entry.dependencies.changedBy(rows)) {
        this.#entries.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }
}
