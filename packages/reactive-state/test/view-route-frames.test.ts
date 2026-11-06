import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { Frame, Result, View, ViewRequest } from '../src/program.ts';
import { type ViewAnswer, ViewController, type ViewHost } from '../src/runtime/view.ts';
import { type Deferred, deferred, frameAt, refusal } from './support/page.ts';

/**
 * A frame the route rendered, shown after one that answered the page's view: the route renders the
 * root for the sites its states' first values show, and `LiveRoot` takes it whole once the session
 * was refused, or where it shows every site the page shows. It answers none of the page's views,
 * so the root is rendered again for what the page shows otherwise, as for the first frame shown.
 */

const ROOT = 'root:p1';
const PART = 'part:workspace';
const ALL = { [PART]: { d0: { filter: 'all' } } } as const satisfies View;
const ACTIVE = { [PART]: { d0: { filter: 'active' } } } as const satisfies View;

type Answer = Result<ViewAnswer<string>>;

/** The frame of `ROOT` at `revision`, rendered for `view`. */
function frameFor(revision: number, view: View, subscription: string): Frame {
  return frameAt(revision, {}, { rootKey: ROOT, subscription, view });
}

/** A controller of `ROOT`, started, showing `frame`, of a page that set the filter. */
function controllerShowing(frame: Frame): {
  readonly answers: Deferred<Answer>[];
  readonly controller: ViewController<string>;
  readonly host: { readonly refresh: ReturnType<typeof vi.fn<ViewHost<string>['refresh']>> };
  readonly requests: ViewRequest[];
} {
  const requests: ViewRequest[] = [];
  const answers: Deferred<Answer>[] = [];
  const host = {
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
  controller.keep(PART, 'filter');
  controller.start();
  controller.show(frame);
  onTestFinished(() => {
    controller.stop();
  });
  return { answers, controller, host, requests };
}

/** Lets the controller's microtasks and an answer's continuation run. */
async function settle(): Promise<void> {
  await sleep(0);
}

/** Answers the first request with `frame`, which the root commits. */
async function answerFirst(
  hosted: ReturnType<typeof controllerShowing>,
  frame: Frame,
): Promise<void> {
  hosted.answers[0]?.resolve({
    ok: true,
    value: { children: `tree@${String(frame.revision)}`, frame, status: 'rendered' },
  });
  await settle();
  hosted.controller.show(frame);
  await settle();
}

/** What a request names of `ACTIVE`: the part with `$set` of none, as the page set no value. */
const SENT = { [PART]: { $set: {}, ...ACTIVE[PART] } } as const satisfies View;

describe('a frame the route rendered, shown after an answer', () => {
  it('has the root rendered again for the inputs the page keeps, once the session was refused', async () => {
    const hosted = controllerShowing(frameFor(1, ALL, 'first'));
    hosted.controller.commit(PART, ACTIVE[PART]);
    await settle();
    await answerFirst(hosted, frameFor(2, ACTIVE, 'second'));
    hosted.controller.want(3);
    await settle();
    hosted.answers[1]?.resolve(refusal(403, 'FORBIDDEN', 'This subscription is not yours.'));
    await settle();

    expect(hosted.host.refresh).toHaveBeenCalledExactlyOnceWith();

    // The route renders the root for the filter's first value; the part keeps the one it set.
    hosted.controller.show(frameFor(3, ALL, 'route'));
    hosted.controller.commit(PART, ACTIVE[PART]);
    await settle();

    expect(hosted.requests.at(-1)).toStrictEqual({ subscription: 'route', view: SENT });
  });

  it('has the root rendered again without a site the page does not show', async () => {
    const hosted = controllerShowing(frameFor(1, ALL, 'first'));
    hosted.controller.commit(PART, ACTIVE[PART]);
    await settle();
    await answerFirst(hosted, frameFor(2, ACTIVE, 'second'));

    // The route renders a site more, which the root takes as it shows every site the page shows.
    hosted.controller.show(
      frameFor(3, { [PART]: { ...ACTIVE[PART], d1: { selectedId: 't1' } } }, 'route'),
    );
    await settle();

    expect(hosted.requests.at(-1)).toStrictEqual({ subscription: 'route', view: SENT });
  });

  // A pin, which passes before the change as well: a frame of the route that shows what the page
  // shows has nothing to ask for.
  it('asks for nothing where the route’s frame shows what the page shows', async () => {
    const hosted = controllerShowing(frameFor(1, ALL, 'first'));
    hosted.controller.commit(PART, ACTIVE[PART]);
    await settle();
    await answerFirst(hosted, frameFor(2, ACTIVE, 'second'));

    hosted.controller.show(frameFor(3, ACTIVE, 'route'));
    await settle();

    expect(hosted.requests).toHaveLength(1);
  });
});
