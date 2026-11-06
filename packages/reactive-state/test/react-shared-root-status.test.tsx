// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedRoot, type SharedRootProps } from '../src/react/shared-root.tsx';
import type { SharedView } from '../src/routing.ts';
import { FakeEventSource, forgetSources, frameAt } from './support/page.ts';

const router = vi.hoisted(() => ({ refresh: vi.fn<() => void>() }));

vi.mock(import('next/navigation'), () => ({ useRouter: () => router as never }));

const EVENTS = '/api/reactive-state/events';
const VIEW: SharedView = { epoch: 1, generation: 1, token: 'view:boards/p1@1.1' };
// Of no session, as a shared view's frame is.
const FRAME = frameAt(1, {}, { rootKey: 'root:boards/p1', subscription: '' });

/** What the page shows of the board; nothing once it is hidden. */
function shown(): string | null {
  return screen.queryByTestId('board')?.textContent ?? null;
}

/**
 * A shared root shows its tree only where the authority answered the render of its view `rendered`
 * (`renderRouteRoot` hands it what it answered): one told nothing of it guesses neither way, and its
 * type has it told.
 */
describe('the status a shared root is rendered with', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    cleanup();
    forgetSources();
    vi.unstubAllGlobals();
  });

  it('is one the root is always given, and shows nothing of a view it is not told was rendered', () => {
    // @ts-expect-error -- A shared root is told how the authority answered the render of its view.
    const props: SharedRootProps = { events: EVENTS, frame: FRAME, view: VIEW };
    render(
      <SharedRoot {...props}>
        <h2 data-testid="board">Board</h2>
      </SharedRoot>,
    );

    expect(shown()).toBeNull();
  });

  // A pin, which passes before the change as well: a view rendered is shown.
  it('shows the tree of a view rendered', () => {
    render(
      <SharedRoot events={EVENTS} frame={FRAME} status="rendered" view={VIEW}>
        <h2 data-testid="board">Board</h2>
      </SharedRoot>,
    );

    expect(shown()).toBe('Board');
  });
});
