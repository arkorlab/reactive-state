import type { Frame } from '../program.ts';
import { BUILD_MISMATCH } from '../status.ts';
import { Refresher, type RefreshTarget } from './refresh.ts';
import { PageStore, type StoreOptions } from './store.ts';

/**
 * A page in the browser: its store of pending operations, and what its roots are told to render
 * again for. One per page, made the first time a root renders in the browser and never on the
 * server, where a module's state outlives the request — and kept under a registered symbol, so that
 * every copy of this package a bundle holds shares it.
 */

interface PageOptions extends Omit<
  StoreOptions,
  'onCommitted' | 'onOffline' | 'onRefused' | 'onRevoked'
> {
  /** The wait before a store that went offline sends again, unless a render says sooner. */
  readonly recoveryDelay?: number;
}

/** What a root shows, as it attaches it, and how it renders again. */
interface RootView extends RefreshTarget {
  readonly frame: Frame;
  /** The session it was rendered for, as `renderRoot` names it; one name for every root of it. */
  readonly session: string | undefined;
}

const RECOVERY_DELAY_MS = 1000;
/**
 * The most answered catch-ups kept for roots that did not show: a navigation let go of before it
 * ended. One still under way is kept however many there are: its root waits on it.
 */
const MAX_CATCH_UPS = 16;

/** A catch-up a root waits on before it shows, and whether it has answered. */
interface CatchUp {
  readonly promise: Promise<unknown>;
  answered: boolean;
}
/** The most roots the page remembers the newest shown revision of (`carriedFloor`), the least recent let go. */
const MAX_SHOWN_ROOTS = 256;

export class Page {
  readonly #refresher = new Refresher();
  readonly #recoveryDelay: number;
  #recovery: ReturnType<typeof setTimeout> | undefined;
  /** The newest revision the page was told of: by a frame a root showed, a commit, a stream. */
  #newest = -Infinity;
  /** The newest revision each root was shown at on the page, by its root key, the most recent last. */
  readonly #shown = new Map<string, number>();
  /** The newest revision of the roots `#shown` let go of: what it forgot showed no newer. */
  #forgotten = -Infinity;
  /** The newest revision a write of the page's own committed at. */
  #written = -Infinity;
  /** What each root mounted with an older frame waits for before it shows, by its frame. */
  readonly #catchUps = new Map<string, CatchUp>();
  readonly store: PageStore;

  constructor(options: PageOptions = {}) {
    this.#recoveryDelay = options.recoveryDelay ?? RECOVERY_DELAY_MS;
    this.store = new PageStore({
      ...options,
      onCommitted: (revision) => {
        this.saw(revision);
        this.#written = Math.max(this.#written, revision);
        this.#refresher.want(revision);
      },
      // An operation whose outcome stayed unknown: the roots render again — which resumes the store
      // once one answers — and the store is resumed after a wait all the same, for a page whose
      // render does not answer.
      onOffline: () => {
        this.#refresher.force();
        clearTimeout(this.#recovery);
        this.#recovery = setTimeout(() => {
          this.#recovery = undefined;
          this.store.resume();
        }, this.#recoveryDelay);
      },
      onRefused: () => {
        this.#refresher.force();
      },
      // The session ended: the route renders again, for whoever the browser is now.
      onRevoked: () => {
        this.#refresher.refresh();
      },
    });
  }

  /** Notes that the root `rootKey` was shown at `revision`, as its most recent. */
  #showed(rootKey: string, revision: number): void {
    const before = this.#shown.get(rootKey) ?? -Infinity;
    this.#shown.delete(rootKey);
    this.#shown.set(rootKey, Math.max(before, revision));
    for (const [oldest, shown] of this.#shown) {
      if (this.#shown.size <= MAX_SHOWN_ROOTS) {
        break;
      }
      this.#forgotten = Math.max(this.#forgotten, shown);
      this.#shown.delete(oldest);
    }
  }

  /** A root shows `view.frame`: the first time it renders, and each time a render brings one. */
  attach(root: string, view: RootView): void {
    const { force, refresh, want } = view;
    this.saw(view.frame.revision);
    this.#showed(view.frame.rootKey, view.frame.revision);
    this.store.attach(root, view.frame, view.session);
    this.#refresher.attach(root, { force, refresh, want });
  }

  /** The newest revision the page was told of; none before a root has shown. */
  get newest(): number {
    return this.#newest;
  }

  /**
   * The oldest revision a frame of the root `rootKey` — its props, its session — that a link's
   * prefetch carried shows at once at: the newest the page showed that root at, or at most showed a
   * root it let go of the memory of; and the newest a write of the page's own committed at, which
   * an older frame would show undone. None, and any frame does.
   */
  carriedFloor(rootKey: string): number {
    return Math.max(this.#shown.get(rootKey) ?? this.#forgotten, this.#written);
  }

  /** The authority is at `revision` at least: a frame showed it, a commit or a stream told of it. */
  saw(revision: number): void {
    this.#newest = Math.max(this.#newest, revision);
  }

  /**
   * What a root waits for before it shows a frame older than one the page showed since — a route
   * the router kept, gone back to — `render`'s answer, asked for once for `key`: each render that
   * waits is handed the same promise, as React's `use` asks, until the root has shown (`settled`).
   */
  catchUp<T>(key: string, render: () => Promise<T>): Promise<T> {
    const kept = this.#catchUps.get(key);
    if (kept !== undefined) {
      return kept.promise as Promise<T>;
    }
    const promise = render();
    const made: CatchUp = { answered: false, promise };
    const answered = (): void => {
      made.answered = true;
    };
    void promise.then(answered).catch(answered);
    this.#catchUps.set(key, made);
    // Only an answered one is let go of: a root waits on one under way, and a root that has not
    // shown asks again on each render — let go of, it would ask anew, and let go of another's.
    for (const [stale, each] of this.#catchUps) {
      if (this.#catchUps.size <= MAX_CATCH_UPS) {
        break;
      }
      if (each.answered) {
        this.#catchUps.delete(stale);
      }
    }
    return promise;
  }

  /** The root that waited for the catch-up `key` has shown. */
  settled(key: string): void {
    this.#catchUps.delete(key);
  }

  detach(root: string): void {
    this.store.detach(root);
    this.#refresher.detach(root);
  }

  /**
   * A root's stream says no more: the session ended, and nothing more is sent — or the page's
   * build is not the authority's, and it is asked to reload.
   */
  revoked(message: string | undefined, code?: string): void {
    if (code === BUILD_MISMATCH) {
      this.store.mismatched();
    } else {
      this.store.revoke(message);
    }
  }

  dispose(): void {
    clearTimeout(this.#recovery);
    this.store.dispose();
    this.#refresher.dispose();
  }
}

const PAGE: unique symbol = Symbol.for('arkorlab.reactive-state.page');

interface Holder {
  [PAGE]?: Page | undefined;
}

/** The page's runtime, made the first time it is asked for. Browser only. */
export function page(): Page {
  const holder = globalThis as Holder;
  const existing = holder[PAGE];
  if (existing !== undefined) {
    return existing;
  }
  const made = new Page();
  holder[PAGE] = made;
  return made;
}

/**
 * Forgets the page's runtime, as a page that is unloaded does: its pending operations, its roots.
 * The next root to render makes another.
 */
export function resetPage(): void {
  const holder = globalThis as Holder;
  holder[PAGE]?.dispose();
  holder[PAGE] = undefined;
}
