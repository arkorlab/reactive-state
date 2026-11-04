// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { type ReactNode, startTransition, use, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { type Elements, renderTree } from '../src/next/render.ts';
import type { Rendered } from '../src/program.ts';
import { SharedRoot } from '../src/react/shared-root.tsx';
import { type ClientPartProps, stateOf, useReactiveState } from '../src/react/state.ts';
import type { SharedView } from '../src/routing.ts';
import { BUILD, FakeEventSource, forgetSources, frameAt, opened } from './support/page.ts';

/**
 * A shared view in the browser, as a public route's page renders it: the board every visitor is
 * shown alike, inside `SharedRoot`, which follows the view's event stream (`?view=`) — `ready`, of a
 * generation published, and `denied`, of the epoch a denial began — and has the route rendered
 * again (`router.refresh`) for a newer generation, whose props the route's next render brings.
 */

const router = vi.hoisted(() => ({ refresh: vi.fn<() => void>() }));

vi.mock(import('next/navigation'), () => ({ useRouter: () => router as never }));

const EVENTS = '/api/reactive-state/events';
const TITLE = 'projects:p1:title';

/** The board as its compiled Client Component shows it: its title, read from the frame shown. */
function Board({ part }: ClientPartProps): ReactNode {
  const [title] = useReactiveState(stateOf<string>(part, 'title'));
  const { generation } = part.props as { readonly generation: number };
  return <h2 data-testid="board">{`${title} (generation ${String(generation)})`}</h2>;
}

const ELEMENTS: Elements = {
  actions: {},
  build: BUILD,
  clients: { 'components/public-board': Board },
  modules: {},
};

/** The view of the board at `generation` of `epoch`, as the authority signs it for the page. */
function viewAt(generation: number, epoch = 1): SharedView {
  return { epoch, generation, token: `view:boards/p1@${String(epoch)}.${String(generation)}` };
}

/**
 * The view of the board of `projectId` at `generation` of the first epoch, its token as the
 * authority writes one: its claims — the route, the params, the build — in base64url, and a
 * signature.
 */
function claimedViewAt(projectId: string, generation: number): SharedView {
  const epoch = 1;
  const claims = {
    build: BUILD,
    epoch,
    generation,
    params: { projectId },
    route: '/boards/[projectId]',
    t: 'view',
  };
  const encoded = btoa(JSON.stringify(claims))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return { epoch, generation, token: `${encoded}.signature` };
}

/**
 * The route's page as the gate answers it with `generation` of `epoch`: the board's tree inside
 * `SharedRoot`, with the frame and the view it was rendered at — the title the generation shows.
 */
function page(generation: number, epoch = 1, view = viewAt(generation, epoch)): ReactNode {
  const tree: Rendered = {
    component: 'components/public-board',
    key: null,
    kind: 'client',
    part: { props: { generation }, slots: {}, states: { title: { field: TITLE } } },
  };
  // Of no session, as a shared view's frame is.
  const frame = frameAt(
    generation,
    { [TITLE]: `Board ${String(generation)}` },
    { rootKey: 'root:boards/p1', subscription: '' },
  );
  return (
    <SharedRoot events={EVENTS} frame={frame} status="rendered" view={view}>
      {renderTree(tree, ELEMENTS)}
    </SharedRoot>
  );
}

/**
 * The route's page as it renders a view refused — of `epoch`, the epoch its denial began, which
 * generation `generation` was published before — showing nothing of it.
 */
function refused(generation: number, epoch: number): ReactNode {
  const frame = frameAt(generation, {}, { rootKey: 'root:boards/p1', subscription: '' });
  return (
    <SharedRoot events={EVENTS} frame={frame} status="forbidden" view={viewAt(generation, epoch)} />
  );
}

/** What the page shows of `generation`: the title the generation shows, beside it. */
function showing(generation: number): string {
  return `Board ${String(generation)} (generation ${String(generation)})`;
}

/** What the page shows of the board; nothing once it is hidden. */
function shown(): string | null {
  return screen.queryByTestId('board')?.textContent ?? null;
}

/** The `index`th stream the page opened, oldest first. */
function streamAt(index: number): FakeEventSource {
  const stream = opened[index];
  if (stream === undefined) {
    throw new Error(`The page opened no stream ${String(index)}.`);
  }
  return stream;
}

/** The view token a stream was opened with. */
function tokenOf(stream: FakeEventSource): string | null {
  return new URL(stream.url).searchParams.get('view');
}

/** `ready`, as the authority writes it once `generation` of `epoch` is published. */
function ready(stream: FakeEventSource, generation: number, epoch = 1): void {
  act(() => {
    stream.emit('ready', { epoch, generation });
  });
}

/** `denied`, as the authority writes it once a denial began `epoch`. */
function denied(stream: FakeEventSource, epoch: number): void {
  act(() => {
    stream.emit('denied', { epoch });
  });
}

const PENDING_NOTICES = [
  {
    name: 'ready',
    publish: (stream: FakeEventSource) => {
      ready(stream, 2);
    },
  },
  {
    name: 'denied',
    publish: (stream: FakeEventSource) => {
      denied(stream, 2);
    },
  },
] as const;

/** Timers the page sets — the stream's reconnection, a refresh's wait — under the test's clock. */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** The test's clock moved on by `ms`, and what the page does meanwhile taken in. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A stream that fails, and the wait before the follower opens another: its first, a second. */
async function drop(stream: FakeEventSource): Promise<void> {
  act(() => {
    stream.fail();
  });
  await wait(1000);
}

/** A promise never settled: a refresh whose payload never comes. */
async function never(): Promise<never> {
  return new Promise(() => {
    // Never settled: the refresh stays on its way.
  });
}

/**
 * The route as Next.js's router renders it: `router.refresh()` sets the router's state, in a
 * transition, to the payload on its way, which the route waits for (`use`) — React keeps what the
 * page shows meanwhile. `held` is handed that refresh once the route is in.
 */
function Route(props: {
  readonly children: ReactNode;
  readonly held: (refresh: () => void) => void;
}): ReactNode {
  const { children, held } = props;
  const [payload, setPayload] = useState<Promise<never> | null>(null);
  useEffect(() => {
    held(() => {
      startTransition(() => {
        setPayload(never());
      });
    });
  }, [held]);
  if (payload !== null) {
    use(payload);
  }
  return children;
}

describe('a shared view in the browser', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    router.refresh.mockReset();
  });

  afterEach(() => {
    cleanup();
    forgetSources();
    vi.unstubAllGlobals();
  });

  it('catches up with a generation published before its stream opened, and drops none published meanwhile', () => {
    const { rerender } = render(page(1));
    const stream = streamAt(0);

    expect(tokenOf(stream)).toBe(viewAt(1).token);

    // What the page missed, which the authority writes first as the stream opens.
    stream.open();
    ready(stream, 2);

    expect(router.refresh).toHaveBeenCalledTimes(1);

    // Published while the refresh is on its way, which brings the generation before it.
    ready(stream, 3);
    rerender(page(2));

    expect(shown()).toBe(showing(2));
    expect(router.refresh).toHaveBeenCalledTimes(2);

    rerender(page(3));

    expect(shown()).toBe(showing(3));
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it('never moves the board back for a notice of a generation it has passed, nor for a slower refresh’s render', () => {
    const { rerender } = render(page(1));
    const stream = streamAt(0);
    ready(stream, 3);
    rerender(page(3));

    // Out of order, and repeated: a generation older than the one shown, and the one shown.
    ready(stream, 2);
    ready(stream, 3);
    // A refresh slower than the later one: the route rendered with the generation before.
    rerender(page(2));

    expect(shown()).toBe(showing(3));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes once for a notice repeated while its refresh is on its way, and again only once that refresh is late', async () => {
    fakeTimers();
    const { rerender } = render(page(1));
    const stream = streamAt(0);
    ready(stream, 2);
    ready(stream, 2);
    ready(stream, 2);
    await wait(9999);

    expect(router.refresh).toHaveBeenCalledTimes(1);

    // Ten seconds without the route rendered again: the refresh is asked for once more.
    await wait(1);

    expect(router.refresh).toHaveBeenCalledTimes(2);

    rerender(page(2));
    ready(stream, 2);
    await wait(10_000);

    expect(shown()).toBe(showing(2));
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps a denied board hidden from a notice or a render of the epoch the denial ended, and shows it published anew until denied again', () => {
    const { rerender } = render(page(1));
    const stream = streamAt(0);
    ready(stream, 2);
    denied(stream, 2);

    expect(shown()).toBeNull();

    // Late: the notice of the epoch ended, the denial repeated, and the slower refresh's render.
    ready(stream, 2);
    denied(stream, 2);
    rerender(page(2));

    expect(shown()).toBeNull();
    // The refresh asked for generation 2 brought it, of the epoch the denial ended: the route asked
    // for again, for its gate to refuse it.
    expect(router.refresh).toHaveBeenCalledTimes(2);

    // Published anew while that refresh is on its way, which brings it: nothing more asked for.
    ready(stream, 3, 2);

    expect(router.refresh).toHaveBeenCalledTimes(2);

    rerender(page(3, 2));

    expect(shown()).toBe(showing(3));

    // Denied again: the epoch this denial began ends the one published anew.
    denied(stream, 3);

    expect(shown()).toBeNull();
  });

  it('asks for the route again after a denial until it is rendered for the denial, as late as its refresh is, the board hidden at once and meanwhile', async () => {
    fakeTimers();
    const { rerender } = render(page(1));
    const stream = streamAt(0);
    denied(stream, 2);

    expect(shown()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // Ten seconds without the route rendered again: the refresh was lost, and is asked for again.
    await wait(10_000);

    expect(router.refresh).toHaveBeenCalledTimes(2);
    expect(shown()).toBeNull();

    // The route rendered for the denial, refused, of the epoch it began: nothing more asked for.
    rerender(refused(1, 2));
    await wait(10_000);

    expect(router.refresh).toHaveBeenCalledTimes(2);
    expect(shown()).toBeNull();
  });

  it('hides the board at once when the view is denied, while the refresh it asks for is still on its way', () => {
    render(
      <Route
        held={(refresh) => {
          router.refresh.mockImplementation(refresh);
        }}
      >
        {page(1)}
      </Route>,
    );

    expect(shown()).toBe(showing(1));

    denied(streamAt(0), 2);

    expect(shown()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('recovers the newest generation once its stream is opened again, with one refresh for what it missed', async () => {
    fakeTimers();
    const { rerender } = render(page(1));
    const dropped = streamAt(0);
    await drop(dropped);
    // What the dropped stream still dispatches is not the page's.
    ready(dropped, 2);

    expect(router.refresh).not.toHaveBeenCalled();

    const reopened = streamAt(1);

    expect(tokenOf(reopened)).toBe(viewAt(1).token);

    // Generations 2 to 4 were published while it was down: the authority says the newest alone.
    ready(reopened, 4);

    expect(router.refresh).toHaveBeenCalledTimes(1);

    rerender(page(4));

    expect(shown()).toBe(showing(4));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect([dropped.closed, reopened.closed]).toStrictEqual([true, false]);
  });

  it('follows the view with the token of the generation the route rendered last, its stream kept meanwhile', async () => {
    fakeTimers();
    const { rerender } = render(page(1));
    ready(streamAt(0), 2);
    rerender(page(2));

    // The stream follows the view, whatever generation of it is shown.
    expect(opened).toHaveLength(1);

    await drop(streamAt(0));

    expect(tokenOf(streamAt(1))).toBe(viewAt(2).token);

    // The generation shown is not asked for again; a newer one is.
    ready(streamAt(1), 2);
    ready(streamAt(1), 3);

    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it('hides a view whose stream the authority ended for good — a token it reads no more — asks for the route again, and follows the view it renders anew', () => {
    const { rerender } = render(page(1));

    expect(shown()).toBe(showing(1));

    act(() => {
      streamAt(0).emit('revoked', {
        code: 'FORBIDDEN',
        error: 'The view is none of the authority’s.',
      });
    });

    // Nothing of it shown, nothing following it: the route asked for again.
    expect(shown()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // Rendered again of a token the authority signed anew: shown, and followed by a stream of its own.
    const resigned = { ...viewAt(1), token: 'view:boards/p1@1.1:resigned' };
    rerender(page(1, 1, resigned));

    expect(shown()).toBe(showing(1));
    expect(opened).toHaveLength(2);
    expect(tokenOf(streamAt(1))).toBe(resigned.token);

    // Ended so again, and again: asked for twice in all, then left hidden, never without end.
    act(() => {
      streamAt(1).emit('revoked', {
        code: 'FORBIDDEN',
        error: 'The view is none of the authority’s.',
      });
    });
    rerender(page(1, 1, { ...resigned, token: `${resigned.token}:again` }));
    act(() => {
      streamAt(2).emit('revoked', {
        code: 'FORBIDDEN',
        error: 'The view is none of the authority’s.',
      });
    });

    expect(shown()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1])(
    'recovers again after replacement streams announce a healthy generation, offset %s',
    (offset) => {
      const { rerender } = render(page(1, 1, claimedViewAt('p1', 1)));
      for (const index of [0, 1]) {
        act(() => {
          streamAt(index).emit('revoked', { code: 'FORBIDDEN' });
        });

        expect(shown()).toBeNull();
        expect(router.refresh).toHaveBeenCalledTimes(1);

        const generation = index * 2 + 2;
        rerender(page(generation, 1, claimedViewAt('p1', generation)));
        streamAt(index + 1).open();
        ready(streamAt(index + 1), generation + offset);
        rerender(page(generation + offset, 1, claimedViewAt('p1', generation + offset)));

        expect(shown()).toBe(showing(generation + offset));

        router.refresh.mockClear();
      }
      act(() => {
        streamAt(2).emit('revoked', { code: 'FORBIDDEN' });
      });

      expect(shown()).toBeNull();
      expect(router.refresh).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['no ready', undefined],
    ['malformed ready', { epoch: 1, generation: 'new' }],
    ['older generation', { epoch: 1, generation: 0 }],
    ['older epoch', { epoch: 0, generation: 1 }],
  ])('keeps the refusal cap when replacement streams open with %s', (_what, event) => {
    const { rerender } = render(page(1, 1, claimedViewAt('p1', 1)));
    for (const index of [0, 1]) {
      act(() => {
        streamAt(index).emit('revoked', { code: 'FORBIDDEN' });
      });
      const generation = index * 2 + 2;
      rerender(page(generation, 1, claimedViewAt('p1', generation)));
      act(() => {
        streamAt(index + 1).open();
        streamAt(index + 1).emit('ready', event);
        streamAt(index).emit('ready', { epoch: 1, generation });
      });
    }
    act(() => {
      streamAt(2).emit('revoked', { code: 'FORBIDDEN' });
    });

    expect(shown()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it('follows another view the route renders in the same place anew: shown though of an earlier generation, its own stream opened, the earlier view’s let go', () => {
    const { rerender } = render(page(3, 1, claimedViewAt('p1', 3)));
    const first = streamAt(0);
    denied(first, 2);

    expect(shown()).toBeNull();

    // Another member of the route, rendered where React kept what showed the first.
    const other = claimedViewAt('p2', 1);
    rerender(page(1, 1, other));

    expect(shown()).toBe(showing(1));
    expect(first.closed).toBe(true);
    expect(tokenOf(streamAt(1))).toBe(other.token);

    // What the first view's stream still says is not the page's any more.
    ready(first, 9, 3);
    denied(first, 3);

    expect(shown()).toBe(showing(1));
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // The view followed now is denied: hidden, the route rendered again.
    denied(streamAt(1), 2);

    expect(shown()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it.each(PENDING_NOTICES)(
    'cancels a pending $name refresh retry after a final revocation',
    async ({ publish }) => {
      fakeTimers();
      render(page(1));
      const stream = streamAt(0);
      publish(stream);

      expect(router.refresh).toHaveBeenCalledTimes(1);

      act(() => {
        stream.emit('revoked', { code: 'FORBIDDEN' });
      });

      expect(shown()).toBeNull();
      expect(router.refresh).toHaveBeenCalledTimes(2);

      await wait(40_000);

      expect(router.refresh).toHaveBeenCalledTimes(2);
      expect(stream.closed).toBe(true);
    },
  );

  it('drops the wanted generation so a late unchanged payload cannot restart a revoked retry', async () => {
    fakeTimers();
    const { rerender } = render(page(1));
    ready(streamAt(0), 2);
    act(() => {
      streamAt(0).emit('revoked', { code: 'FORBIDDEN' });
    });
    rerender(page(1));

    expect(shown()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(2);

    await wait(40_000);

    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it('cancels an outstanding denial retry after the final recovery budget is exhausted', async () => {
    fakeTimers();
    const { rerender } = render(page(1));
    for (const index of [0, 1]) {
      act(() => {
        streamAt(index).emit('revoked', { code: 'FORBIDDEN' });
      });
      const token = `replacement:${String(index)}`;
      rerender(page(1, 1, { ...viewAt(1), token }));
    }

    expect(router.refresh).toHaveBeenCalledTimes(2);

    denied(streamAt(2), 2);
    act(() => {
      streamAt(2).emit('revoked', { code: 'FORBIDDEN' });
    });

    expect(shown()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(3);

    await wait(40_000);

    expect(router.refresh).toHaveBeenCalledTimes(3);
  });

  it.each(PENDING_NOTICES)(
    'cancels a pending $name retry while a build mismatch reload is unanswered',
    async ({ publish }) => {
      fakeTimers();
      const reload = vi.fn<() => void>();
      vi.stubGlobal('location', { href: globalThis.location.href, reload });
      render(page(1));
      const stream = streamAt(0);
      publish(stream);
      act(() => {
        stream.emit('revoked', { code: 'BUILD_MISMATCH' });
      });

      expect(reload).toHaveBeenCalledTimes(1);
      expect(router.refresh).toHaveBeenCalledTimes(1);

      await wait(40_000);

      expect(router.refresh).toHaveBeenCalledTimes(1);
    },
  );
});
