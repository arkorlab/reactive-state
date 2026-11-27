// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { type ReactNode, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { FieldReceipt, Frame, Result } from '../src/program.ts';
import { LiveRoot } from '../src/react/index.tsx';
import { page as pageRuntime, resetPage } from '../src/runtime/page.ts';
import type { ViewAnswer } from '../src/runtime/view.ts';
import {
  type Deferred,
  deferred,
  FakeEventSource,
  forgetSources,
  frameAt,
  opened,
  refusal,
} from './support/page.ts';

/**
 * A root of a build that keeps its roots in the deployment's cache, in the browser: where it would
 * have the route rendered again — for a session the authority refused, or a stream that says the
 * session ended — it has the session's kept renders expired instead (`expire`), whose answer renders
 * the route again of the authority, not of the cache: the Server Function's own `refresh()`. Only
 * where that call fails does the root have the router render the route again itself; one under way,
 * however long, it leaves be, as Next.js's router runs a refresh behind it all the same. And what
 * the page keeps of a root it let go of (`Page.kept`), on a page of such a build: shown at once and
 * asked for again, a refusal of which expires as any refused view does; forgotten as the session
 * ends, before the expiry.
 */

const router = vi.hoisted(() => ({ refresh: vi.fn<() => void>() }));

vi.mock(import('next/navigation'), () => ({ useRouter: () => router as never }));

type ViewFunction = (input: unknown) => Promise<Result<ViewAnswer<ReactNode>>>;

const EVENTS = '/api/reactive-state/events';
const ALICE = 'session:alice';
const FIRST = frameAt(1, {});
/** A root of no dynamic site and no field: one the page keeps as it lets it go. */
const PLAIN = 'root:plain';

function never<T>(): Promise<T> {
  return new Promise(() => {
    // Never settled: the call stays on its way.
  });
}

const update = vi.fn<(input: unknown) => Promise<Result<FieldReceipt>>>(never);

/** The root as `renderRoot` renders it for a build that keeps its roots, with `expire`. */
function kept(view: ViewFunction, expire?: () => Promise<unknown>): ReactNode {
  return (
    <LiveRoot
      events={EVENTS}
      {...(expire !== undefined && { expire })}
      frame={FIRST}
      prefetchable
      session={ALICE}
      update={update}
      view={view}
    >
      <p>roster</p>
    </LiveRoot>
  );
}

/** A frame of the root `rootKey` at `revision`, of no site and no field. */
function plainAt(revision: number, rootKey = PLAIN): Frame {
  return frameAt(revision, {}, { rootKey });
}

/**
 * A root at `frame` as `renderRoot` renders it for a build that keeps its roots, inside the
 * boundary a navigation waits in: a paragraph its root key names, of its revision.
 */
function keptAt(frame: Frame, view: ViewFunction, expire: () => Promise<unknown>): ReactNode {
  return (
    <Suspense fallback={<p role="status">戻っています</p>}>
      <LiveRoot
        events={EVENTS}
        expire={expire}
        frame={frame}
        prefetchable
        session={ALICE}
        update={update}
        view={view}
      >
        <p data-testid={frame.rootKey}>{`roster@${String(frame.revision)}`}</p>
      </LiveRoot>
    </Suspense>
  );
}

/** Lets the page's microtasks run: answers taken in, refreshes asked for. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A `view` function whose answers never come. */
function unanswered(): Mock<ViewFunction> {
  return vi.fn<ViewFunction>(never);
}

/** A `view` function whose one answer is the authority's refusal of the session (401). */
function refusing(): Mock<ViewFunction> {
  return vi.fn<ViewFunction>(() => Promise.resolve(refusal(401, 'UNAUTHENTICATED', 'Sign in.')));
}

/** The root asks to be rendered again — its stream told of a newer revision — and is refused. */
async function refusedView(): Promise<void> {
  act(() => {
    opened.at(-1)?.emit('frame', { frame: { revision: 2 } });
  });
  await settle();
}

/** The stream opened last, the root's on the page, says the session ended. */
async function revokedStream(): Promise<void> {
  act(() => {
    opened.at(-1)?.emit('revoked', { code: 'UNAUTHENTICATED', error: 'The session ended.' });
  });
  await settle();
}

/** Shows the root at `frame`, then lets it go, as a navigation away from its route does. */
async function shownAndLeft(
  frame: Frame,
  view: ViewFunction,
  expire: () => Promise<unknown>,
): Promise<void> {
  const shown = render(keptAt(frame, view, expire));
  await settle();
  shown.unmount();
}

describe('a root kept in the deployment’s cache, in the browser', () => {
  let expiry: Deferred<undefined>;
  let expire: Mock<() => Promise<undefined>>;

  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    router.refresh.mockClear();
    expiry = deferred<undefined>();
    expire = vi.fn(async () => expiry.promise);
  });

  afterEach(() => {
    cleanup();
    resetPage();
    forgetSources();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ['a view the authority refused the session', refusedView],
    ['a stream that says the session ended', revokedStream],
  ])('has the expiry render the route again, in its own answer, for %s', async (_what, happen) => {
    const view = refusing();
    render(kept(view, expire));

    await happen();

    expect(expire).toHaveBeenCalledExactlyOnceWith();

    expiry.resolve(undefined);
    await settle();

    // The Server Function's answer carried the route's render: a refresh would be a second.
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('renders the route again itself where the expiry fails', async () => {
    render(kept(refusing(), expire));

    await revokedStream();
    expiry.reject(new Error('The Server Function could not be reached.'));
    await settle();

    expect(expire).toHaveBeenCalledTimes(1);
    expect(router.refresh).toHaveBeenCalledExactlyOnceWith();
  });

  it('waits for an expiry under way, however long, as the router would', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(kept(refusing(), expire));

    await revokedStream();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // Next.js's router runs a refresh behind a Server Function's call under way, so no wait of
    // the root's own would bring it sooner.
    expect(expire).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('renders the route again at once where the build keeps no root', async () => {
    render(kept(refusing()));

    await revokedStream();

    expect(router.refresh).toHaveBeenCalledExactlyOnceWith();
  });

  describe('what the page kept of a root it let go of', () => {
    it('shows it at once, and has the expiry render the route where asking for it again is refused', async () => {
      const view = refusing();
      await shownAndLeft(plainAt(5), view, expire);
      // Another root's stream told the page of a newer revision since.
      pageRuntime().saw(8);

      // The route the router kept, gone back to: its root's frame as it was first rendered.
      await act(async () => {
        render(keptAt(plainAt(2), view, expire));
        await Promise.resolve();
      });
      await settle();

      expect(screen.queryByTestId(PLAIN)?.textContent).toBe('roster@5');
      expect(screen.queryByRole('status')).toBeNull();
      // Asked for again as it shows, and refused: expired as any refused view is.
      expect(view).toHaveBeenCalledExactlyOnceWith({
        subscription: plainAt(5).subscription,
        view: {},
      });
      expect(expire).toHaveBeenCalledExactlyOnceWith();

      expiry.resolve(undefined);
      await settle();

      expect(router.refresh).not.toHaveBeenCalled();
      // Kept still, as the root's that let it go while another shows it; a frame of another
      // session, as the route's render after the expiry brings, has the page forget it.
      expect(pageRuntime().kept(PLAIN)?.frame).toStrictEqual(plainAt(5));
    });

    it('is forgotten as the session ends, and the expiry renders the route', async () => {
      await shownAndLeft(plainAt(5), unanswered(), expire);

      expect(pageRuntime().kept(PLAIN)?.frame).toStrictEqual(plainAt(5));

      render(keptAt(plainAt(6, 'root:other'), unanswered(), expire));
      await settle();
      await revokedStream();

      expect(pageRuntime().kept(PLAIN)).toBeUndefined();
      expect(expire).toHaveBeenCalledExactlyOnceWith();

      expiry.resolve(undefined);
      await settle();

      expect(router.refresh).not.toHaveBeenCalled();
    });

    it('is forgotten as the session ends, the route rendered again itself where the expiry fails', async () => {
      await shownAndLeft(plainAt(5), unanswered(), expire);
      render(keptAt(plainAt(6, 'root:other'), unanswered(), expire));
      await settle();

      await revokedStream();
      expiry.reject(new Error('The Server Function could not be reached.'));
      await settle();

      expect(pageRuntime().kept(PLAIN)).toBeUndefined();
      expect(expire).toHaveBeenCalledTimes(1);
      expect(router.refresh).toHaveBeenCalledExactlyOnceWith();
    });
  });
});
