import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it, type Mock, onTestFinished, vi } from 'vitest';

import {
  type Frame,
  type Result,
  type View,
  VIEW_LIMITS,
  type ViewRequest,
} from '../src/program.ts';
import { type ViewAnswer, ViewController, type ViewHost } from '../src/runtime/view.ts';
import { type Deferred, deferred, frameAt, refusal } from './support/page.ts';

/**
 * A root's view controller, as `LiveRoot` drives it: its parts commit the sites they show, a render
 * not committed yet waits for one, and the controller renders the root again through the `view`
 * Server Function — stood in for here, its answers settled when a test chooses — and hands each
 * answer to the root, which commits it.
 */

const ROOT = 'root:p1';
const PART = 'part:workspace';
const ALL = { [PART]: { d0: { filter: 'all' } } } as const satisfies View;
const ACTIVE = { [PART]: { d0: { filter: 'active' } } } as const satisfies View;

/**
 * What a request names of `view`, its parts rendered with no set value no site carries: each part
 * with `$set` of none, for the authority to show besides each site whose conditions hold of its own
 * values.
 */
function sentWith(view: View): View {
  return Object.fromEntries(
    Object.entries(view).map(([instance, sites]) => [instance, { $set: {}, ...sites }]),
  );
}
/**
 * The states the page has set, by part: a request sends their values. Each test's page has set
 * those it shows, unless it says otherwise.
 */
const SET: readonly (readonly [string, string])[] = [
  [PART, 'filter'],
  [PART, 'selectedId'],
  ['part:other', 'open'],
];

type Answer = Result<ViewAnswer<string>>;

interface Hosted {
  readonly controller: ViewController<string>;
  readonly host: { readonly [K in keyof ViewHost<string>]: Mock<ViewHost<string>[K]> };
  /** The views asked for, in order, and the answer each waits for. */
  readonly requests: ViewRequest[];
  readonly answers: Deferred<Answer>[];
}

/**
 * A controller of the root `ROOT`, started, showing `frame`, whose requests the test answers, its
 * page having set the states `kept` (`SET` unless given).
 */
function controllerShowing(
  frame: Frame,
  options: { readonly timeout?: number; readonly kept?: typeof SET } = {},
): Hosted {
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
  const controller = new ViewController<string>(ROOT, host, {
    retryDelay: 10,
    timeout: options.timeout ?? 10_000,
  });
  const kept = options.kept ?? SET;
  for (const [instance, key] of kept) {
    controller.keep(instance, key);
  }
  controller.start();
  controller.show(frame);
  onTestFinished(() => {
    controller.stop();
  });
  return { answers, controller, host, requests };
}

/** The frame of `ROOT` at `revision`, rendered for `view`. */
function frameFor(revision: number, view: View, subscription = `s${String(revision)}`): Frame {
  return frameAt(revision, {}, { rootKey: ROOT, subscription, view });
}

function rendered(frame: Frame): Answer {
  return {
    ok: true,
    value: { children: `tree@${String(frame.revision)}`, frame, status: 'rendered' },
  };
}

/** Lets the controller's microtasks and an answer's continuation run. */
async function settle(): Promise<void> {
  await sleep(0);
}

async function settles(promise: Promise<unknown>): Promise<true> {
  await Promise.allSettled([promise]);
  return true;
}

/** Whether `promise` settles before a timer that runs once the microtasks queued now have run. */
async function settledSoon(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([settles(promise), sleep(0, false)]);
}

describe('a root’s view', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for nothing while the frame shown was rendered for every site its parts show', async () => {
    const { controller, host } = controllerShowing(frameFor(1, ALL));

    controller.commit(PART, ALL[PART]);
    await settle();

    expect(host.request).not.toHaveBeenCalled();
    expect(controller.covers(ALL)).toBe(true);
    expect(controller.covers(ACTIVE)).toBe(false);
  });

  it('renders the root again for a site its part shows for other inputs, once, and hands the answer on', async () => {
    const { answers, controller, host, requests } = controllerShowing(frameFor(1, ALL, 'first'));
    controller.commit(PART, ALL[PART]);
    await settle();

    controller.commit(PART, ACTIVE[PART]);
    controller.commit(PART, ACTIVE[PART]);
    await settle();

    expect(requests).toStrictEqual([{ subscription: 'first', view: sentWith(ACTIVE) }]);

    const frame = frameFor(1, ACTIVE);
    answers[0]?.resolve(rendered(frame));
    await settle();
    controller.commit(PART, ACTIVE[PART]);
    await settle();

    expect(host.adopt).toHaveBeenCalledExactlyOnceWith({
      children: 'tree@1',
      frame,
      status: 'rendered',
    });
    expect(requests).toHaveLength(1);
  });

  it('names in a request the parts the page shows otherwise than the frame does alone, each with every site it shows', async () => {
    const other = 'part:other';
    const both = { [PART]: { d0: { filter: 'all' } }, [other]: { d0: { open: true } } };
    // The other part's state follows the authority: the page shows it as the frame does.
    const { controller, requests } = controllerShowing(frameFor(1, both, 'first'), {
      kept: [[PART, 'filter']],
    });
    controller.commit(PART, both[PART]);
    controller.commit(other, both[other]);
    await settle();

    controller.commit(PART, ACTIVE[PART]);
    await settle();

    expect(requests).toStrictEqual([{ subscription: 'first', view: sentWith(ACTIVE) }]);
  });

  it('leaves out of a request the inputs of the states the page follows', async () => {
    const { controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), { kept: [] });

    controller.commit(PART, { d0: { filter: 'all' }, d1: { selectedId: 't1' } });
    await settle();

    // The authority renders each site of its own values of them, which the page takes with it.
    expect(requests).toStrictEqual([
      { subscription: 'first', view: { [PART]: { $set: {}, d0: {}, d1: {} } } },
    ]);
  });

  it('sends the value of a state the page set, while the part that holds it is rendered', async () => {
    const { controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), { kept: [] });
    controller.keep(PART, 'selectedId');
    controller.keep(PART, 'filter');

    // Rendered again, the part starts its states anew: they follow the authority until set.
    controller.release(PART);
    controller.keep(PART, 'selectedId');
    controller.commit(PART, { d0: { filter: 'active' }, d1: { selectedId: 't1' } });
    await settle();

    expect(requests).toStrictEqual([
      { subscription: 'first', view: { [PART]: { $set: {}, d0: {}, d1: { selectedId: 't1' } } } },
    ]);
  });

  it('names a part whose set state the subscription does not hold, though the page shows the frame', async () => {
    const { answers, controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), {
      kept: [],
    });
    controller.commit(PART, ALL[PART]);
    await settle();
    // Set to the value the frame was rendered for: the page shows the frame still.
    controller.keep(PART, 'filter');
    controller.want(2);
    await settle();

    expect(requests).toStrictEqual([{ subscription: 'first', view: sentWith(ALL) }]);

    const second = frameFor(2, ALL, 'second');
    answers[0]?.resolve(rendered(second));
    await settle();
    controller.show(second);
    controller.want(3);
    await settle();

    // The subscription the answer brought holds it.
    expect(requests.at(-1)).toStrictEqual({ subscription: 'second', view: {} });
  });

  it('sends the values of the states the page set of a part it names, beside its sites', async () => {
    const { controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), { kept: [] });
    controller.keep(PART, 'filter', { value: 'active' });
    controller.keep(PART, 'open', { value: false });
    controller.commit(PART, ACTIVE[PART]);
    await settle();

    expect(requests).toStrictEqual([
      {
        subscription: 'first',
        // The site carries the filter's value: `$set` holds the rest alone.
        view: { [PART]: { $set: { open: false }, d0: { filter: 'active' } } },
      },
    ]);
  });

  it('names a part whose set values the subscription does not hold, though no site it shows reads them', async () => {
    const { answers, controller, requests } = controllerShowing(frameFor(1, {}, 'first'), {
      kept: [],
    });
    controller.commit(PART, {});
    controller.keep(PART, 'show', { value: true });
    controller.want(2);
    await settle();

    expect(requests).toStrictEqual([
      { subscription: 'first', view: { [PART]: { $set: { show: true } } } },
    ]);

    const second = frameFor(2, { [PART]: {} }, 'second');
    answers[0]?.resolve(rendered(second));
    await settle();
    controller.show(second);
    controller.want(3);
    await settle();

    // The subscription holds those values: nothing to name.
    expect(requests.at(-1)).toStrictEqual({ subscription: 'second', view: {} });

    const third = frameFor(3, { [PART]: {} }, 'third');
    answers[1]?.resolve(rendered(third));
    await settle();
    controller.show(third);
    controller.keep(PART, 'show', { value: false });
    controller.want(4);
    await settle();

    expect(requests.at(-1)).toStrictEqual({
      subscription: 'third',
      view: { [PART]: { $set: { show: false } } },
    });
  });

  it('names a part the page renders anew, of no set state, with set values of none, and one it let go of without', async () => {
    const { answers, controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), {
      kept: [],
    });
    controller.commit(PART, ALL[PART]);
    await settle();

    // Hidden: the part shows no site, and opens none.
    controller.release(PART);
    await settle();

    expect(requests).toStrictEqual([{ subscription: 'first', view: { [PART]: {} } }]);

    const second = frameFor(2, { [PART]: {} }, 'second');
    answers[0]?.resolve(rendered(second));
    await settle();
    controller.show(second);
    // Shown again, following the authority: the authority opens what its states open.
    controller.ensure(PART, 'd0', { filter: 'all' });
    await settle();

    expect(requests.at(-1)).toStrictEqual({
      subscription: 'second',
      view: { [PART]: { $set: {}, d0: {} } },
    });
  });

  it('sends no set values of a part that holds one JSON carries not, which shows the sites it names alone', async () => {
    const { controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), { kept: [] });
    // The detail closed by a value no request sends: the authority must not open it of its own.
    controller.keep(PART, 'selectedId', { value: undefined });
    controller.commit(PART, ACTIVE[PART]);
    await settle();

    expect(requests).toStrictEqual([{ subscription: 'first', view: { [PART]: { d0: {} } } }]);
  });

  it('sends the set values of a part whose render holds a value JSON carries over one it carries not', async () => {
    const { controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), { kept: [] });
    controller.keep(PART, 'selectedId', { value: NaN });
    // A render not committed yet set it to a value it sends, and waits for the detail of it.
    controller.keep(PART, 'selectedId', { lasting: false, value: 't2' });
    controller.ensure(PART, 'd1', { selectedId: 't2' });
    await settle();

    expect(requests).toStrictEqual([
      { subscription: 'first', view: { [PART]: { $set: {}, d1: { selectedId: 't2' } } } },
    ]);
  });

  it('copies a set value as JSON once of each object, however many renders tell it', async () => {
    let copies = 0;
    const panels = new Proxy(
      { open: true },
      {
        getPrototypeOf(target) {
          copies += 1;
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    const { controller, requests } = controllerShowing(frameFor(1, {}, 'first'), { kept: [] });
    controller.keep(PART, 'panels', { lasting: false, value: panels });
    controller.keep(PART, 'panels', { lasting: false, value: panels });
    controller.keep(PART, 'panels', { value: panels });
    controller.commit(PART, {});
    controller.want(2);
    await settle();

    expect(copies).toBe(1);
    expect(requests.at(-1)?.view[PART]).toStrictEqual({ $set: { panels: { open: true } } });
  });

  it('sends in the set values a state two sites it names carry of other values', async () => {
    const { controller, requests } = controllerShowing(frameFor(1, {}, 'first'), { kept: [] });
    controller.keep(PART, 'open', { value: true });
    controller.commit(PART, { d1: { open: true } });
    // A render not committed yet set it otherwise, and waits for a site of that value.
    controller.keep(PART, 'open', { lasting: false, value: false });
    controller.ensure(PART, 'd2', { open: false });
    await settle();

    expect(requests.at(-1)?.view[PART]).toStrictEqual({
      $set: { open: false },
      d1: { open: true },
      d2: { open: false },
    });
  });

  it('sends no values of a part showing as many sites as a view carries of one', async () => {
    const sixteen: Record<string, View[string][string]> = {};
    for (let index = 0; index < VIEW_LIMITS.sites; index += 1) {
      sixteen[`d${String(index)}`] = { filter: 'all' };
    }
    const { controller, requests } = controllerShowing(frameFor(1, {}, 'first'), { kept: [] });
    controller.keep(PART, 'filter', { value: 'all' });
    controller.commit(PART, sixteen);
    await settle();

    expect(Object.keys(requests[0]?.view[PART] ?? {})).toHaveLength(VIEW_LIMITS.sites);
  });

  it('sends the values of the other parts beside one showing as many sites as a view carries of one', async () => {
    const sixteen: Record<string, View[string][string]> = {};
    for (let index = 0; index < VIEW_LIMITS.sites; index += 1) {
      sixteen[`d${String(index)}`] = { filter: 'all' };
    }
    const other = 'part:other';
    const { controller, requests } = controllerShowing(frameFor(1, {}, 'first'), { kept: [] });
    controller.keep(PART, 'filter', { value: 'all' });
    controller.keep(other, 'open', { value: false });
    controller.commit(PART, sixteen);
    controller.commit(other, {});
    await settle();

    expect(requests[0]?.view[other]).toStrictEqual({ $set: { open: false } });
    expect(Object.keys(requests[0]?.view[PART] ?? {})).toHaveLength(VIEW_LIMITS.sites);
  });

  it('sends no values of the states the page set where they would take the request past what it carries', async () => {
    const { controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), { kept: [] });
    controller.keep(PART, 'filter', { value: 'active' });
    controller.keep(PART, 'note', { value: 'x'.repeat(VIEW_LIMITS.bytes) });
    controller.commit(PART, ACTIVE[PART]);
    await settle();

    expect(requests).toStrictEqual([{ subscription: 'first', view: ACTIVE }]);
  });

  it('forgets a state a render told set once its part commits, where no render that commits holds it', async () => {
    const { controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), { kept: [] });
    // A render that waited and was let go of told the state set at this place.
    controller.keep(PART, 'filter', { lasting: false });
    controller.commit(PART, ACTIVE[PART]);
    await settle();

    expect(requests).toStrictEqual([
      { subscription: 'first', view: { [PART]: { $set: {}, d0: {} } } },
    ]);
  });

  it('holds no set state of a part the answer’s frame does not render', async () => {
    const { answers, controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), {
      kept: [],
    });
    controller.commit(PART, ALL[PART]);
    controller.keep(PART, 'filter');
    controller.want(2);
    await settle();
    // The authority rendered the part no more: its subscription holds nothing of it.
    const second = frameFor(2, {}, 'second');
    answers[0]?.resolve(rendered(second));
    await settle();
    controller.show(second);
    controller.want(3);
    await settle();

    expect(requests.at(-1)).toStrictEqual({ subscription: 'second', view: sentWith(ALL) });
  });

  it('names a set state of a part rendered anew, though the subscription held one of the part before', async () => {
    const { answers, controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), {
      kept: [],
    });
    controller.commit(PART, ALL[PART]);
    controller.keep(PART, 'filter');
    controller.want(2);
    await settle();
    const second = frameFor(2, ALL, 'second');
    answers[0]?.resolve(rendered(second));
    await settle();
    controller.show(second);

    // The part is no longer rendered, and is rendered again, its state set to the frame's value.
    controller.release(PART);
    controller.commit(PART, ALL[PART]);
    controller.keep(PART, 'filter');
    controller.want(3);
    await settle();

    expect(requests.at(-1)).toStrictEqual({ subscription: 'second', view: sentWith(ALL) });
  });

  it('names the parts whose set states no subscription holds within what a view request carries, the rest after', async () => {
    const parts = Array.from(
      { length: 40 },
      (_, index) => `part:${String(index).padStart(32, '0')}`,
    );
    const shown: Record<string, View[string]> = {};
    for (const part of parts) {
      shown[part] = { d0: { selected: true } };
    }
    const { answers, controller, requests } = controllerShowing(frameFor(1, shown, 'route'), {
      kept: parts.map((part) => [part, 'selected'] as const),
    });
    for (const part of parts) {
      controller.commit(part, shown[part] ?? {});
    }
    controller.want(2);
    await settle();
    const first = requests[0]?.view ?? {};

    expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThanOrEqual(
      VIEW_LIMITS.bytes,
    );
    expect(Object.keys(first).length).toBeGreaterThan(0);

    // The answer is taken: the rest are asked for after it, with no revision more to tell.
    const second = frameFor(2, shown, 'second');
    answers[0]?.resolve(rendered(second));
    await settle();
    controller.show(second);
    await settle();
    const rest = Object.keys(requests[1]?.view ?? {});

    expect(rest.length).toBeGreaterThan(0);
    expect(rest.filter((part) => Object.hasOwn(first, part))).toStrictEqual([]);
  });

  it('asks for no rest of a request cut short that named none', async () => {
    const wide = 'part:wide';
    const huge = { d0: { selected: 'x'.repeat(VIEW_LIMITS.bytes) } };
    const { answers, controller, requests } = controllerShowing(
      frameFor(1, { [wide]: huge }, 'first'),
      { kept: [[wide, 'selected']] },
    );
    controller.commit(wide, huge);
    controller.want(2);
    await settle();
    const second = frameFor(2, { [wide]: huge }, 'second');
    answers[0]?.resolve(rendered(second));
    await settle();
    controller.show(second);
    await settle();

    // A part that alone fits no request is never named: nothing is asked for again for it.
    expect(requests).toStrictEqual([{ subscription: 'first', view: {} }]);
  });

  it('names a set state again once the route renders the root, whose subscription holds none', async () => {
    const { answers, controller, requests } = controllerShowing(frameFor(1, ALL, 'first'), {
      kept: [],
    });
    controller.commit(PART, ALL[PART]);
    controller.keep(PART, 'filter');
    controller.want(2);
    await settle();
    const second = frameFor(2, ALL, 'second');
    answers[0]?.resolve(rendered(second));
    await settle();
    controller.show(second);

    // The route renders the root again, after an operation, as its states start.
    controller.show(frameFor(3, ALL, 'route'));
    controller.want(4);
    await settle();

    expect(requests.at(-1)).toStrictEqual({ subscription: 'route', view: sentWith(ALL) });
  });

  it('renders the root again without a site the page no longer shows, once, which waits for nothing', async () => {
    const both = { [PART]: { d0: { filter: 'all' }, d1: { selectedId: 't1' } } };
    const { answers, controller, host, requests } = controllerShowing(frameFor(1, both, 'both'));

    // The frame shows what the page shows, and more: nothing waits, but the detail is let go of.
    expect(controller.covers(ALL)).toBe(true);

    controller.commit(PART, ALL[PART]);
    await settle();

    expect(requests).toStrictEqual([{ subscription: 'both', view: sentWith(ALL) }]);

    const frame = frameFor(2, ALL);
    answers[0]?.resolve(rendered(frame));
    await settle();
    controller.show(frame);
    await settle();

    expect(host.adopt).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it('asks for one view at a time, and lets go of an answer for a view the page moved past (A, B, A)', async () => {
    const { answers, controller, host, requests } = controllerShowing(frameFor(1, ALL));
    controller.commit(PART, ALL[PART]);
    await settle();

    controller.commit(PART, ACTIVE[PART]);
    await settle();
    controller.commit(PART, { d0: { filter: 'completed' } });
    await settle();
    controller.commit(PART, ACTIVE[PART]);
    await settle();

    expect(requests.map(({ view }) => view)).toStrictEqual([sentWith(ACTIVE)]);

    // The first answer is for the view shown now, but for a generation of it the page moved past.
    answers[0]?.resolve(rendered(frameFor(9, ACTIVE)));
    await settle();

    expect(host.adopt).not.toHaveBeenCalled();
    expect(requests.map(({ view }) => view)).toStrictEqual([sentWith(ACTIVE), sentWith(ACTIVE)]);

    answers[1]?.resolve(rendered(frameFor(4, ACTIVE)));
    await settle();

    expect(host.adopt.mock.calls.map(([answer]) => answer.frame.revision)).toStrictEqual([4]);
  });

  it('asks for nothing once the page shows again what the frame was rendered for', async () => {
    const { answers, controller, host, requests } = controllerShowing(frameFor(1, ALL));
    controller.commit(PART, ALL[PART]);
    await settle();
    controller.commit(PART, ACTIVE[PART]);
    await settle();
    controller.commit(PART, ALL[PART]);
    await settle();

    answers[0]?.resolve(rendered(frameFor(2, ACTIVE)));
    await settle();

    expect(requests).toHaveLength(1);
    expect(host.adopt).not.toHaveBeenCalled();
  });

  it('renders the root again for a newer revision with the view shown now, folding the ones told meanwhile', async () => {
    const { answers, controller, requests } = controllerShowing(frameFor(1, ALL, 'first'));
    controller.commit(PART, ACTIVE[PART]);
    await settle();
    answers[0]?.resolve(rendered(frameFor(1, ACTIVE, 'second')));
    await settle();
    controller.show(frameFor(1, ACTIVE, 'second'));

    controller.want(2);
    await settle();
    controller.want(3);
    controller.want(4);
    await settle();

    // The page shows what the frame was rendered for: the request changes nothing of the view its
    // subscription names.
    expect(requests.slice(1)).toStrictEqual([{ subscription: 'second', view: {} }]);

    answers[1]?.resolve(rendered(frameFor(2, ACTIVE)));
    await settle();

    expect(requests).toHaveLength(3);

    answers[2]?.resolve(rendered(frameFor(4, ACTIVE)));
    await settle();
    controller.want(4);
    await settle();

    expect(requests).toHaveLength(3);
  });

  it('asks for a revision once, though the answer is older', async () => {
    const { answers, controller, requests } = controllerShowing(frameFor(1, ALL));

    controller.want(5);
    await settle();
    answers[0]?.resolve(rendered(frameFor(3, ALL)));
    await settle();
    controller.want(5);
    await settle();

    expect(requests).toHaveLength(1);
  });

  it('lets go of an answer older than the frame shown, and asks again for what it still lacks', async () => {
    const { answers, controller, host, requests } = controllerShowing(frameFor(1, ALL));
    controller.commit(PART, ACTIVE[PART]);
    await settle();

    // The route rendered the root newer meanwhile, for the view the page showed then.
    controller.show(frameFor(5, ALL));
    answers[0]?.resolve(rendered(frameFor(4, ACTIVE)));
    await settle();

    expect(host.adopt).not.toHaveBeenCalled();
    expect(requests.map(({ subscription }) => subscription)).toStrictEqual(['s1', 's5']);
  });

  it('renders the root again without the sites of a part no longer rendered, and forgets the part once no frame renders it', async () => {
    const { answers, controller, host, requests } = controllerShowing(frameFor(1, ALL, 'all'));
    controller.commit(PART, ALL[PART]);
    await settle();

    // A component of the browser's stopped rendering the part: its sites are let go of.
    controller.release(PART);
    await settle();

    const none = { [PART]: {} };

    expect(requests).toStrictEqual([{ subscription: 'all', view: none }]);

    answers[0]?.resolve(rendered(frameFor(2, none)));
    await settle();
    controller.show(frameFor(2, none));
    await settle();
    // A frame that renders the part no more has nothing of it to let go of.
    controller.show(frameFor(3, {}));
    await settle();

    expect(host.adopt).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it('wishes for nothing its part committed, though React warming the tree renders it again', async () => {
    const first = { [PART]: { d0: { filter: 'all' }, d1: { selectedId: 't1' } } };
    const second = { [PART]: { d0: { filter: 'all' }, d1: { selectedId: 't2' } } };
    const { answers, controller, host, requests } = controllerShowing(frameFor(1, first));
    controller.commit(PART, first[PART]);
    await settle();

    // The part shows the second, its site waiting; React renders the site again as it warms it.
    controller.ensure(PART, 'd1', { selectedId: 't2' });
    controller.commit(PART, second[PART]);
    controller.ensure(PART, 'd1', { selectedId: 't2' });
    await settle();

    expect(requests.map(({ view }) => view)).toStrictEqual([sentWith(second)]);

    // Back on the first before the answer, which the frame shows: the answer is let go of.
    controller.commit(PART, first[PART]);
    await settle();
    answers[0]?.resolve(rendered(frameFor(2, second)));
    await settle();

    expect(host.adopt).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('asks for what a render not committed yet waits for, over what its part committed', async () => {
    const { answers, controller, requests } = controllerShowing(frameFor(1, ALL));
    controller.commit(PART, { d0: { filter: 'all' } });
    await settle();

    controller.ensure(PART, 'd1', { selectedId: 't1' });
    await settle();

    expect(requests.map(({ view }) => view)).toStrictEqual([
      sentWith({ [PART]: { d0: { filter: 'all' }, d1: { selectedId: 't1' } } }),
    ]);

    // The part commits as it was, the answer not committed yet: the wish stands.
    controller.commit(PART, { d0: { filter: 'all' } });
    await settle();

    expect(requests).toHaveLength(1);

    const both = { [PART]: { d0: { filter: 'all' }, d1: { selectedId: 't1' } } };
    answers[0]?.resolve(rendered(frameFor(2, both)));
    await settle();
    controller.show(frameFor(2, both));
    // Once a frame committed since, the part commits what its render that waited showed — here,
    // not the detail after all, which the root is rendered again without.
    controller.commit(PART, { d0: { filter: 'all' } });
    await settle();

    expect(controller.covers({ [PART]: { d0: { filter: 'all' } } })).toBe(true);
    expect(requests.map(({ view }) => view)).toStrictEqual([sentWith(both), sentWith(ALL)]);
  });

  it('keeps a site waiting on one promise until a frame commits, and on another after', async () => {
    const { controller } = controllerShowing(frameFor(1, ALL));
    const first = controller.waitFor(PART, 'd0', { filter: 'active' });

    expect(controller.waitFor(PART, 'd0', { filter: 'active' })).toBe(first);
    expect(controller.waitFor(PART, 'd0', { filter: 'completed' })).not.toBe(first);
    await expect(settledSoon(first)).resolves.toBe(false);

    controller.show(frameFor(2, ACTIVE));

    await expect(settledSoon(first)).resolves.toBe(true);
    expect(controller.waitFor(PART, 'd0', { filter: 'active' })).not.toBe(first);
  });

  it('renders the route again for a refused session, and asks with what the route renders', async () => {
    const { answers, controller, host, requests } = controllerShowing(frameFor(1, ALL, 'old'));
    controller.commit(PART, ACTIVE[PART]);
    await settle();

    answers[0]?.resolve(refusal(403, 'FORBIDDEN', 'This subscription is not yours.'));
    await settle();
    controller.want(2);
    await settle();

    expect(host.refresh).toHaveBeenCalledExactlyOnceWith();
    expect(controller.refreshing).toBe(true);
    expect(requests).toHaveLength(1);

    controller.show(frameFor(2, ALL, 'new'));
    await settle();

    expect(controller.refreshing).toBe(false);
    expect(requests.map(({ subscription }) => subscription)).toStrictEqual(['old', 'new']);
  });

  it('fails the sites that wait once the session is refused again after the route rendered', async () => {
    const { answers, controller, host } = controllerShowing(frameFor(1, ALL));
    controller.commit(PART, ACTIVE[PART]);
    const waiting = controller.waitFor(PART, 'd0', { filter: 'active' });
    await settle();
    answers[0]?.resolve(refusal(401, 'UNAUTHENTICATED', 'Sign in first.'));
    await settle();
    controller.show(frameFor(2, ALL));
    const again = controller.waitFor(PART, 'd0', { filter: 'active' });
    await settle();

    answers[1]?.resolve(refusal(401, 'UNAUTHENTICATED', 'Sign in first.'));

    await expect(waiting).resolves.toBeUndefined();
    await expect(again).rejects.toThrow('Sign in first.');
    expect(host.refresh).toHaveBeenCalledExactlyOnceWith();
  });

  it('asks for a reload once the page’s build is refused, and nothing more', async () => {
    const { answers, controller, host, requests } = controllerShowing(frameFor(1, ALL));
    controller.commit(PART, ACTIVE[PART]);
    await settle();

    answers[0]?.resolve(refusal(409, 'BUILD_MISMATCH', 'The application was updated.'));
    await settle();
    controller.want(7);
    controller.force();
    await settle();

    expect(host.revoked).toHaveBeenCalledExactlyOnceWith(
      'The application was updated.',
      'BUILD_MISMATCH',
    );
    expect(requests).toHaveLength(1);
  });

  it('fails the sites that wait for a view refused, and asks for it no more', async () => {
    const { answers, controller, requests } = controllerShowing(frameFor(1, ALL));
    controller.ensure(PART, 'd0', { filter: 'active' });
    const waiting = controller.waitFor(PART, 'd0', { filter: 'active' });
    await settle();

    answers[0]?.resolve(refusal(400, 'INVALID_VIEW', 'The view is not valid.'));

    await expect(waiting).rejects.toMatchObject({
      cause: { code: 'INVALID_VIEW', status: 400 },
      message: 'The view is not valid.',
    });

    controller.ensure(PART, 'd0', { filter: 'active' });
    await settle();

    expect(requests).toHaveLength(1);

    controller.ensure(PART, 'd0', { filter: 'completed' });
    await settle();

    expect(requests).toHaveLength(2);
  });

  it('sends again a request that failed, or that the authority could not answer, after a wait that doubles', async () => {
    vi.useFakeTimers();
    const { controller, host } = controllerShowing(frameFor(1, ALL));
    host.request
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(refusal(503, 'AUTHORITY_UNAVAILABLE', 'unreachable'))
      .mockResolvedValueOnce(rendered(frameFor(2, ACTIVE)));
    controller.commit(PART, ACTIVE[PART]);

    await vi.advanceTimersByTimeAsync(0);

    expect(host.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9);

    expect(host.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(host.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(19);

    expect(host.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);

    expect(host.request).toHaveBeenCalledTimes(3);
    expect(host.adopt).toHaveBeenCalledTimes(1);
  });

  it('sends again a request that brings no answer in time, and lets go of its late answer', async () => {
    vi.useFakeTimers();
    const { answers, controller, host, requests } = controllerShowing(frameFor(1, ALL), {
      timeout: 100,
    });
    controller.commit(PART, ACTIVE[PART]);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(100 + 10);

    expect(requests).toHaveLength(2);

    answers[0]?.resolve(rendered(frameFor(2, ACTIVE)));
    await vi.advanceTimersByTimeAsync(0);

    expect(host.adopt).not.toHaveBeenCalled();

    answers[1]?.resolve(rendered(frameFor(3, ACTIVE)));
    await vi.advanceTimersByTimeAsync(0);

    expect(host.adopt.mock.calls.map(([answer]) => answer.frame.revision)).toStrictEqual([3]);
  });

  it('renders the root again when forced, and again after a forced request that failed', async () => {
    vi.useFakeTimers();
    const { controller, host } = controllerShowing(frameFor(1, ALL));
    host.request
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(rendered(frameFor(1, ALL)));

    controller.force();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);

    expect(host.request).toHaveBeenCalledTimes(2);
    expect(host.adopt).toHaveBeenCalledTimes(1);
  });

  it('lets every site that waits go, and drops what is on its way, once stopped', async () => {
    const { answers, controller, host } = controllerShowing(frameFor(1, ALL));
    controller.ensure(PART, 'd0', { filter: 'active' });
    const waiting = controller.waitFor(PART, 'd0', { filter: 'active' });
    await settle();

    controller.stop();
    answers[0]?.resolve(rendered(frameFor(2, ACTIVE)));
    await settle();

    await expect(waiting).resolves.toBeUndefined();
    expect(host.adopt).not.toHaveBeenCalled();
  });

  it('asks for nothing for a root the session may not follow', async () => {
    const { controller, host } = controllerShowing(frameFor(1, {}, ''));

    controller.commit(PART, ACTIVE[PART]);
    controller.force();
    await settle();

    expect(host.request).not.toHaveBeenCalled();
  });
});
