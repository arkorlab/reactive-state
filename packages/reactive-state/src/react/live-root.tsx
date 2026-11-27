'use client';

import { useRouter } from 'next/navigation';
import {
  Fragment,
  type ReactNode,
  startTransition,
  use,
  useEffect,
  useId,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { FieldReceipt, Frame, RenderStatus, Result, View } from '../program.ts';
import { isApplicationCode } from '../refusal-codes.ts';
import { Follower } from '../runtime/follow.ts';
import { canonicalJson } from '../runtime/json.ts';
import type { KeptRoot } from '../runtime/kept-roots.ts';
import { type Page, page } from '../runtime/page.ts';
import { refreshExpired } from '../runtime/refresh.ts';
import type { StoreStatus } from '../runtime/store.ts';
import { type ViewAnswer, ViewController, type ViewHost } from '../runtime/view.ts';
import { type Live, LiveContext } from './state.ts';

/**
 * A root the authority rendered, as the page shows it: the tree `renderRoot` made of what the
 * authority answered (`children`), and the frame it was rendered at, which the states inside it
 * read their fields from. The two arrive together — in the page, in the answer to the root's `view`
 * Server Function, or in a render of the route — and are shown together: a frame older than the one
 * shown, of the same root, is let go of with the tree it came with, so the page never goes back to
 * a revision it has moved past, nor shows a tree with values of another revision than its own. A
 * root mounted with a frame older than one the page has shown since — a route the router kept, gone
 * back to, whose tree is as it was first rendered — shows at once what the page kept of that root as
 * a root let it go (unmounted, hidden with its route, or another root key shown in its place),
 * where it kept that: the render of a root a link's prefetch may carry, rendered for no site and
 * holding no field, as new as anything the page showed of the root and as the page's own writes
 * (`Page.kept`); and asks for the root again at once, whose answer takes its place a round trip
 * later. Otherwise it is rendered again before it shows, the navigation that brings it holding the
 * page as it was meanwhile.
 *
 * In the browser it follows the root's event stream, and renders the root again — itself, through
 * its `view` Server Function, for the sites the page shows (`useSites`) — once the frame shown was
 * not rendered for a site the page shows, or the stream, or the answer to one of the page's writes,
 * tells of a revision newer than the frame's. A render of the route, which renders the root for the
 * sites its states' first values show, is shown while it shows every site the page shows; otherwise
 * it only tells of its revision. The route renders again (`router.refresh`) once the session ended
 * or changed, or the root's own render was refused it (`Page.revoked`, which this root's stream
 * names it to) — of a build whose roots the deployment's cache keeps, by the expiry of the session's
 * kept renders, whose answer renders it (`expire`). A root rendered with another key — the props it
 * was rendered with, or the session, changed — is followed anew.
 */

export interface LiveRootProps {
  /** The frame the tree was rendered at. */
  readonly frame: Frame;
  /** The compile's `update` Server Function, which the root's setters write through. */
  readonly update: (input: unknown) => Promise<Result<FieldReceipt>>;
  /** The compile's `view` Server Function, which renders the root again for what the page shows. */
  readonly view: (input: unknown) => Promise<Result<ViewAnswer<ReactNode>>>;
  /** Where the root's event stream is read from (`?subscription=` is added). */
  readonly events: string;
  /**
   * The session the root was rendered for, as `renderRoot` names it: a frame of another session
   * shows none of the operations made under the one before, and drops them.
   */
  readonly session?: string | undefined;
  /** Whether the session may see the root; a root of nobody's session is not followed. */
  readonly status?: RenderStatus | undefined;
  /** The tree the authority rendered, as React elements. */
  readonly children?: ReactNode;
  /**
   * Whether the root's render may come from a private cache a link's prefetch carried, older than
   * what the page was told of since (`'use cache: private'`): shown at once all the same, and set
   * right by its stream, unless the page showed this very root at a newer revision already, which it
   * never goes back from — then what the page kept of the root shows at once in its place, where it
   * kept that (`Page.kept`), the root asked for again at once, and the root is rendered again first
   * where it did not. Only such a root's render is kept, where the route rendered it for the session
   * (`status` `rendered`).
   */
  readonly prefetchable?: boolean | undefined;
  /**
   * The compile's `expire` Server Function, of a build whose roots the deployment's cache keeps
   * (`'use cache: remote'`): called in place of `router.refresh()` for a session that ended,
   * changed or was refused. It expires the session's kept renders, and its answer renders the route
   * again — the authority's render, not the one the cache kept of the session before — which the
   * router shows; the root calls `router.refresh()` only where that call fails.
   */
  readonly expire?: (() => Promise<unknown>) | undefined;
}

interface Shown {
  readonly frame: Frame;
  readonly children: ReactNode;
  /** Whether it is what the page kept of the root, shown at once: asked for again as it shows. */
  readonly kept?: true;
}

/** What a root shows, and what the route rendered it with last. */
interface RootState {
  readonly shown: Shown;
  readonly given: Shown;
}

const UPDATED = 'The application was updated. Reload the page.';
const RECONNECTING = 'Reconnecting…';

/**
 * What a root shows once the route renders it with `given`: that, unless it is of the same root and
 * older than the frame shown, or was rendered for other sites than the page shows (`takes`).
 */
function adopt(shown: Shown, given: Shown, takes: (view: View) => boolean): Shown {
  const { children, frame } = given;
  if (frame === shown.frame) {
    return children === shown.children ? shown : given;
  }
  if (frame.rootKey !== shown.frame.rootKey) {
    return given;
  }
  return frame.revision < shown.frame.revision || !takes(frame.view) ? shown : given;
}

/** The view Server Function, as the root calls it. */
type ViewFunction = LiveRootProps['view'];

/** A catch-up a root waits for as it mounts: its key, and what it shows once it is in. */
interface CatchUp {
  readonly key: string;
  readonly caught: Promise<Shown | undefined>;
}

/** Longer than the authority takes to render a root again; past it, a root shows what it has. */
const CATCH_UP_MS = 5000;

/**
 * The root rendered again at the authority's revision, for the view `frame` was rendered for: what
 * it shows instead of `frame`, or nothing — another session's answer, a refusal, no answer in time
 * — where it shows `frame` and follows it from there.
 */
async function caughtUpWith(view: ViewFunction, frame: Frame): Promise<Shown | undefined> {
  // Called once the render that asks has let go: a Server Function's call updates the router's
  // state, which no render may.
  await Promise.resolve();
  let late: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    late = setTimeout(() => {
      resolve(null);
    }, CATCH_UP_MS);
  });
  let result: Result<ViewAnswer<ReactNode>> | null;
  try {
    // The view the subscription names: the frame's, which the request changes nothing of.
    const asked = view({ subscription: frame.subscription, view: {} });
    result = await Promise.race([asked, timedOut]);
  } catch {
    result = null;
  } finally {
    clearTimeout(late);
  }
  const renderedAt = result?.ok === true ? result.value.frame : undefined;
  return renderedAt?.rootKey === frame.rootKey &&
    renderedAt.revision >= frame.revision &&
    result?.ok === true
    ? { children: result.value.children, frame: renderedAt }
    : undefined;
}

/** The key a catch-up of `frame` is kept under, for every render that waits for it. */
function catchUpKey(frame: Frame): string {
  return `${frame.subscription}@${String(frame.revision)}`;
}

/**
 * What a root about to show an older frame shows in its place: what the page kept of it, at once —
 * the root asked for again as it shows — or the root rendered again, once its catch-up is in.
 */
type Instead = CatchUp | Shown;

/** Whether a root waits for `instead` before it shows: a catch-up, not a render the page kept. */
function waits(instead: Instead): instead is CatchUp {
  return 'caught' in instead;
}

/** How a root about to show a frame is rendered again, and whether a prefetch may carry it. */
interface InsteadOptions {
  readonly view: ViewFunction;
  readonly prefetchable: boolean | undefined;
}

/**
 * What a root about to show `frame` — mounted with it, or shown in another root's place — shows
 * first, where the frame is older than one the page has shown since — the route the router kept,
 * gone back to, whose tree is as it was first rendered: what the page kept of that root as a root
 * let it go, at once, marked `kept` to be asked for again as it shows, where a link's prefetch may
 * carry the root and the page kept a render of it as new as anything it showed of it
 * (`Page.kept`); otherwise the root rendered again, which it waits for. Nothing for a frame the page
 * has shown nothing newer than, nor on the server, nor for a root nobody's session follows.
 */
function insteadOf(
  runtime: Page | null,
  frame: Frame,
  options: InsteadOptions,
): Instead | undefined {
  if (runtime === null || frame.subscription === '' || frame.revision >= runtime.newest) {
    return undefined;
  }
  if (options.prefetchable === true) {
    // A frame a link's prefetch carried shows at once, older than the page's newest though it is,
    // where the page showed nothing newer of this very root, and wrote nothing since: its stream, as
    // it opens, sets it right.
    if (frame.revision >= runtime.carriedFloor(frame.rootKey)) {
      return undefined;
    }
    // Where it showed newer, what it kept of the root as it let it go — newer than `frame`, then —
    // shows at once in its place, and the root is asked for again as it shows.
    const kept = runtime.kept(frame.rootKey);
    if (kept !== undefined) {
      return { children: kept.children as ReactNode, frame: kept.frame, kept: true };
    }
  }
  const key = catchUpKey(frame);
  const { view } = options;
  return { caught: runtime.catchUp(key, async () => caughtUpWith(view, frame)), key };
}

/** What a root shows once its `view` Server Function answers: the answer, unless it is older. */
function answered(shown: Shown, answer: ViewAnswer<ReactNode>): Shown {
  const { children, frame } = answer;
  return frame.rootKey !== shown.frame.rootKey || frame.revision < shown.frame.revision
    ? shown
    : { children, frame };
}

function subscriptionUrl(events: string, subscription: string): string {
  const url = new URL(events, globalThis.location.href);
  url.searchParams.set('subscription', subscription);
  return url.href;
}

/** The page's runtime in the browser; none on the server, where nothing is followed or written. */
function usePage(): Page | null {
  return 'window' in globalThis ? page() : null;
}

function ignore(): void {
  // Nothing was subscribed to.
}

function unsubscribed(): () => void {
  return ignore;
}

const IDLE: StoreStatus = Object.freeze({
  error: null,
  mismatched: false,
  offline: false,
  pending: 0,
  primary: undefined,
  revoked: false,
});

function idle(): StoreStatus {
  return IDLE;
}

/** What the page says of its operations, said once for the page by its first root. */
function Notice({ status }: { readonly status: StoreStatus }): ReactNode {
  if (status.mismatched) {
    return (
      <p data-reactive-state="notice" role="alert">
        {status.error ?? UPDATED}{' '}
        <button
          type="button"
          onClick={() => {
            globalThis.location.reload();
          }}
        >
          Reload
        </button>
      </p>
    );
  }
  const message = status.error ?? (status.offline ? RECONNECTING : null);
  if (message === null) {
    return null;
  }
  return (
    <p data-reactive-state="notice" role="alert">
      {message}
    </p>
  );
}

/**
 * Whether a root shown at `frame` is followed: not where the session may not see it, nor while it
 * shows the frame its stream was refused at by the application (`refusedAt`).
 */
function followed(status: RenderStatus, frame: Frame, refusedAt: Frame | undefined): boolean {
  return status !== 'unauthenticated' && frame !== refusedAt;
}

export function LiveRoot(props: LiveRootProps): ReactNode {
  const { events, expire, frame, prefetchable, session, status = 'rendered', update, view } = props;
  const router = useRouter();
  const runtime = usePage();
  const root = useId();
  // A root about to show a frame older than one the page showed since — mounted with it, or another
  // root shown in its place, as a route the router kept and is gone back to is — shows at once what
  // the page kept of it, where it kept that (`Page.kept`), and asks for it again as it shows; or is
  // rendered again before it shows: the page never goes back to a revision it has moved past. React
  // keeps the page as it was meanwhile, the navigation that brought the root a transition.
  const [mounting] = useState(() => insteadOf(runtime, frame, { prefetchable, view }));
  const caught = mounting !== undefined && waits(mounting) ? use(mounting.caught) : mounting;
  const [state, setState] = useState<RootState>(() => {
    const given = { children: props.children, frame };
    return { given, shown: caught ?? given };
  });
  useEffect(() => {
    runtime?.settled(catchUpKey(state.given.frame));
  }, [runtime, state.given.frame]);
  // What the root's controller calls, the newest of each as a render commits.
  const calls = useRef({ expire, router, runtime, view });
  useInsertionEffect(() => {
    calls.current = { expire, router, runtime, view };
  });
  const host = useMemo<ViewHost<ReactNode>>(() => {
    return {
      adopt: (answer) => {
        startTransition(() => {
          setState((current) => {
            const shown = answered(current.shown, answer);
            return shown === current.shown ? current : { ...current, shown };
          });
        });
      },
      refresh: () => {
        refreshExpired(() => {
          calls.current.router.refresh();
        }, calls.current.expire);
      },
      request: async (request) => calls.current.view(request),
      revoked: (message, code) => {
        calls.current.runtime?.revoked(message, code);
      },
    };
  }, []);
  const { rootKey } = state.shown.frame;
  // One for each root: another root key — the session, the props — is another root.
  const controller = useMemo(
    () => (runtime === null ? null : new ViewController(rootKey, host)),
    [host, rootKey, runtime],
  );
  let current = state.shown;
  const given =
    state.given.frame === frame && state.given.children === props.children
      ? state.given
      : { children: props.children, frame };
  if (given !== state.given) {
    current = adopt(state.shown, given, (shownView) => {
      // A root the session may not see shows no site; one rendered after the authority refused
      // the session is taken whole, with the subscription it brings.
      return (
        status !== 'rendered' ||
        controller === null ||
        controller.refreshing ||
        controller.covers(shownView)
      );
    });
    if (current === given && given.frame.rootKey !== state.shown.frame.rootKey) {
      const switching = insteadOf(runtime, given.frame, { prefetchable, view });
      current =
        (switching !== undefined && waits(switching) ? use(switching.caught) : switching) ?? given;
    }
    setState({ given, shown: current });
  }
  // The frame shown, for the stream to open with the newest subscription.
  const latest = useRef(current.frame);
  // What the root shows as each render commits — its tree may change without its frame (`adopt`)
  // — for the page to keep as the root is let go of: where a link's prefetch may carry the root,
  // and the route rendered it for the session (its `status` is `rendered`). Another root key
  // shown in its place — a search parameter's navigation, which keeps the segment — lets the one
  // before go as an unmount would: what it showed is kept, as this commit shows the other.
  const showing = useRef<KeptRoot<ReactNode> | undefined>(undefined);
  useEffect(() => {
    const before = showing.current;
    if (before !== undefined && before.frame.rootKey !== current.frame.rootKey) {
      runtime?.keep(root, before);
    }
    showing.current =
      prefetchable === true && status === 'rendered'
        ? { children: current.children, frame: current.frame, session }
        : undefined;
  }, [current, prefetchable, root, runtime, session, status]);
  useEffect(() => {
    if (controller === null) {
      return;
    }
    controller.start();
    return () => {
      controller.stop();
    };
  }, [controller]);
  useEffect(() => {
    controller?.show(current.frame);
  }, [controller, current.frame]);
  // What the page kept, shown at once, is asked for again as soon as the controller shows it: the
  // authority's answer as it is now — newer, or the root forbidden a reader whose access was taken
  // away, with no tree — takes its place a round trip later, as a catch-up's would have. Asked for
  // after it shows, not before: asked before, the page would wait for that answer as a catch-up
  // does, which what the page kept is there to spare it. Once for each render shown so.
  const reasked = useRef<Shown | undefined>(undefined);
  useEffect(() => {
    if (controller !== null && current.kept === true && reasked.current !== current) {
      reasked.current = current;
      controller.force();
    }
  }, [controller, current]);
  useEffect(() => {
    latest.current = current.frame;
    if (controller !== null) {
      runtime?.attach(root, {
        force: () => {
          controller.force();
        },
        frame: current.frame,
        refresh: () => {
          refreshExpired(() => {
            router.refresh();
          }, calls.current.expire);
        },
        session,
        want: (revision) => {
          controller.want(revision);
        },
      });
    }
  }, [controller, current.frame, root, router, runtime, session]);
  // Let go of — unmounted, or hidden with its route in a hidden `<Activity>` — the root leaves the
  // page what it showed last.
  useEffect(() => {
    return () => {
      runtime?.detach(root, showing.current);
    };
  }, [root, runtime]);
  // A render of the route the root does not show tells of its revision all the same.
  useEffect(() => {
    controller?.want(given.frame.revision);
  }, [controller, given.frame]);
  // The frame the root's stream was refused at by a code of the application's (`refuse(code)`),
  // which ended the stream: not followed while the root shows it, and followed again once the route
  // renders the root as it is now — the refusal gone, another frame shown — which lets the page's
  // hold go (`Revocation`) with nothing else of the stream changed.
  const [refusedAt, setRefusedAt] = useState<Frame | undefined>(undefined);
  const follows =
    runtime !== null && controller !== null && followed(status, current.frame, refusedAt);
  // The stream follows what the view shows: another view is followed with its own subscription.
  const viewKey = useMemo(() => canonicalJson(current.frame.view), [current.frame.view]);
  useEffect(() => {
    if (!follows) {
      return;
    }
    const follower = new Follower({
      onFrame: (revision) => {
        runtime.saw(revision);
        controller.want(revision);
      },
      // Named by this root: a refusal of its own render holds the page while it shows what it showed.
      onRevoked: (message, code) => {
        runtime.revoked(message, code, root);
        if (isApplicationCode(code)) {
          setRefusedAt(latest.current);
        }
      },
      url: () => subscriptionUrl(events, latest.current.subscription),
    });
    follower.start();
    return () => {
      follower.stop();
    };
  }, [controller, events, follows, root, runtime, viewKey]);
  const store = runtime?.store ?? null;
  const live = useMemo<Live>(
    () => ({ frame: current.frame, send: update, session, sites: controller, store }),
    [controller, current.frame, session, store, update],
  );
  const pageStatus = useSyncExternalStore(
    store === null ? unsubscribed : store.subscribe,
    store === null ? idle : store.getStatus,
    idle,
  );
  return (
    <LiveContext value={live}>
      {pageStatus.primary === root && <Notice status={pageStatus} />}
      {/* Rendered anew for another session: what one session's page held of its own — a draft,
          an open section — is never the next one's. Another frame of the session keeps it. */}
      <Fragment key={session ?? ''}>{current.children}</Fragment>
    </LiveContext>
  );
}
