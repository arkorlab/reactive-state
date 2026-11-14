import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { Frame, Result, View, ViewRequest } from '../src/program.ts';
import { type ViewAnswer, ViewController, type ViewHost } from '../src/runtime/view.ts';
import { type Deferred, deferred, frameAt } from './support/page.ts';

/**
 * A root stopped while a request of it is on its way, and shown anew: Next.js keeps a route left
 * in a hidden `<Activity>`, whose effects React cleans up — `LiveRoot` stops the root's controller,
 * each part lets its sites go — and runs again once the route is gone back to, the parts first.
 * The request is let go of, its answer too, and what it was sent for — a revision, a render forced
 * — is asked for again, as for a request lost.
 */

const ROOT = 'root:p1';
const PART = 'part:workspace';
const ALL = { [PART]: { d0: { filter: 'all' } } } as const satisfies View;

type Answer = Result<ViewAnswer<string>>;

/** The frame of `ROOT` at `revision`, rendered for `ALL`. */
function frameOf(revision: number): Frame {
  return frameAt(revision, {}, { rootKey: ROOT, subscription: `s${String(revision)}`, view: ALL });
}

/** A controller of `ROOT`, started, showing `frame` with its part's sites, whose requests wait. */
function controllerShowing(frame: Frame): {
  readonly answers: Deferred<Answer>[];
  readonly controller: ViewController<string>;
  readonly requests: ViewRequest[];
} {
  const requests: ViewRequest[] = [];
  const answers: Deferred<Answer>[] = [];
  const host: ViewHost<string> = {
    adopt: vi.fn<ViewHost<string>['adopt']>(),
    refresh: vi.fn<ViewHost<string>['refresh']>(),
    request: vi.fn<ViewHost<string>['request']>(async (request) => {
      requests.push(request);
      const answer = deferred<Answer>();
      answers.push(answer);
      return answer.promise;
    }),
    revoked: vi.fn<ViewHost<string>['revoked']>(),
  };
  const controller = new ViewController<string>(ROOT, host, { retryDelay: 10, timeout: 10_000 });
  controller.start();
  controller.show(frame);
  controller.commit(PART, ALL[PART]);
  onTestFinished(() => {
    controller.stop();
  });
  return { answers, controller, requests };
}

/** Lets the controller's microtasks and an answer's continuation run. */
async function settle(): Promise<void> {
  await sleep(0);
}

/** The root's route hidden, a while, and gone back to: its effects as React runs them again. */
async function hiddenAndShown(controller: ViewController<string>, frame: Frame): Promise<void> {
  controller.stop();
  controller.release(PART);
  await settle();
  controller.commit(PART, ALL[PART]);
  controller.start();
  controller.show(frame);
  await settle();
}

describe('a root shown anew while a request of it was on its way', () => {
  it('asks again for the revision the request was sent for', async () => {
    const first = frameOf(1);
    const { answers, controller, requests } = controllerShowing(first);
    await settle();
    controller.want(2);
    await settle();

    expect(requests).toHaveLength(1);

    await hiddenAndShown(controller, first);
    // The answer to the request let go of comes once it is gone: let go of too.
    answers[0]?.resolve({
      ok: true,
      value: { children: 'tree@2', frame: frameOf(2), status: 'rendered' },
    });
    await settle();

    expect(requests.map(({ subscription }) => subscription)).toStrictEqual(['s1', 's1']);
  });

  it('renders again a root it was forced to render', async () => {
    const first = frameOf(1);
    const { controller, requests } = controllerShowing(first);
    await settle();
    controller.force();
    await settle();

    expect(requests).toHaveLength(1);

    await hiddenAndShown(controller, first);

    expect(requests).toHaveLength(2);
  });

  // A pin, which passes before the change as well: a request answered before the root was stopped
  // left nothing to ask for again.
  it('asks for nothing again of a request answered before', async () => {
    const first = frameOf(1);
    const { answers, controller, requests } = controllerShowing(first);
    await settle();
    controller.want(2);
    await settle();
    const second = frameOf(2);
    answers[0]?.resolve({
      ok: true,
      value: { children: 'tree@2', frame: second, status: 'rendered' },
    });
    await settle();
    controller.show(second);
    await settle();

    await hiddenAndShown(controller, second);

    expect(requests).toHaveLength(1);
  });
});
