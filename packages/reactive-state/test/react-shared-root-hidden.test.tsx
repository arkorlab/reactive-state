// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { Activity, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedRoot } from '../src/react/shared-root.tsx';
import type { SharedView } from '../src/routing.ts';
import { FakeEventSource, forgetSources, frameAt, opened } from './support/page.ts';

const router = vi.hoisted(() => ({ refresh: vi.fn<() => void>() }));

vi.mock(import('next/navigation'), () => ({ useRouter: () => router as never }));

const EVENTS = '/api/reactive-state/events';
const VIEW: SharedView = { epoch: 1, generation: 1, token: 'view:boards/p1@1.1' };
// Of no session, as a shared view's frame is.
const FRAME = frameAt(1, {}, { rootKey: 'root:boards/p1', subscription: '' });

/**
 * The root as the route's payload holds it: one element, which the router renders again as it is
 * while it keeps the page — so React renders nothing of it anew.
 */
const BOARD = (
  <SharedRoot events={EVENTS} frame={FRAME} status="rendered" view={VIEW}>
    <h2>Board</h2>
  </SharedRoot>
);

/** The route's page inside the `<Activity>` the router keeps a page in, hidden once it is left. */
function page(mode: 'hidden' | 'visible'): ReactNode {
  return <Activity mode={mode}>{BOARD}</Activity>;
}

/** The newest stream the page opened. */
function newest(): FakeEventSource {
  const stream = opened.at(-1);
  if (stream === undefined) {
    throw new Error('The page opened no stream.');
  }
  return stream;
}

/** `ready`, as the authority writes it once `generation` is published, or as a stream opens. */
function ready(stream: FakeEventSource, generation: number): void {
  act(() => {
    stream.emit('ready', { epoch: 1, generation });
  });
}

/**
 * A page the router leaves is kept hidden, its effects cleaned up, and shown again as it was, its
 * effects run anew (React's `<Activity>`, which Next.js keeps the pages left in): a refresh on its
 * way as the page was hidden, which nothing finishes once it is, holds back none after it.
 */
describe('a shared root hidden with a refresh on its way', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    router.refresh.mockClear();
  });

  afterEach(() => {
    cleanup();
    forgetSources();
    vi.unstubAllGlobals();
  });

  it('has the route rendered again for a generation published while it was hidden', () => {
    const { rerender } = render(page('visible'));
    ready(newest(), 2);

    expect(router.refresh).toHaveBeenCalledTimes(1);

    rerender(page('hidden'));
    rerender(page('visible'));
    // The stream opened anew, which the authority answers with the view's current generation.
    ready(newest(), 3);

    expect(opened).toHaveLength(2);
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });
});
