/**
 * When the page asks its roots to render again. Each root renders itself again, through its own
 * controller (`view.ts`), for the view it shows — never the route, which renders a root for the
 * sites its states' first values show — and keeps to one request at a time, folding the revisions
 * it is told of meanwhile into the next, and sending again a request that fails or brings no answer
 * in time. The page tells every root: of the revision one of its writes committed at, which a frame
 * of each must reflect before the store lets the write go; and that a write was let go of whose
 * effect the page cannot show from what it holds, after which every root renders again whatever
 * revision it shows. The route itself renders again (`router.refresh`) once the session ended: once
 * for the page, through the root attached last.
 */

/** A root the page renders, as the page asks it to render again. */
export interface RefreshTarget {
  /** A revision newer than the root's frame may show something else. */
  readonly want: (revision: number) => void;
  /** Renders the root again, whatever revision it shows. */
  readonly force: () => void;
  /** Renders the route again: the router's `refresh`. */
  readonly refresh: () => void;
}

export class Refresher {
  readonly #roots = new Map<string, RefreshTarget>();

  /** A root shows a frame, the first time it renders and each time it shows another. */
  attach(root: string, target: RefreshTarget): void {
    this.#roots.set(root, target);
  }

  detach(root: string): void {
    this.#roots.delete(root);
  }

  /** Some write committed at `revision`: each root renders again unless it shows it already. */
  want(revision: number): void {
    for (const target of this.#roots.values()) {
      target.want(revision);
    }
  }

  /** Renders every root again, whatever revision it shows. */
  force(): void {
    for (const target of this.#roots.values()) {
      target.force();
    }
  }

  /** Renders the route again, every root of it: the session ended. */
  refresh(): void {
    [...this.#roots.values()].at(-1)?.refresh();
  }

  dispose(): void {
    this.#roots.clear();
  }
}
