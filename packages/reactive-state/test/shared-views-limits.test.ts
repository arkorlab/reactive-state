import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { type Engine, startAuthority } from '../src/authority/index.ts';
import { ARTIFACT_DEADLINE_MS, MAX_ARTIFACT_BYTES } from '../src/authority/shared-generate.ts';
import { MAX_PROPS_LENGTH } from '../src/authority/shared-requests.ts';
import { MAX_VIEWS, type SharedFollowing } from '../src/authority/shared-views.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import type { RouteRegistration, SharedRenderAnswer } from '../src/routing.ts';
import { application, BUILD as APP_BUILD } from './support/program.ts';
import {
  BOARD,
  BUILD,
  follow,
  headerOf,
  open,
  pageOf,
  quiet,
  shownOf,
  viewTokenOf,
} from './support/shared-fixture.ts';

/**
 * A shared view at the authority's limits: as many views as it keeps, every one of them being made
 * or followed, a view followed past the day it is kept for, one asked for until a restart more than
 * a day after it was published, a site that takes a request for an artifact and never finishes
 * answering it, and a page past what an artifact may be — against the engine-only application of
 * `support/shared-fixture.ts`, whose site renders each page as its root entry does, and the Node
 * authority's own requests of a site, for the test application.
 */

/** The page of the to-do a pin names: a view of its own for each pin, which shows `none` for one not there. */
const PINNED = '/pinned/[pinId]';
/** Long enough for every view's artifacts to be made once the site answers. */
const MADE_MS = 30_000;
/** Past the wait before a request for an artifact that failed is made again. */
const RETRY_WAIT_MS = 1000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** What a page past what an artifact may be is padded with, a chunk at a time. */
const PADDING_BYTES = 65_536;

/** A page every visitor is shown alike, whose root reads nothing. */
const HELLO = '/hello/[id]';
const hello: ComponentProgram = {
  buildId: APP_BUILD,
  component: 'components/hello',
  evaluate: (_props: Readonly<Record<string, unknown>>, $: RenderScope) => $.h('p', null, 'hello'),
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};
const HELLO_ROUTE: RouteRegistration = {
  blocking: true,
  middleware: [],
  page: 'hello/[id]/page.tsx',
  params: ['id'],
  props: { id: 'id' },
  root: hello.component,
  route: HELLO,
  shared: true,
};

/** p1's board's props with a note besides its param, `length` characters long as JSON. */
function noted(length: number): Readonly<Record<string, string>> {
  const pad = length - JSON.stringify({ note: '', projectId: 'p1' }).length;
  return { note: 'x'.repeat(pad), projectId: 'p1' };
}

/** The pinned page of `pinId`, as its page asks for it. */
async function pinned(engine: Engine, pinId: string): Promise<SharedRenderAnswer> {
  return engine.renderShared(null, { build: BUILD, props: { pinId }, route: PINNED });
}

/** Keeps the authority's log of what failed out of the output, for the rest of the test. */
function silenced(): void {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {
    // What the authority logs of a request it gave up, kept out of the output.
  });
  onTestFinished(() => {
    logged.mockRestore();
  });
}

/** A page's answer whose body never ends: its status and headers, the body's start, and no more. */
function endless(answer: Response): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<!DOCTYPE html>'));
    },
  });
  return new Response(body, { headers: answer.headers, status: answer.status });
}

/**
 * A page's answer, `body` padded to twice what an artifact may be, a chunk at a time as it is read:
 * `cancelled` called where whoever reads it lets go of it first.
 */
function oversized(answer: Response, body: string, cancelled: () => void): Response {
  const padding = new TextEncoder().encode(' '.repeat(PADDING_BYTES));
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel: cancelled,
    pull(controller) {
      if (sent > 2 * MAX_ARTIFACT_BYTES) {
        controller.close();
        return;
      }
      sent += padding.byteLength;
      controller.enqueue(padding);
    },
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
  });
  return new Response(stream, { headers: answer.headers, status: answer.status });
}

/** A site's answer to each request for a page, as a site that is down answers. */
function refused(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 503 }));
}

/** A file in a directory of the test's own under the system's, removed when the test finishes. */
async function databaseFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'reactive-state-limits-'));
  onTestFinished(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  return join(dir, 'authority.sqlite');
}

/** Withdraws p1's board as Alice, signed in anew: by then, any session of hers may have ended. */
async function withdrawn(engine: Engine): Promise<void> {
  const { sessionId } = await engine.login('alice');
  await engine.operate(sessionId, {
    args: [{ json: 'p1' }, { json: false }],
    build: BUILD,
    module: 'actions/admin',
    name: 'setPublished',
    operationId: 'withdraw-p1',
  });
}

describe('a shared view at the authority’s limits', () => {
  it(
    'takes in no view past the most it keeps while every one is being made, and one again once one is not',
    { timeout: MADE_MS },
    async () => {
      const site = Promise.withResolvers<undefined>();
      const { ask, engine } = await open({
        gateWaitMs: 50,
        site: (opened) => {
          const page = pageOf(opened);
          return async (path, headers) => {
            await site.promise;
            return page(path, headers);
          };
        },
      });
      for (let index = 0; index < MAX_VIEWS; index += 1) {
        await pinned(engine, `pin-${String(index)}`);
      }

      await expect(pinned(engine, 'one-more')).rejects.toMatchObject({
        code: 'TOO_MANY_VIEWS',
        status: 503,
      });
      // Its gate answers at once, as of a view it cannot decide: no wait, and no view kept for it.
      await expect(ask('/pinned/one-more')).resolves.toMatchObject({ status: 503 });
      await expect(
        ask('/pinned/one-more', { 'next-router-prefetch': '1', rsc: '1' }),
      ).resolves.toMatchObject({ status: 503 });
      await expect(engine.stats()).resolves.toMatchObject({ gateWaits: 0, sharedViews: MAX_VIEWS });

      site.resolve(undefined);

      await expect
        .poll(async () => (await engine.stats()).generations, { timeout: MADE_MS })
        .toBe(2 * MAX_VIEWS);
      // The view asked for longest ago is let go of, and the new one kept in its place.
      await expect
        .poll(async () => shownOf(await ask('/pinned/one-more')))
        .toStrictEqual({ generation: 'g1', texts: ['none'] });
      await expect(engine.stats()).resolves.toMatchObject({ sharedViews: MAX_VIEWS });
    },
  );

  it(
    'lets go of no view a page follows to make room for another, and tells the page of its withdrawal',
    { timeout: MADE_MS },
    async () => {
      let now = Date.UTC(2026, 9, 17);
      const { ask, engine } = await open({ clock: () => now });
      // The board, asked for before any other view, and followed by its page.
      await ask('/boards/p1');
      const heard = await follow(engine, await viewTokenOf(engine, 'p1'));
      // Every other view evaluated, with nothing under way for it: no site to make it of.
      engine.site(undefined);
      for (let index = 1; index < MAX_VIEWS; index += 1) {
        now += 1;
        await pinned(engine, `pin-${String(index)}`);
      }
      now += 1;
      await pinned(engine, 'one-more');
      await withdrawn(engine);

      await expect.poll(() => heard.map((event) => event.kind)).toStrictEqual(['ready', 'denied']);
      await expect(engine.stats()).resolves.toMatchObject({ sharedViews: MAX_VIEWS });
    },
  );

  it(
    'keeps a view slot evictable at the shared follower limit, and admits another follower after stop',
    { timeout: MADE_MS },
    async () => {
      const { engine } = await open();
      engine.site(undefined);
      const followings: SharedFollowing[] = [];
      onTestFinished(() => {
        for (const following of followings) {
          following.stop();
        }
      });
      for (let index = 0; index < MAX_VIEWS - 1; index += 1) {
        const shown = await pinned(engine, `pin-${String(index)}`);
        followings.push(await engine.followShared(shown.kind === 'shared' ? shown.view.token : ''));
      }

      const shown = await pinned(engine, 'unfollowed');
      const token = shown.kind === 'shared' ? shown.view.token : '';

      await expect(engine.followShared(token)).rejects.toMatchObject({
        code: 'TOO_MANY_SHARED_STREAMS',
        status: 503,
      });
      await expect(pinned(engine, 'one-more')).resolves.toMatchObject({ kind: 'shared' });

      followings[0]?.stop();

      followings.push(await engine.followShared(token));

      await expect(engine.stats()).resolves.toMatchObject({
        sharedStreams: MAX_VIEWS - 1,
        sharedViews: MAX_VIEWS,
      });
    },
  );

  it('keeps a view a page follows past the day nobody asked for it, and tells the page of its withdrawal', async () => {
    let now = Date.UTC(2026, 9, 17);
    const { ask, engine } = await open({ clock: () => now });
    await ask('/boards/p1');
    const heard = await follow(engine, await viewTokenOf(engine, 'p1'));
    await quiet(engine);
    // Two days on, nobody having asked for the board since: a request for another view has the
    // views nobody asked for in a day looked for.
    now += 2 * DAY_MS;
    await ask('/boards/p2');
    await withdrawn(engine);

    await expect.poll(() => heard.map((event) => event.kind)).toStrictEqual(['ready', 'denied']);
  });

  it('keeps, across a restart, a view asked for until then more than a day after it was published', async () => {
    const start = Date.UTC(2026, 9, 17);
    let now = start;
    const filename = await databaseFile();
    const first = await open({ clock: () => now, filename });
    const etag = headerOf(await first.ask('/boards/p1'), 'etag') ?? '';
    // Asked for every few hours, for a day and a half, unchanged all along.
    for (let hours = 6; hours <= 36; hours += 6) {
      now = start + hours * HOUR_MS;
      await first.ask('/boards/p1');
    }
    await first.close();
    now += MINUTE_MS;
    const reopened = await open({ clock: () => now, filename });

    // What it kept, answered as it was, with nothing made again.
    await expect(reopened.ask('/boards/p1', { 'if-none-match': etag })).resolves.toMatchObject({
      status: 304,
    });
    expect(reopened.asked).toStrictEqual([]);
  });

  it('makes a view the request’s whose page is past what an artifact may be, revoked, and never reads it whole', async () => {
    silenced();
    let cancelled = 0;
    const { ask, engine, operate } = await open({
      site: (opened) => {
        const page = pageOf(opened);
        return async (path, headers) => {
          const answer = await page(path, headers);
          const body = await answer.text();
          return body.includes('長い一覧')
            ? oversized(answer, body, () => {
                cancelled += 1;
              })
            : new Response(body, { headers: answer.headers, status: answer.status });
        };
      },
    });
    await ask('/boards/p1');
    const heard = await follow(engine, await viewTokenOf(engine, 'p1'));
    const before = await engine.stats();
    await operate('setTodoTitle', 't1', '長い一覧');

    // Rendered for each request from now on, never a 503; and the page that shows the view told
    // to ask for the route again.
    await expect(ask('/boards/p1')).resolves.toStrictEqual({ kind: 'pass' });
    await expect(ask('/boards/p1', { rsc: '1' })).resolves.toStrictEqual({ kind: 'pass' });
    await expect(
      engine.renderShared(null, { build: BUILD, props: { projectId: 'p1' }, route: BOARD }),
    ).resolves.toMatchObject({ kind: 'session' });
    expect(heard).toStrictEqual([
      { epoch: 1, generation: 1, kind: 'ready' },
      { epoch: 2, kind: 'denied' },
    ]);
    // The page's body let go of as soon as it was past it, and nothing of it kept.
    expect(cancelled).toBe(1);
    await expect(engine.stats()).resolves.toMatchObject({
      generationFailures: before.generationFailures,
      generations: before.generations,
    });
  });

  it('makes a view the request’s whose page answers it as not found — a layout’s `notFound()` — for the page to answer each request so, never a 503', async () => {
    silenced();
    const { ask, engine, operate } = await open({
      site: (opened) => {
        const page = pageOf(opened);
        return async (path, headers) => {
          const answer = await page(path, headers);
          const body = await answer.text();
          return body.includes('欠番')
            ? new Response('Not Found', { headers: { 'content-type': 'text/html' }, status: 404 })
            : new Response(body, { headers: answer.headers, status: answer.status });
        };
      },
    });
    await ask('/boards/p1');
    const before = await engine.stats();
    await operate('setTodoTitle', 't1', '欠番');

    await expect(ask('/boards/p1')).resolves.toStrictEqual({ kind: 'pass' });
    await expect(engine.stats()).resolves.toMatchObject({
      generationFailures: before.generationFailures,
    });
  });

  it('makes a view the request’s whose page answers it with a redirect — a layout’s `redirect()` — for the page to answer each request as it does, never a 503', async () => {
    silenced();
    const { ask, engine, operate } = await open({
      site: (opened) => {
        const page = pageOf(opened);
        return async (path, headers) => {
          const answer = await page(path, headers);
          const body = await answer.text();
          return body.includes('移転')
            ? new Response(null, { headers: { location: '/boards/p2' }, status: 307 })
            : new Response(body, { headers: answer.headers, status: answer.status });
        };
      },
    });
    await ask('/boards/p1');
    const before = await engine.stats();
    await operate('setTodoTitle', 't1', '移転');

    await expect(ask('/boards/p1')).resolves.toStrictEqual({ kind: 'pass' });
    await expect(ask('/boards/p1', { rsc: '1' })).resolves.toStrictEqual({ kind: 'pass' });
    await expect(engine.stats()).resolves.toMatchObject({
      generationFailures: before.generationFailures,
    });
  });

  it.each(['answer', 'body'] as const)(
    'gives up a request for an artifact whose page does not finish its %s in time, and asks again',
    async (stall) => {
      silenced();
      const { ask, engine } = await open();
      const page = pageOf(engine);
      const signals: (AbortSignal | undefined)[] = [];
      // The first request taken and never answered, or answered with a body that never ends — and
      // its signal not heeded, as a host's fetch may not; every request after it answered.
      engine.site(async (path, headers, signal) => {
        signals.push(signal);
        if (signals.length > 1) {
          return page(path, headers);
        }
        return stall === 'answer'
          ? Promise.withResolvers<Response>().promise
          : endless(await page(path, headers));
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      // The board evaluated, and its first generation's document asked for.
      await engine.renderShared(null, { build: BUILD, props: { projectId: 'p1' }, route: BOARD });

      await vi.advanceTimersByTimeAsync(ARTIFACT_DEADLINE_MS);

      expect(signals[0]?.aborted).toBe(true);
      await expect.poll(async () => (await engine.stats()).generationFailures).toBe(1);

      await vi.advanceTimersByTimeAsync(RETRY_WAIT_MS);

      await expect.poll(async () => (await engine.stats()).generations).toBe(2);
      expect(shownOf(await ask('/boards/p1'))).toStrictEqual({
        generation: 'g1',
        texts: ['開発', '一覧を作る', '同期を確認する'],
      });
    },
  );

  it('lets go of the request a site never answered once its deadline passes, on the Node authority', async () => {
    silenced();
    // A site that takes each request and never answers it, and counts those let go of.
    let asked = 0;
    let released = 0;
    const site = createServer((_request, response) => {
      asked += 1;
      response.once('close', () => {
        released += 1;
      });
    });
    await new Promise<void>((resolve) => {
      site.listen(0, '127.0.0.1', resolve);
    });
    onTestFinished(() => {
      site.closeAllConnections();
      site.close();
    });
    const authority = await startAuthority({
      ...application,
      programs: [...application.programs, hello],
      routes: [HELLO_ROUTE],
    });
    onTestFinished(authority.close);
    authority.site(`http://127.0.0.1:${String((site.address() as AddressInfo).port)}`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await authority.engine.renderShared(null, {
      build: APP_BUILD,
      props: { id: 'x' },
      route: HELLO,
    });

    await expect.poll(() => asked).toBe(1);

    await vi.advanceTimersByTimeAsync(ARTIFACT_DEADLINE_MS);

    await expect.poll(() => released).toBe(1);
  });

  it('lets go of the request a site never answered as the Node authority closes, with no timer of it left, and of the requests the gate holds', async () => {
    silenced();
    // A site that takes each request and never answers it, and counts those let go of.
    let asked = 0;
    let released = 0;
    const site = createServer((_request, response) => {
      asked += 1;
      response.once('close', () => {
        released += 1;
      });
    });
    await new Promise<void>((resolve) => {
      site.listen(0, '127.0.0.1', resolve);
    });
    onTestFinished(() => {
      site.closeAllConnections();
      site.close();
    });
    const authority = await startAuthority({
      ...application,
      programs: [...application.programs, hello],
      routes: [HELLO_ROUTE],
    });
    onTestFinished(authority.close);
    authority.site(`http://127.0.0.1:${String((site.address() as AddressInfo).port)}`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { engine } = authority;
    await engine.renderShared(null, { build: APP_BUILD, props: { id: 'x' }, route: HELLO });

    await expect.poll(() => asked).toBe(1);

    // A visitor's request the gate holds for the generation being made.
    const held = engine.gate({ headers: {}, method: 'GET', route: HELLO, url: '/hello/x' });

    await expect.poll(async () => (await engine.stats()).gateWaits).toBe(1);

    await authority.close();

    // At once, not at the request's deadline: nothing of the generation outlives the authority.
    expect(vi.getTimerCount()).toBe(0);
    await expect(held).resolves.toMatchObject({ kind: 'respond', status: 503 });
    await expect.poll(() => released).toBe(1);
  });

  it('lets go of the wait before an artifact the site refused is asked for again as the authority closes, and asks nothing more', async () => {
    silenced();
    const { asked, close, engine } = await open({ site: () => refused });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await engine.renderShared(null, { build: BUILD, props: { projectId: 'p1' }, route: BOARD });

    await expect.poll(async () => (await engine.stats()).generationFailures).toBe(1);

    await close();

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(RETRY_WAIT_MS);

    expect(asked).toHaveLength(1);
  });

  it('answers at once a request the gate was asked as the authority closed, waiting for nothing', async () => {
    const { ask, close } = await open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    // Asked before the authority closes, and decided as it does: no view moves from then on.
    const answered = ask('/boards/p1');

    await close();

    expect(vi.getTimerCount()).toBe(0);
    await expect(answered).resolves.toMatchObject({ kind: 'respond', status: 503 });
  });

  it('publishes nothing of a generation an artifact of which was asked for as the authority closed, and leaves its view as it was', async () => {
    silenced();
    const filename = await databaseFile();
    const signals: (AbortSignal | undefined)[] = [];
    // The document answered, and the payload taken and never answered.
    const first = await open({
      filename,
      site: (opened) => {
        const page = pageOf(opened);
        return async (path, headers, signal) => {
          if (headers['rsc'] !== '1') {
            return page(path, headers);
          }
          signals.push(signal);
          return Promise.withResolvers<Response>().promise;
        };
      },
    });
    await first.engine.renderShared(null, {
      build: BUILD,
      props: { projectId: 'p1' },
      route: BOARD,
    });

    await expect.poll(() => signals.length).toBe(1);

    await first.close();

    expect(signals[0]?.aborted).toBe(true);

    // Nothing of the generation kept: the view is made anew, each of its artifacts asked for again.
    const reopened = await open({ filename });

    await expect(reopened.ask('/boards/p1')).resolves.toMatchObject({
      kind: 'respond',
      status: 200,
    });
    expect(reopened.asked).toStrictEqual([
      { path: '/boards/p1', rsc: false },
      { path: '/boards/p1', rsc: true },
    ]);
  });

  it('takes a page’s props of the root, as JSON carries them, as long as a shared render takes them, and refuses any past it — or no JSON object — for the page to render the root as any root', async () => {
    const { engine } = await open();
    // For no session: a session's render signs a subscription that carries the props, which takes
    // far fewer of them, as any root's render does.
    const render = async (props: unknown): Promise<SharedRenderAnswer> =>
      engine.renderShared(null, { build: BUILD, props, route: BOARD });

    await expect(render(noted(MAX_PROPS_LENGTH))).resolves.toMatchObject({
      kind: 'session',
      result: { status: 'rendered' },
    });
    await expect(render(noted(MAX_PROPS_LENGTH + 1))).rejects.toMatchObject({
      code: 'INVALID_ROUTE',
      status: 400,
    });

    for (const props of [['p1'], 'p1', null, { at: new Date(0), projectId: 'p1' }]) {
      await expect(render(props)).rejects.toMatchObject({ code: 'INVALID_ROUTE', status: 400 });
    }

    // An `undefined` among them left out, as JSON leaves it out: the props of the board's view.
    await expect(render({ note: undefined, projectId: 'p1' })).resolves.toMatchObject({
      kind: 'shared',
    });
  });
});
