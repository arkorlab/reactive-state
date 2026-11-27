import type { Frame } from '../program.ts';

/**
 * Whether the page's store is revoked, why, and what lets the revocation go.
 *
 * A session that ended — a write or a stream refused the session, the authority's refusal of it on
 * a stream — revokes the store until the page shows another session: nothing of the one that ended
 * is the reader's. So does any other final refusal of a stream's opening by a code of the
 * framework's own — a 403, a 404, a 400 of the route or of the authority's own checks: a render may
 * succeed while such a stream stays refused, so a revocation one let go of would be made again —
 * the route rendered again, a root attached, its stream refused — without end. A build the
 * authority no longer runs revokes it until the page is reloaded (`PageStore.mismatched`). Any of
 * these after a root's own refusal replaces it, says its own message and holds, and drops every
 * write the page kept; a session's end and a refusal of the framework's own render the route again
 * for it, as the first.
 *
 * A root's own refusal — its render refused by the application, with a code of its own
 * (`refuse(code)`, 422), as its stream opened — is no end of the session. The revocation it makes
 * holds while the refused root shows the frame it showed as it was refused, and is let go of once
 * that root is gone — the application's boundary drew in its place, the page left it — or shows
 * another frame, and a root of the session shows a frame that is none of those the page showed as
 * the hold began: a later page's roots, the refreshed route's, a newer answer of a root the page
 * kept showing. A root refused while another's refusal holds the page is said, the route rendered
 * again for it, and it holds the page as well, each refused root by its own frame: the frames shown
 * as the hold began alone let nothing go, so a frame another root rendered since lets it go once
 * every refused root is gone or shows another frame. The writes the page made are kept through it,
 * and sent once it goes, and what the store said of them before it is said again.
 *
 * That cannot loop. As it is revoked the page renders the route again (`onRevoked`), where the
 * application's server renders the refused root again — of a build whose roots the deployment's
 * cache keeps, through `expire` (`refreshExpired`), which expires the session's kept renders first,
 * so that none kept from before the refusal is served in its place — and has every root it shows
 * render itself again (`Page.revoked`): a root showing a site the page opened, of the newest
 * revision already, takes no render of the route's, which does not cover its view, and asks for
 * nothing newer, so its frame of before the hold would keep the page held once the refused root is
 * gone. Where the refused root is refused alike, `renderRoot` throws the refusal, which the
 * application's boundary draws in the root's place: no frame of that root attaches, and no stream
 * of it opens. Where it is not — the refusal was of a site the page opened, of inputs the route's
 * render of the states' first values does not show — the root keeps the frame it showed, which the
 * route's render does not cover, and holds the page as before: its stream ended at `revoked`, and
 * its view is refused for good, which revokes nothing. Both come once for each root refused, which
 * a root refused already does not ask again. A frame of a refused root rendered before the refusal
 * and shown after it — a link's prefetch carried it, the router kept it — lets the revocation go
 * where the root was gone, and its stream, as it opens, refuses it again: the page is revoked once
 * more, and renders the route again — once for each such frame a navigation shows, and never of
 * itself.
 *
 * No revision tells a frame rendered after the refusal from one rendered before it: the refusal
 * names none, one no write made leaves the authority's revision where it was, and a frame a link's
 * prefetch carried shows at once though it is older than the page's newest (`carriedFloor`), while
 * its stream says nothing where nothing changed — a floor of revisions would keep the page revoked
 * under roots that all render.
 */

/** A root the page shows, as its store holds it: the frame, and the session it was rendered for. */
interface Shown {
  readonly frame: Frame;
  readonly session: string | undefined;
}

/** What the store is revoked for, and what the page shows as it is. */
interface Ending {
  readonly message: string;
  /** Whether the page's build is not the authority's: a reload is asked for. */
  readonly mismatched: boolean;
  /** The root whose own refusal it is; none for a session's end. */
  readonly refused: string | undefined;
  /** The roots the page shows, by the names the store holds them by. */
  readonly roots: ReadonlyMap<string, Shown>;
}

/**
 * How each page's store is revoked for a root's own refusal, by the store: the page's alone to ask
 * for (`refuseRoot`). No entry of the package exports this module, and `PageStore.revoke` stays the
 * session's end.
 */
const REFUSALS = new WeakMap<WeakKey, (root: string, message: string | undefined) => boolean>();

export class Revocation {
  /**
   * The frames the page showed as the hold began — its first root's own refusal — none of which
   * lets it go.
   */
  readonly #shown = new Set<Frame>();
  /**
   * The roots refused, each by the frame it showed as it was: each is gone, or shows another, before
   * the store is let go.
   */
  readonly #refused = new Map<string, Frame | undefined>();
  #revoked = false;
  /** Whether a root's own refusal holds the store, and nothing that ended the session since. */
  #lapsing = false;
  #message: string | undefined = undefined;

  /**
   * `store`'s revocation, which `refuseRoot` revokes for a root's own refusal through `refuse`: the
   * store's own end of it, of the root and the message, which answers whether the page was told.
   */
  constructor(store: WeakKey, refuse: (root: string, message: string | undefined) => boolean) {
    REFUSALS.set(store, refuse);
  }

  /** Whether the store is revoked: it sends nothing, and takes no write. */
  get revoked(): boolean {
    return this.#revoked;
  }

  /**
   * Whether the store is revoked for good — the session ended, or a reload is asked for — rather
   * than for a root's own refusal alone, through which it keeps its writes, and hears the answers
   * of those on their way.
   */
  get ended(): boolean {
    return this.#revoked && !this.#lapsing;
  }

  /**
   * Why the page stopped, while it is revoked: the message of the last revocation it was told of
   * (`revoke`), or a reload's.
   */
  get message(): string | undefined {
    return this.#message;
  }

  /**
   * Revokes the store. Whether the page is told of it — it says its message, and has the route
   * rendered again: it is the first, or a session's end after a root's own refusal, which starts the
   * revocation afresh, held for good; or the refusal of a root not refused yet while a root's own
   * refusal holds the store, which adds that root to those that hold it. A root's own refusal after
   * a session's end, or of a root refused already, is told of nothing.
   */
  revoke({ message, mismatched, refused, roots }: Ending): boolean {
    const afresh = !this.#revoked || (this.#lapsing && refused === undefined);
    if (afresh) {
      this.#shown.clear();
      this.#refused.clear();
      this.#lapsing = refused !== undefined;
      if (this.#lapsing) {
        for (const { frame } of roots.values()) {
          this.#shown.add(frame);
        }
      }
    }
    const added = refused !== undefined && this.#lapsing && !this.#refused.has(refused);
    if (added) {
      this.#refused.set(refused, roots.get(refused)?.frame);
    }
    // The message stands of what the page is told of; a reload asked for says more than any.
    if (afresh || added || mismatched) {
      this.#message = message;
    }
    this.#revoked = true;
    return afresh || added;
  }

  /**
   * Lets go of a root's own refusal where the roots the page shows, `roots`, let it go: each root
   * refused is gone, or shows another frame than it showed as it was, and a root of `session` shows
   * a frame the page did not show as the hold began.
   */
  lapse(roots: ReadonlyMap<string, Shown>, session: string | undefined): void {
    if (!this.#lapsing) {
      return;
    }
    for (const [root, refusedWith] of this.#refused) {
      const shown = roots.get(root);
      if (shown !== undefined && shown.frame === refusedWith) {
        return;
      }
    }
    for (const shown of roots.values()) {
      if (shown.session === session && !this.#shown.has(shown.frame)) {
        this.clear();
        return;
      }
    }
  }

  /** The store is revoked no more: the page shows another session, or lets a root's refusal go. */
  clear(): void {
    this.#revoked = false;
    this.#lapsing = false;
    this.#message = undefined;
    this.#shown.clear();
    this.#refused.clear();
  }
}

/**
 * Revokes `store` for the root `root`'s own refusal, saying `message` — the store's own message
 * where none is said (`Revocation`). Whether the page was told of it (`revoke`): the route renders
 * again for it then, and so must every root the page shows (`Page.revoked`).
 */
export function refuseRoot(store: WeakKey, root: string, message: string | undefined): boolean {
  return REFUSALS.get(store)?.(root, message) ?? false;
}
