import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { Frame, Result, View, ViewRequest } from '../src/program.ts';
import { type ViewAnswer, ViewController, type ViewHost } from '../src/runtime/view.ts';
import { type Deferred, deferred, frameAt } from './support/page.ts';

/**
 * A request names the parts the page shows otherwise than the frame first, then those whose set
 * states no subscription holds, as far as a request carries them; those it leaves out are asked for
 * once its answer is shown — where it named a part: one the page changed too, where no frame had
 * answered the change, as the answer shows it and leaves the next request the room it took.
 */

const ROOT = 'root:p1';
const CHANGED = 'part:changed';
const SET = 'part:set';
/** Text the page set, which takes a request nearly as far as it carries. */
const LONG = 'x'.repeat(1990);
const BEFORE = { [CHANGED]: { d0: { text: 'short' } }, [SET]: { d0: { open: true } } };
const AFTER = { [CHANGED]: { d0: { text: LONG } }, [SET]: { d0: { open: true } } };

type Answer = Result<ViewAnswer<string>>;

/** The frame of `ROOT` at `revision`, rendered for `view`. */
function frameFor(revision: number, view: View, subscription: string): Frame {
  return frameAt(revision, {}, { rootKey: ROOT, subscription, view });
}

/**
 * A controller of `ROOT`, started, showing `frame` — the route's, whose subscription holds no state
 * the page set — of a page that set the text of one part and the state of the other.
 */
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
  controller.keep(CHANGED, 'text', { value: LONG });
  controller.keep(SET, 'open', { value: true });
  controller.start();
  controller.show(frame);
  onTestFinished(() => {
    controller.stop();
  });
  return { answers, controller, requests };
}

/** Lets the controller's microtasks and an answer's continuation run. */
async function settle(): Promise<void> {
  await sleep(0);
}

/** Answers the request `index` with `frame`, and commits it, as the root does. */
async function answerWith(
  hosted: ReturnType<typeof controllerShowing>,
  index: number,
  frame: Frame,
): Promise<void> {
  hosted.answers[index]?.resolve({
    ok: true,
    value: { children: `tree@${String(frame.revision)}`, frame, status: 'rendered' },
  });
  await settle();
  hosted.controller.show(frame);
  await settle();
}

describe('a part left out of a request the page’s changes filled', () => {
  it('is asked for once the answer is shown, and nothing after', async () => {
    const hosted = controllerShowing(frameFor(1, BEFORE, 'route'));
    hosted.controller.commit(CHANGED, AFTER[CHANGED]);
    hosted.controller.commit(SET, AFTER[SET]);
    await settle();

    expect(hosted.requests.map(({ view }) => Object.keys(view))).toStrictEqual([[CHANGED]]);

    await answerWith(hosted, 0, frameFor(2, AFTER, 'second'));

    expect(hosted.requests.map(({ view }) => Object.keys(view))).toStrictEqual([[CHANGED], [SET]]);
    expect(hosted.requests[1]).toStrictEqual({
      subscription: 'second',
      view: { [SET]: { $set: {}, d0: { open: true } } },
    });

    await answerWith(hosted, 1, frameFor(2, AFTER, 'third'));

    expect(hosted.requests).toHaveLength(2);
  });

  // A pin, which passes before the change as well: an answer that shows the page's change otherwise
  // than it was asked for is not asked for again and again for what it left out.
  it('is asked for once more at most where each answer shows the changed part as it was', async () => {
    const hosted = controllerShowing(frameFor(1, BEFORE, 'route'));
    hosted.controller.commit(CHANGED, AFTER[CHANGED]);
    hosted.controller.commit(SET, AFTER[SET]);
    await settle();
    for (let index = 0; index < 4 && index < hosted.answers.length; index += 1) {
      await answerWith(hosted, index, frameFor(2 + index, BEFORE, `answer${String(index)}`));
    }

    expect(hosted.requests.length).toBeLessThanOrEqual(2);
  });
});
