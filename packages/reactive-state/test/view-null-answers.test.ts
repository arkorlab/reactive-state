import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { Frame, Result, View } from '../src/program.ts';
import { type ViewAnswer, ViewController, type ViewHost } from '../src/runtime/view.ts';
import { frameAt } from './support/page.ts';

/**
 * An answer of the root's `view` Server Function that is no `Result` of an answer — as a newer
 * build's may not be — is taken for none, and the request is sent again after a wait: one whose
 * frame, or whose frame's view, is `null`, as JSON and React's payload carry it, too, which `typeof`
 * says is an object.
 */

const ROOT = 'root:p1';
const PART = 'part:workspace';
const ALL = { [PART]: { d0: { filter: 'all' } } } as const satisfies View;
const ACTIVE = { [PART]: { d0: { filter: 'active' } } } as const satisfies View;

/** The frame of `ROOT` at `revision`, rendered for `view`. */
function frameFor(revision: number, view: View): Frame {
  return frameAt(revision, {}, { rootKey: ROOT, subscription: `s${String(revision)}`, view });
}

/** A controller of `ROOT`, started, showing `frame`, whose requests `request` answers. */
function controllerShowing(frame: Frame): {
  readonly controller: ViewController<string>;
  readonly host: {
    readonly [K in keyof ViewHost<string>]: ReturnType<typeof vi.fn<ViewHost<string>[K]>>;
  };
} {
  const host = {
    adopt: vi.fn<ViewHost<string>['adopt']>(),
    refresh: vi.fn<ViewHost<string>['refresh']>(),
    request: vi.fn<ViewHost<string>['request']>(),
    revoked: vi.fn<ViewHost<string>['revoked']>(),
  };
  const controller = new ViewController<string>(ROOT, host, { retryDelay: 10, timeout: 10_000 });
  controller.start();
  controller.show(frame);
  onTestFinished(() => {
    controller.stop();
  });
  return { controller, host };
}

describe('an answer of the view Server Function that is no result of an answer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['of no frame', { children: 'tree@2', frame: null, status: 'rendered' }],
    [
      'of a frame of no view',
      { children: 'tree@2', frame: { ...frameFor(2, ACTIVE), view: null }, status: 'rendered' },
    ],
  ])('is sent again after a wait, %s', async (_what, value) => {
    vi.useFakeTimers();
    const { controller, host } = controllerShowing(frameFor(1, ALL));
    const answer = { children: 'tree@2', frame: frameFor(2, ACTIVE), status: 'rendered' } as const;
    host.request
      .mockResolvedValueOnce({ ok: true, value } as unknown as Result<ViewAnswer<string>>)
      .mockResolvedValueOnce({ ok: true, value: answer });
    controller.commit(PART, ACTIVE[PART]);
    await vi.advanceTimersByTimeAsync(0);

    expect(host.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);

    expect(host.request).toHaveBeenCalledTimes(2);
    expect(host.adopt).toHaveBeenCalledExactlyOnceWith(answer);
  });
});
