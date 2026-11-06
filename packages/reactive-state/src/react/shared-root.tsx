'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import type { Frame, RenderStatus } from '../program.ts';
import { claimedView, type SharedView } from '../routing.ts';
import { Follower } from '../runtime/follow.ts';
import { type Live, LiveContext } from './state.ts';

/**
 * A root every visitor is shown alike, as the page shows it: the tree of the view's generation the
 * page was answered with, which follows the view's event stream rather than any session's. A newer
 * generation published is fetched as the route's page is — `router.refresh()`, which the route's gate
 * answers with the generation's own payload — never rendered again for this page alone; a view
 * denied is shown no more at once, and the route rendered again, which its gate refuses. A
 * generation or an epoch older than the one shown — a notice repeated, or one that arrived out of
 * order, or a refresh that was slower than a later one — is let go of, as is anything of an epoch a
 * denial ended. Nothing of the page's own writes is shown over it: it binds no field, and its store
 * is none.
 *
 * Each view is followed by a root of its own: one the route renders another view in — another
 * member of it, another build's — has what it shows, what was denied of it and its stream made
 * anew, as the generations and epochs of one view are no measure of another's.
 */

export interface SharedRootProps {
  /** The frame the tree was rendered at: of no session. */
  readonly frame: Frame;
  /** The view the tree is of: its generation, its access epoch, and its stream's token. */
  readonly view: SharedView;
  /** Where the view's event stream is read from (`?view=` is added). */
  readonly events: string;
  /**
   * How the authority answered the render of the view: the tree is shown where it is `rendered`
   * alone, so a root is always told — one told nothing would guess.
   */
  readonly status: RenderStatus;
  readonly children?: ReactNode;
}

interface Shown {
  readonly frame: Frame;
  readonly view: SharedView;
  readonly children: ReactNode;
  readonly denied: boolean;
}

type Moment = Pick<SharedView, 'epoch' | 'generation'>;

/** How long a refresh may take before another is asked for. */
const REFRESH_MS = 10_000;
/**
 * How many times a view whose stream the authority ended for good is followed again, of a view the
 * route renders anew: past them, a page whose every view is refused so is left hidden, never asked
 * for without end.
 */
const RECOVERIES = 2;

/** Whether `a` is of a later epoch than `b`, or a later generation of the same. */
function later(a: Moment, b: Moment): boolean {
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.generation > b.generation);
}

/** Whether `moment` is asked for: later than what is shown, and of no epoch a denial ended. */
function newer(moment: Moment, shown: Moment, ended: number): boolean {
  return moment.epoch >= ended && later(moment, shown);
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A `ready` event's generation and epoch, as the authority writes them. */
function readyOf(data: unknown): Moment | undefined {
  const { epoch, generation } = (data ?? {}) as Partial<Record<string, unknown>>;
  const moment = { epoch: count(epoch), generation: count(generation) };
  return moment.epoch === undefined || moment.generation === undefined
    ? undefined
    : { epoch: moment.epoch, generation: moment.generation };
}

/** A `denied` event's epoch, as the authority writes it: the one the denial began. */
function deniedOf(data: unknown): number | undefined {
  return count(((data ?? {}) as Partial<Record<string, unknown>>)['epoch']);
}

function eventsUrl(events: string, token: string): string {
  const url = new URL(events, globalThis.location.href);
  url.searchParams.set('view', token);
  return url.href;
}

function writesNothing(): never {
  throw new TypeError('A root every visitor is shown alike writes nothing.');
}

function ignore(): void {
  // A shared view's stream says no `frame`.
}

/**
 * The view `token` is of, as one key: its route, its params and its build, which every generation
 * of it shares, where the token changes with each. One key for every token that says none of it,
 * whose views are followed as one.
 */
function viewKeyOf(token: string): string {
  const claimed = claimedView(token);
  return claimed === undefined
    ? ''
    : JSON.stringify([claimed.route, claimed.params, claimed.build]);
}

/** One view's root, as `SharedRoot` renders it: what it shows of the view, and its stream. */
function FollowedView(props: SharedRootProps): ReactNode {
  const router = useRouter();
  const given: Shown = {
    children: props.children,
    denied: props.status !== 'rendered',
    frame: props.frame,
    view: props.view,
  };
  const [shown, setShown] = useState(given);
  // The newest epoch a denial began: what the page held of an earlier one is shown no more.
  const [ended, setEnded] = useState(0);
  // The token whose stream the authority ended for good — one it reads no more, as after its secret
  // changed — whose view is hidden until the route renders another, followed anew (`round`).
  const [revoked, setRevoked] = useState<string | undefined>(undefined);
  const [round, setRound] = useState(0);
  const recoveries = useRef(0);
  let current = shown;
  // The route rendered it again: shown unless it is older than what is shown.
  if (given.view.token !== shown.view.token && !later(shown.view, given.view)) {
    current = given;
    setShown(given);
  }
  if (revoked !== undefined && current.view.token !== revoked) {
    setRevoked(undefined);
    setRound(round + 1);
  }
  const latest = useRef(current);
  // The newest moment the route is to be rendered again for: a generation published, or a denial's
  // epoch, which a render of the route refused brings.
  const wanted = useRef<Moment | undefined>(undefined);
  // The same, as the stream tells of it: the events right after a denial come before its render.
  const denial = useRef(0);
  const refreshing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const calls = useRef({ router });
  // The props of the route's last render: a render of this root's own — the board hidden at once
  // for a denial — brings none of the route's, and leaves a refresh on its way.
  const rendered = useRef<SharedRootProps | undefined>(undefined);
  useEffect(() => {
    latest.current = current;
    calls.current = { router };
    if (rendered.current === props) {
      return;
    }
    rendered.current = props;
    // A refresh that brought what was asked for, or no further, is done with.
    clearTimeout(refreshing.current);
    refreshing.current = undefined;
    if (wanted.current !== undefined && newer(wanted.current, current.view, denial.current)) {
      refresh();
    }
  });
  /**
   * Has the route rendered again for `moment`, unless one asked for is newer: asked of the router at
   * once, or once a refresh on its way is done with — and again each time one takes `REFRESH_MS`,
   * until the route is rendered for it (the effect above).
   */
  function want(moment: Moment): void {
    wanted.current =
      wanted.current === undefined || later(moment, wanted.current) ? moment : wanted.current;
    refresh();
  }
  function refresh(): void {
    if (refreshing.current !== undefined) {
      return;
    }
    refreshing.current = setTimeout(() => {
      refreshing.current = undefined;
      refresh();
    }, REFRESH_MS);
    calls.current.router.refresh();
  }
  useEffect(() => {
    const follower = new Follower({
      on: {
        denied: (data) => {
          const epoch = deniedOf(data) ?? latest.current.view.epoch + 1;
          if (epoch <= denial.current) {
            return;
          }
          denial.current = epoch;
          // Hidden at once, outside a transition: the router's refresh is one, of this same event,
          // which waits for the route's payload and would hold the board shown until it is in. The
          // route is rendered again for the denial as for a generation: asked for until it is.
          setEnded(epoch);
          want({ epoch, generation: 0 });
        },
        ready: (data) => {
          const moment = readyOf(data);
          if (
            moment === undefined ||
            moment.epoch < denial.current ||
            later(latest.current.view, moment)
          ) {
            return;
          }
          // The authority admitted this stream: an equal moment also proves its replacement works.
          recoveries.current = 0;
          if (newer(moment, latest.current.view, denial.current)) {
            want(moment);
          }
        },
      },
      onFrame: ignore,
      onRevoked: (_message, code) => {
        clearTimeout(refreshing.current);
        refreshing.current = undefined;
        wanted.current = undefined;
        if (code === 'BUILD_MISMATCH') {
          globalThis.location.reload();
          return;
        }
        // Ended for good otherwise: what it shows is hidden at once, of a view nothing follows,
        // and the route rendered again for one to follow, as many times as `RECOVERIES` lets.
        setRevoked(latest.current.view.token);
        if (recoveries.current < RECOVERIES) {
          recoveries.current += 1;
          calls.current.router.refresh();
        }
      },
      url: () => eventsUrl(props.events, latest.current.view.token),
    });
    follower.start();
    return () => {
      follower.stop();
      clearTimeout(refreshing.current);
    };
    // The stream follows the view, whatever generation of it is shown — anew once the route
    // rendered another after its stream was ended for good.
  }, [props.events, round]);
  const live = useMemo<Live>(() => {
    return {
      frame: current.frame,
      send: writesNothing,
      session: undefined,
      sites: null,
      store: null,
    };
  }, [current.frame]);
  const hidden = current.denied || current.view.epoch < ended || current.view.token === revoked;
  return <LiveContext value={live}>{hidden ? null : current.children}</LiveContext>;
}

export function SharedRoot(props: SharedRootProps): ReactNode {
  const { children, events, frame, status, view } = props;
  return (
    <FollowedView
      key={viewKeyOf(view.token)}
      events={events}
      frame={frame}
      status={status}
      view={view}
    >
      {children}
    </FollowedView>
  );
}
