import type { Frame } from '../program.ts';

/**
 * What the page keeps of the roots it shows no more — unmounted, hidden with a route the router
 * keeps in a hidden `<Activity>`, or shown no more in place, another root key taking its place: each
 * one's render as it showed it last, the frame with the tree it came with, by its root key, and the
 * root that kept it. A root mounted again from an older frame of it — a route gone back to, whose
 * tree is as it was first rendered — shows that render at once rather than be rendered again first
 * (`Page.kept`). Only a render that shows alike wherever it shows again is kept: one a stream
 * follows, rendered for no dynamic site — a tree rendered for sites holds for the view it was
 * rendered for alone — and holding no field, which a persistent state reads and the page's pending
 * operations show over. The 16 roots let go of last are kept, the least recently kept forgotten; and
 * the render a root kept is let go of once that root shows its root key again, on the page again.
 */

/** A root's render as the page showed it last: its frame, its tree as the host renders it (`T`). */
export interface KeptRoot<T> {
  readonly frame: Frame;
  readonly children: T;
  /** The session it was rendered for, as `renderRoot` names it. */
  readonly session: string | undefined;
}

/** A render kept, and the root that kept it: the `LiveRoot` that showed it, by its id. */
interface Kept<T> {
  readonly render: KeptRoot<T>;
  readonly by: string;
}

/** The most roots kept: past it, the least recently kept is forgotten. */
const MAX_KEPT_ROOTS = 16;

/** Whether a render at `frame` shows alike wherever it shows: followed, of no site and no field. */
function showsAlike(frame: Frame): boolean {
  return (
    frame.subscription !== '' &&
    Object.keys(frame.view).length === 0 &&
    Object.keys(frame.fields).length === 0
  );
}

/**
 * What stays kept of a root where `before` was kept and the root `by` showed it `render`: the newer
 * render, as `by`'s; `before` over an older one; and of one revision the tree shown last — a render
 * of the route may change a tree at one revision (`adopt`) — still as the root that kept it first:
 * a root shown from it, which React's development mount lets go of and mounts again, would else
 * take it over and let it go as it shows it again.
 */
function keptOver<T>(before: Kept<T>, by: string, render: KeptRoot<T>): Kept<T> {
  const { revision } = before.render.frame;
  if (revision > render.frame.revision) {
    return before;
  }
  return { by: revision === render.frame.revision ? before.by : by, render };
}

export class KeptRoots<T> {
  /** The renders kept, by root key, the least recently kept first. */
  readonly #roots = new Map<string, Kept<T>>();

  /**
   * Keeps `render`, which the root `by` showed, as the most recently kept, where it shows alike
   * wherever it shows: of two renders of one root — two places that showed it — the newer, and of
   * one revision the tree shown last (`keptOver`).
   */
  keep(by: string, render: KeptRoot<T>): void {
    if (!showsAlike(render.frame)) {
      return;
    }
    const { rootKey } = render.frame;
    const before = this.#roots.get(rootKey);
    this.#roots.delete(rootKey);
    this.#roots.set(rootKey, before === undefined ? { by, render } : keptOver(before, by, render));
    for (const oldest of this.#roots.keys()) {
      if (this.#roots.size <= MAX_KEPT_ROOTS) {
        break;
      }
      this.#roots.delete(oldest);
    }
  }

  /** The render kept of the root `rootKey`, if any. */
  of(rootKey: string): KeptRoot<T> | undefined {
    return this.#roots.get(rootKey)?.render;
  }

  /**
   * The root `by` shows the root `rootKey` again — on the page again: React's second mount in
   * development, a route shown again from a hidden `<Activity>`, a root key back in place — and lets
   * go of the render it kept of it. One another root kept stays.
   */
  shownAgain(by: string, rootKey: string): void {
    if (this.#roots.get(rootKey)?.by === by) {
      this.#roots.delete(rootKey);
    }
  }

  /** Forgets every render kept: the page shows another session, or none. */
  forget(): void {
    this.#roots.clear();
  }
}
