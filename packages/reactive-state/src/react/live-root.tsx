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
import { Follower } from '../runtime/follow.ts';
import { canonicalJson } from '../runtime/json.ts';
import { type Page, page } from '../runtime/page.ts';
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
 * back to, whose tree is as it was first rendered — is rendered again before it shows, the
 * navigation that brings it holding the page as it was meanwhile.
 *
 * In the browser it follows the root's event stream, and renders the root again — itself, through
 * its `view` Server Function, for the sites the page shows (`useSites`) — once the frame shown was
 * not rendered for a site the page shows, or the stream, or the answer to one of the page's writes,
 * tells of a revision newer than the frame's. A render of the route, which renders the root for the
 * sites its states' first values show, is shown while it shows every site the page shows; otherwise
 * it only tells of its revision. The route renders again (`router.refresh`) once the session ended
 * or changed. A root rendered with another key — the props it was rendered with, or the session,
 * changed — is followed anew.
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
   * never goes back from.
   */
  readonly prefetchable?: boolean | undefined;
}

interface Shown {
  readonly frame: Frame;
  readonly children: ReactNode;
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
 * What a root about to show `frame` — mounted with it, or shown in another root's place — waits for
 * before it shows: the root rendered again, where the frame is older than one the page has shown
 * since — the route the router kept, gone back to, whose tree is as it was first rendered. Nothing
 * for a frame the page has shown nothing newer than, nor on the server, nor for a root nobody's
 * session follows.
 */
function catchUpOf(
  runtime: Page | null,
  frame: Frame,
  view: ViewFunction,
  prefetchable = false,
): CatchUp | null {
  if (runtime === null || frame.subscription === '' || frame.revision >= runtime.newest) {
    return null;
  }
  // A frame a link's prefetch carried shows at once, older than the page's newest though it is,
  // where the page showed nothing newer of this very root, and wrote nothing since: its stream, as
  // it opens, sets it right.
  if (prefetchable && frame.revision >= runtime.carriedFloor(frame.rootKey)) {
    return null;
  }
  const key = catchUpKey(frame);
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

export function LiveRoot(props: LiveRootProps): ReactNode {
  const { events, frame, session, status = 'rendered', update, view } = props;
  const router = useRouter();
  const runtime = usePage();
  const root = useId();
  // A root about to show a frame older than one the page showed since — mounted with it, or another
  // root shown in its place, as a route the router kept and is gone back to is — is rendered again
  // before it shows: the page never goes back to a revision it has moved past. React keeps the page
  // as it was meanwhile, the navigation that brought the root a transition.
  const [mounting] = useState(() => catchUpOf(runtime, frame, view, props.prefetchable));
  const caught = mounting === null ? undefined : use(mounting.caught);
  const [state, setState] = useState<RootState>(() => {
    const given = { children: props.children, frame };
    return { given, shown: caught ?? given };
  });
  useEffect(() => {
    runtime?.settled(catchUpKey(state.given.frame));
  }, [runtime, state.given.frame]);
  // What the root's controller calls, the newest of each as a render commits.
  const calls = useRef({ router, runtime, view });
  useInsertionEffect(() => {
    calls.current = { router, runtime, view };
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
        calls.current.router.refresh();
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
      const switching = catchUpOf(runtime, given.frame, view, props.prefetchable);
      current = (switching === null ? undefined : use(switching.caught)) ?? given;
    }
    setState({ given, shown: current });
  }
  // The frame shown, for the stream to open with the newest subscription.
  const latest = useRef(current.frame);
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
  useEffect(() => {
    latest.current = current.frame;
    if (controller !== null) {
      runtime?.attach(root, {
        force: () => {
          controller.force();
        },
        frame: current.frame,
        refresh: () => {
          router.refresh();
        },
        session,
        want: (revision) => {
          controller.want(revision);
        },
      });
    }
  }, [controller, current.frame, root, router, runtime, session]);
  useEffect(() => {
    return () => {
      runtime?.detach(root);
    };
  }, [root, runtime]);
  // A render of the route the root does not show tells of its revision all the same.
  useEffect(() => {
    controller?.want(given.frame.revision);
  }, [controller, given.frame]);
  const follows = runtime !== null && controller !== null && status !== 'unauthenticated';
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
      onRevoked: (message, code) => {
        runtime.revoked(message, code);
      },
      url: () => subscriptionUrl(events, latest.current.subscription),
    });
    follower.start();
    return () => {
      follower.stop();
    };
  }, [controller, events, follows, runtime, viewKey]);
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
