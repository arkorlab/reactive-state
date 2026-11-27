// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Frame, Result } from '../src/program.ts';
import { LiveRoot } from '../src/react/index.tsx';
import { page as pageRuntime, resetPage } from '../src/runtime/page.ts';
import { FakeEventSource, forgetSources, frameAt, opened } from './support/page.ts';

/**
 * A root whose own render the application refused (`refuse(code)`, said by its stream as `revoked`)
 * is followed no more while the refusal holds: its stream ended. Once the route renders the root
 * again — the refusal is gone — and the root shows the new frame, of the same session, root key and
 * view, the page lets the hold go, and the root follows again with the new frame's subscription: no
 * other dependency of its stream changes in that recovery, and a root that never follows again
 * stops hearing the other readers and tabs without a word.
 */

const router = vi.hoisted(() => ({ refresh: vi.fn<() => void>() }));

vi.mock(import('next/navigation'), () => ({ useRouter: () => router as never }));

const EVENTS = '/api/reactive-state/events';
const ALICE = 'session:alice';
const FIELDS = { 'todos:t1:title': 'Plan' } as const;
const FIRST = frameAt(1, FIELDS);

/** An answer that never comes: the root's writes and renders are never asked for here. */
function never(): Promise<Result<never>> {
  return new Promise(() => {
    // Never settled: the call stays on its way.
  });
}

/** A root as the route renders it, with `frame`. */
function root(frame: Frame): ReactNode {
  return (
    <LiveRoot events={EVENTS} frame={frame} session={ALICE} update={never} view={never}>
      <p>team</p>
    </LiveRoot>
  );
}

/** The streams still open, by the subscription each was opened with. */
function following(): (string | null)[] {
  return opened.filter(({ closed }) => !closed).map(({ subscription }) => subscription);
}

describe('a root whose own refusal went', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    router.refresh.mockClear();
  });

  afterEach(() => {
    cleanup();
    resetPage();
    forgetSources();
    vi.unstubAllGlobals();
  });

  it('follows again once the route renders it as it is now, and lets the page go', async () => {
    const { rerender } = render(root(FIRST));
    act(() => {
      opened[0]?.emit('revoked', { code: 'NOT_IN_TEAM', error: 'You left the team.' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole('alert').textContent).toBe('You left the team.');
    expect(following()).toStrictEqual([]);

    // The refreshed route renders the root for the reader as they are now: another frame, of the
    // same root key and view.
    const renewed = frameAt(2, FIELDS);
    rerender(root(renewed));
    await act(async () => {
      await Promise.resolve();
    });

    expect(pageRuntime().store.getStatus()).toMatchObject({ error: null, revoked: false });
    expect(following()).toStrictEqual([renewed.subscription]);
    expect(router.refresh).toHaveBeenCalledExactlyOnceWith();
  });

  it('is not followed while it shows what it showed, and is opened once for each new frame', async () => {
    const { rerender } = render(root(FIRST));
    act(() => {
      opened[0]?.emit('revoked', { code: 'NOT_IN_TEAM', error: 'You left the team.' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The same frame again, as a render that changed nothing hands it: no stream opens for it.
    rerender(root(FIRST));
    await act(async () => {
      await Promise.resolve();
    });

    expect(opened).toHaveLength(1);
    expect(following()).toStrictEqual([]);

    // A frame that is refused as its stream opens: the root stops again, and a render of the same
    // frame opens nothing.
    const renewed = frameAt(2, FIELDS);
    rerender(root(renewed));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      opened[1]?.emit('revoked', { code: 'NOT_IN_TEAM', error: 'You left the team.' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    rerender(root(renewed));
    await act(async () => {
      await Promise.resolve();
    });

    expect(opened).toHaveLength(2);
    expect(following()).toStrictEqual([]);
    expect(screen.getByRole('alert').textContent).toBe('You left the team.');
  });
});
