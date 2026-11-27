/**
 * When the page asks its roots to render again. Each root renders itself again, through its own
 * controller (`view.ts`), for the view it shows — never the route, which renders a root for the
 * sites its states' first values show — and keeps to one request at a time, folding the revisions
 * it is told of meanwhile into the next, and sending again a request that fails or brings no answer
 * in time. The page tells every root: of the revision one of its writes committed at, which a frame
 * of each must reflect before the store lets the write go; and that a write was let go of whose
 * effect the page cannot show from what it holds, after which every root renders again whatever
 * revision it shows. The route itself renders again (`router.refresh`) once the session ended: once
 * for the page, through the root attached last — of a build whose roots the deployment's cache
 * keeps, by the expiry of the session's kept renders, whose answer renders it (`refreshExpired`).
 */

/** Has the route render again where `expire` fails: its own answer renders it otherwise. */
async function refreshedIfFailed(
  refresh: () => void,
  expire: () => Promise<unknown>,
): Promise<void> {
  try {
    await expire();
  } catch {
    refresh();
  }
}

/**
 * Has the route render again: at once (`refresh`), or, of a build whose roots the deployment's cache
 * keeps, by `expire` — the compile's Server Function, which expires the session's kept renders and
 * then calls Next.js's `refresh()`, so that its answer carries the route's render, of the
 * authority's, which the router shows — and by `refresh` only where that call fails. A refresh after
 * its answer would render the route a second time, every root asking the authority again; and no
 * wait of this one's bounds a call under way, as Next.js's router runs a refresh asked for meanwhile
 * behind it (`app-router-instance.js`).
 */
export function refreshExpired(
  refresh: () => void,
  expire: (() => Promise<unknown>) | undefined,
): void {
  if (expire === undefined) {
    refresh();
    return;
  }
  void refreshedIfFailed(refresh, expire).catch(() => {
    // The refresh itself is the router's: nothing is left to tell of it here.
  });
}

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
