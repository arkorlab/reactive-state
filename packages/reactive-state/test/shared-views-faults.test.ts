import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import type { SiteFetch } from '../src/authority/shared-generate.ts';
import { SharedStore } from '../src/authority/shared-store.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import {
  type GateAnswer,
  GENERATION_HEADER,
  type MiddlewareProgram,
  type SharedEvent,
} from '../src/routing.ts';
import { BUILD_MISMATCH } from '../src/status.ts';
import { db as appDb } from './support/app/db.ts';
import { application, BUILD as APP_BUILD } from './support/program.ts';
import {
  BOARD,
  bodyOf,
  BUILD,
  follow,
  headerOf,
  holding,
  later,
  open,
  type Opened,
  pageOf,
  quiet,
  shownBy,
  shownOf,
  viewTokenOf,
} from './support/shared-fixture.ts';

/**
 * A shared view where things go wrong around it: an evaluation that reads other rows to show the
 * same, a transaction of rows of two tables, a burst of commits, a withdrawal that outruns a
 * generation being made, a guard that answers in a published view's place, a stream that listens
 * after its view moved, a stream let go of twice, a site that does not answer, an authority closed
 * while a view is dirty, a page that follows a view while it settles again as what it showed, and
 * a request of a route, a root or a build the authority does not serve — against the engine-only
 * application of `support/shared-fixture.ts`, whose site renders each page as its root entry does,
 * and, for the guard, a route of the test application's counter.
 */

/** A build of the application after `BUILD`, over the same database. */
const NEXT_BUILD = 'b_shared_next';
/** Commits of a burst, and waves of commits that each outrun the generation the last one made. */
const BURST = 20;
const WAVES = 4;

/** What p1's board shows, in order, with its first to-do's title `title`. */
function boardWith(title: string): readonly string[] {
  return ['開発', title, '同期を確認する'];
}

/** What a page shows as one key, in an order of its own: whatever order its list is in. */
function keyOf(texts: readonly string[]): string {
  return texts.toSorted((a, b) => a.localeCompare(b)).join('\n');
}

/** What p1's board shows before `rewrite` renamed it `改題` and each of its to-dos, and after. */
const BEFORE = keyOf(boardWith('一覧を作る'));
const AFTER = keyOf(['改題', '改題/t1', '改題/t2', '改題/added']);

/** Whether a page of p1's board shows it before `rewrite`, after it, or anything in between. */
function stateOf(body: string): 'after' | 'before' | 'mixed' {
  const shown = keyOf(shownBy(body).texts);
  if (shown === BEFORE) {
    return 'before';
  }
  return shown === AFTER ? 'after' : 'mixed';
}

/** A counter's page, whose guard answers a redirect in its place while the count is below zero. */
const MOVED = '/moved/[id]';

/** The counter's count, for every visitor. */
const countView: ComponentProgram = {
  buildId: APP_BUILD,
  component: 'components/count-view',
  evaluate: async (props: Readonly<Record<string, unknown>>, $: RenderScope) => {
    const counter = await appDb.counters.get(String(props['id']));
    return $.h('p', null, String(counter?.count ?? 'none'));
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** Below zero, the counter has moved: its guard answers the route with a redirect. */
const moved: MiddlewareProgram = {
  buildId: APP_BUILD,
  guard: async ({ params }) => {
    const counter = await appDb.counters.get(params['id'] ?? '');
    return (counter?.count ?? 0) < 0
      ? { body: '', headers: [['location', '/counters']], status: 307 }
      : undefined;
  },
  id: 'moved',
  protocolVersion: PROTOCOL_VERSION,
};

/**
 * The test application with the counter's page under `moved`, its site rendering the page as its
 * root entry does, and what asks of it: the gate, for the counter `main`; the count, set by Alice.
 */
async function movedCounter(): Promise<{
  readonly engine: Engine;
  readonly ask: (headers?: Readonly<Record<string, string>>) => Promise<GateAnswer>;
  readonly setCount: (count: number) => Promise<void>;
}> {
  const engine = new Engine({
    ...application,
    middleware: { moved },
    operations: {
      ...application.operations,
      'actions/count': {
        async setCount(count: unknown): Promise<void> {
          await appDb.transaction(async () => {
            await appDb.counters.update('main', { count: Number(count) });
          });
        },
      },
    },
    programs: [...application.programs, countView],
    routes: [
      {
        blocking: true,
        guarded: true,
        middleware: ['moved'],
        page: 'moved/[id]/page.tsx',
        params: ['id'],
        props: { id: 'id' },
        root: countView.component,
        route: MOVED,
        shared: true,
      },
    ],
  });
  onTestFinished(async () => {
    await engine.close();
  });
  engine.site(async (_path, headers) => {
    const answer = await engine.renderShared(null, {
      build: APP_BUILD,
      generation: headers[GENERATION_HEADER],
      props: { id: 'main' },
      route: MOVED,
    });
    return Response.json(answer.result.tree, {
      headers: { 'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html' },
    });
  });
  const { sessionId } = await engine.login('alice');
  let made = 0;
  return {
    ask: async (headers = {}) =>
      engine.gate({ headers, method: 'GET', route: MOVED, url: '/moved/main' }),
    engine,
    setCount: async (count) => {
      made += 1;
      await engine.operate(sessionId, {
        args: [{ json: count }],
        build: APP_BUILD,
        module: 'actions/count',
        name: 'setCount',
        operationId: `count-${String(made)}`,
      });
    },
  };
}

/** A page every visitor would be shown alike, whose root faults whatever it reads: a bug of its own. */
const BROKEN = '/broken/[id]';
const brokenRoot: ComponentProgram = {
  buildId: APP_BUILD,
  component: 'components/broken',
  evaluate: () => {
    throw new Error('The root is broken.');
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** The test application with the broken page, and what asks its gate for it. */
function brokenPage(gateWaitMs: number): {
  readonly engine: Engine;
  readonly ask: () => Promise<GateAnswer>;
} {
  const engine = new Engine({
    ...application,
    gateWaitMs,
    programs: [...application.programs, brokenRoot],
    routes: [
      {
        blocking: true,
        middleware: [],
        page: 'broken/[id]/page.tsx',
        params: ['id'],
        props: { id: 'id' },
        root: brokenRoot.component,
        route: BROKEN,
        shared: true,
      },
    ],
  });
  onTestFinished(async () => {
    await engine.close();
  });
  return {
    ask: async () => engine.gate({ headers: {}, method: 'GET', route: BROKEN, url: '/broken/x' }),
    engine,
  };
}

/** A failing site's answer to every request for a page: at once, and never with a page. */
function failedPage(): Promise<Response> {
  return Promise.resolve(new Response('failed', { status: 500 }));
}

/** A site that answers every request for a page as `failedPage` does. */
function failingSite(): SiteFetch {
  return failedPage;
}

/** A file in a directory of the test's own under the system's, removed when the test finishes. */
async function databaseFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-shared-'));
  onTestFinished(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  return path.join(dir, 'authority.sqlite');
}

/** Keeps the authority's log of what failed out of the output, for the rest of the test. */
function silenced(): void {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {
    // What the authority logs of a job it could not finish, kept out of the output.
  });
  onTestFinished(() => {
    logged.mockRestore();
  });
}

/**
 * An authority over a file, whose board a commit made dirty and which was then closed: at once,
 * before the view was evaluated again, or while its next generation was being made — and the
 * authority opened again over the file. The ETag of the artifact the board was shown with before.
 */
async function restarted(
  cut: 'evaluation' | 'generation',
): Promise<{ readonly etag: string; readonly reopened: Opened }> {
  const filename = await databaseFile();
  const held = holding(
    (body, rsc, count) => cut === 'generation' && count === 0 && !rsc && body.endsWith('|g2'),
  );
  const first = await open({ filename, site: held.site });
  const etag = headerOf(await first.ask('/boards/p1'), 'etag') ?? '';
  await first.operate('setTodoTitle', 't1', '再起動の前');
  // Closed at once, with no turn of the timers before: or once the next generation is held.
  await held.until(cut === 'generation' ? 1 : 0);
  await first.close();
  // The closed authority's timers have their turn, and find it closed.
  await later();
  return { etag, reopened: await open({ filename }) };
}

describe('a shared view’s faults', () => {
  it('replaces what a view read when it reads other rows to show the same', async () => {
    const { ask, asked, engine, operate } = await open();
    // The two to-dos the pin may name show alike: moving it changes what the view reads alone.
    await operate('setTodoTitle', 't2', '一覧を作る');
    const shown = bodyOf(await ask('/pinned/main'));
    const made = asked.length;
    const evaluated = (await engine.stats()).sharedEvaluations;

    await operate('pin', 'main', 't2');

    expect(shownBy(shown)).toStrictEqual({ generation: 'g1', texts: ['一覧を作る'] });
    expect(bodyOf(await ask('/pinned/main'))).toBe(shown);
    expect((await engine.stats()).sharedEvaluations).toBe(evaluated + 1);

    // The to-do it no longer reads: nothing is evaluated, nothing moves.
    await operate('setTodoTitle', 't1', '読まれない');

    expect(bodyOf(await ask('/pinned/main'))).toBe(shown);
    expect((await engine.stats()).sharedEvaluations).toBe(evaluated + 1);

    // The to-do it reads now: a generation of its own.
    await operate('setTodoTitle', 't2', '読まれる');

    expect(shownOf(await ask('/pinned/main'))).toStrictEqual({
      generation: 'g2',
      texts: ['読まれる'],
    });
    expect(asked).toHaveLength(made + 2);
  });

  it('publishes a transaction of rows of two tables whole, in one generation', async () => {
    // A site that holds nothing, and keeps each answer its page made.
    const made: string[] = [];
    const recorded = holding((body) => {
      made.push(body);
      return false;
    });
    const { ask, asked, engine, operate } = await open({ site: recorded.site });
    await ask('/boards/p1');
    const heard = await follow(engine, await viewTokenOf(engine, 'p1'));

    // A visitor asks while the transaction runs, between its writes, and another once it committed.
    const rewriting = operate('rewrite', 'p1', '改題');
    const during = ask('/boards/p1');
    await rewriting;
    const after = await ask('/boards/p1');

    expect(['before', 'after']).toContain(stateOf(bodyOf(await during)));
    expect(stateOf(bodyOf(after))).toBe('after');
    expect(heard).toStrictEqual([
      { epoch: 1, generation: 1, kind: 'ready' },
      { epoch: 1, generation: 2, kind: 'ready' },
    ]);
    // Every artifact the site made — documents and the router's payloads — is of before or after.
    expect(made.map((body) => stateOf(body))).toStrictEqual(['before', 'before', 'after', 'after']);
    expect(asked).toHaveLength(4);
  });

  it('coalesces a burst of commits into one evaluation and one generation of the last', async () => {
    const { ask, asked, engine, operate } = await open();
    await ask('/boards/p1');
    const heard = await follow(engine, await viewTokenOf(engine, 'p1'));
    const before = await engine.stats();

    await Promise.all(
      Array.from({ length: BURST }, async (_, index) => {
        await operate('setTodoTitle', 't1', `burst-${String(index)}`);
      }),
    );

    await expect
      .poll(() => heard)
      .toStrictEqual([
        { epoch: 1, generation: 1, kind: 'ready' },
        { epoch: 1, generation: 2, kind: 'ready' },
      ]);

    const after = await engine.stats();

    expect(after.commits - before.commits).toBe(BURST);
    expect(after.sharedEvaluations - before.sharedEvaluations).toBe(1);
    expect(shownOf(await ask('/boards/p1'))).toStrictEqual({
      generation: 'g2',
      texts: boardWith(`burst-${String(BURST - 1)}`),
    });
    // The first generation's two artifacts and the last's: the request rendered nothing.
    expect(asked).toHaveLength(4);
  });

  it('converges, with no request, on the last of commits that each outrun a generation being made', async () => {
    const held = holding((body, rsc) => !rsc && body.endsWith('|g2'));
    const { ask, asked, engine, operate } = await open({ site: held.site });
    await ask('/boards/p1');
    const heard = await follow(engine, await viewTokenOf(engine, 'p1'));

    for (let wave = 0; wave < WAVES; wave += 1) {
      const evaluated = (await engine.stats()).sharedEvaluations;
      await operate('setTodoTitle', 't1', `wave-${String(wave)}`);

      // The view is evaluated again while the last wave's generation is held, and only then is
      // that one let go of: what it made is no longer the view's, and the new candidate waited.
      await expect.poll(async () => (await engine.stats()).sharedEvaluations).toBe(evaluated + 1);

      held.releases[wave - 1]?.();

      await expect.poll(() => held.releases.length).toBe(wave + 1);
    }
    held.releases[WAVES - 1]?.();

    await expect
      .poll(() => heard)
      .toStrictEqual([
        { epoch: 1, generation: 1, kind: 'ready' },
        { epoch: 1, generation: 2, kind: 'ready' },
      ]);
    expect(shownOf(await ask('/boards/p1'))).toStrictEqual({
      generation: 'g2',
      texts: boardWith(`wave-${String(WAVES - 1)}`),
    });
    // The first generation's two artifacts, each wave's document, and the last one's payload.
    expect(asked).toHaveLength(2 + WAVES + 1);
  });

  it.each(['document', 'rsc'] as const)(
    'publishes nothing of a generation a withdrawal outran while its %s was being made',
    async (profile) => {
      const held = holding(
        (body, rsc, count) => count === 0 && rsc === (profile === 'rsc') && body.endsWith('|g2'),
      );
      const { ask, engine, operate } = await open({ site: held.site });
      const etag = headerOf(await ask('/boards/p1'), 'etag') ?? '';
      const heard = await follow(engine, await viewTokenOf(engine, 'p1'));
      await operate('setTodoTitle', 't1', '取り消しの前');

      await expect.poll(() => held.releases.length).toBe(1);

      // Withdrawn while the artifact is held, which the authority has at once, before the view is
      // evaluated again.
      await operate('setPublished', 'p1', false);
      held.releases[0]?.();
      await quiet(engine);

      await expect(ask('/boards/p1')).resolves.toMatchObject({ status: 403 });
      await expect(ask('/boards/p1', { rsc: '1' })).resolves.toMatchObject({ status: 403 });
      await expect(ask('/boards/p1', { 'if-none-match': etag })).resolves.toMatchObject({
        status: 403,
      });
      expect(heard).toStrictEqual([
        { epoch: 1, generation: 1, kind: 'ready' },
        { epoch: 2, kind: 'denied' },
      ]);
    },
  );

  it('ends what pages held of a view once its guard answers in its place, as a withdrawal does', async () => {
    const { ask, engine, setCount } = await movedCounter();
    const etag = headerOf(await ask(), 'etag') ?? '';
    const rendered = await engine.renderShared(null, {
      build: APP_BUILD,
      props: { id: 'main' },
      route: MOVED,
    });
    const token = rendered.kind === 'shared' ? rendered.view.token : '';
    const heard = await follow(engine, token);

    await setCount(-1);

    // The guard's redirect, never the artifact the browser holds; and every page that showed it
    // told so, now or as it follows the view again.
    await expect(ask({ 'if-none-match': etag })).resolves.toMatchObject({ status: 307 });
    expect(heard).toStrictEqual([
      { epoch: 1, generation: 1, kind: 'ready' },
      { epoch: 2, kind: 'denied' },
    ]);
    await expect(follow(engine, token)).resolves.toStrictEqual([{ epoch: 2, kind: 'denied' }]);

    await setCount(1);
    const again = await ask({ 'if-none-match': etag });

    expect(again).toMatchObject({ status: 200 });
    expect(headerOf(again, 'etag')).not.toBe(etag);
    expect(heard).toStrictEqual([
      { epoch: 1, generation: 1, kind: 'ready' },
      { epoch: 2, kind: 'denied' },
      { epoch: 2, generation: 2, kind: 'ready' },
    ]);
  });

  it('tells a stream what its view moved to between its start and its listening', async () => {
    const { ask, engine, operate } = await open();
    await ask('/boards/p1');
    const followed = await engine.followShared(await viewTokenOf(engine, 'p1'));

    // Before the stream listens: a generation published, then the board withdrawn.
    await operate('setTodoTitle', 't1', '聞く前');

    await expect(ask('/boards/p1')).resolves.toMatchObject({ status: 200 });

    await operate('setPublished', 'p1', false);

    await expect(ask('/boards/p1')).resolves.toMatchObject({ status: 403 });

    const heard: SharedEvent[] = [];
    const stop = followed.listen((event) => {
      heard.push(event);
    });
    onTestFinished(stop);
    // And once it listens, what comes next.
    await operate('setPublished', 'p1', true);
    await ask('/boards/p1');

    expect(followed.missed).toStrictEqual([{ epoch: 1, generation: 1, kind: 'ready' }]);
    expect(heard).toStrictEqual([
      { epoch: 1, generation: 2, kind: 'ready' },
      { epoch: 2, kind: 'denied' },
      { epoch: 2, generation: 3, kind: 'ready' },
    ]);
    await expect(engine.stats()).resolves.toMatchObject({ sharedStreams: 1 });

    stop();

    await expect(engine.stats()).resolves.toMatchObject({ sharedStreams: 0 });
  });

  it('tells a page of its view after another page’s stream let go of it once more', async () => {
    const { ask, engine, operate } = await open();
    await ask('/boards/p1');
    const token = await viewTokenOf(engine, 'p1');
    // A page whose stream closed — its request, then its response, each letting go of it — the
    // second time once another page followed the view.
    const left = await engine.followShared(token);
    const stop = left.listen(() => {
      // A page that left hears nothing more.
    });
    stop();
    const heard = await follow(engine, token);
    stop();
    await operate('setPublished', 'p1', false);

    await expect
      .poll(() => heard)
      .toStrictEqual([
        { epoch: 1, generation: 1, kind: 'ready' },
        { epoch: 2, kind: 'denied' },
      ]);
    await expect(engine.stats()).resolves.toMatchObject({ sharedStreams: 1 });
  });

  it('answers 503 at once for a view whose root faults, evaluating it once for each request', async () => {
    silenced();
    const { ask, engine } = brokenPage(2000);

    await expect(ask()).resolves.toMatchObject({ status: 503 });
    await expect(engine.stats()).resolves.toMatchObject({ gateWaits: 1, sharedEvaluations: 1 });

    // A later request evaluates it again, once, and is answered as soon.
    await expect(ask()).resolves.toMatchObject({ status: 503 });
    await expect(engine.stats()).resolves.toMatchObject({ gateWaits: 2, sharedEvaluations: 2 });
  });

  it('revokes a first generation a page was handed before it was published, once it is refused', async () => {
    const held = holding((body, rsc) => !rsc && body.endsWith('|g1'));
    const { engine, operate } = await open({ site: held.site });
    onTestFinished(() => {
      for (const release of held.releases) {
        release();
      }
    });
    // The board's page renders its first generation while its document is being made — as a page
    // a prefetch was let through to does — and follows it.
    const shown = await engine.renderShared(null, {
      build: BUILD,
      props: { projectId: 'p1' },
      route: BOARD,
    });
    await held.until(1);
    const heard = await follow(engine, shown.kind === 'shared' ? shown.view.token : '');
    await operate('setPublished', 'p1', false);

    expect(shown).toMatchObject({ kind: 'shared', view: { epoch: 1, generation: 1 } });
    expect(JSON.stringify(shown.result.tree)).toContain('一覧を作る');
    await expect.poll(() => heard).toStrictEqual([{ epoch: 2, kind: 'denied' }]);
  });

  it('revokes a view kept before the authority started, once it is refused, its page told', async () => {
    const filename = await databaseFile();
    const first = await open({ filename });
    await first.ask('/boards/p1');
    const token = await viewTokenOf(first.engine, 'p1');
    // Withdrawn, and closed at once: the board is evaluated again only once the authority starts.
    await first.operate('setPublished', 'p1', false);
    await first.close();
    const reopened = await open({ filename });
    const heard = await follow(reopened.engine, token);

    await expect.poll(() => heard).toStrictEqual([{ epoch: 2, kind: 'denied' }]);
  });

  it('renders nothing of the views it kept as it starts again, each evaluated as it is asked for', async () => {
    const filename = await databaseFile();
    const first = await open({ filename });
    await first.ask('/boards/p1');
    await first.ask('/pinned/main');
    // What both views read, written, and the authority closed before either was evaluated again.
    await first.operate('setTodoTitle', 't1', '再起動の前');
    await first.close();
    const reopened = await open({ filename });
    await later();

    expect(reopened.asked).toStrictEqual([]);
    await expect(reopened.engine.stats()).resolves.toMatchObject({
      sharedEvaluations: 0,
      sharedViews: 2,
    });

    // Asked for, the board alone is evaluated, and made anew before it is answered.
    const answer = await reopened.ask('/boards/p1');

    expect(shownOf(answer)).toStrictEqual({ generation: 'g2', texts: boardWith('再起動の前') });
    expect(reopened.asked).toStrictEqual([
      { path: '/boards/p1', rsc: false },
      { path: '/boards/p1', rsc: true },
    ]);
    await expect(reopened.engine.stats()).resolves.toMatchObject({ sharedEvaluations: 1 });
  });

  it.each([
    ['other to-dos', '改めた'],
    ['the to-dos it published', '一覧を作る'],
  ])(
    'moves a page handed a candidate a commit outran, to show %s, on to a later generation',
    async (_shows, title) => {
      const held = holding((body, rsc, count) => count === 0 && !rsc && body.endsWith('|g2'));
      onTestFinished(() => {
        for (const release of held.releases) {
          release();
        }
      });
      const { ask, engine, operate } = await open({ site: held.site });
      await ask('/boards/p1');
      // The board's next generation, its document being made, rendered by a page of its own, which
      // follows it: then a commit outruns it.
      await operate('setTodoTitle', 't1', '外された');
      await held.until(1);
      const shown = await engine.renderShared(null, {
        build: BUILD,
        props: { projectId: 'p1' },
        route: BOARD,
      });
      const heard = await follow(engine, shown.kind === 'shared' ? shown.view.token : '');
      await operate('setTodoTitle', 't1', title);
      held.releases[0]?.();

      expect(shown).toMatchObject({ kind: 'shared', view: { epoch: 1, generation: 2 } });
      // A generation past the one the page holds, which it takes for newer — even of what was
      // published before it.
      await expect.poll(() => heard).toStrictEqual([{ epoch: 1, generation: 3, kind: 'ready' }]);
      expect(shownOf(await ask('/boards/p1'))).toStrictEqual({
        generation: 'g3',
        texts: boardWith(title),
      });
    },
  );

  it('numbers what it publishes after a restart past a candidate a page was handed before', async () => {
    const filename = await databaseFile();
    const held = holding((body, rsc, count) => count === 0 && !rsc && body.endsWith('|g2'));
    onTestFinished(() => {
      for (const release of held.releases) {
        release();
      }
    });
    const first = await open({ filename, site: held.site });
    await first.ask('/boards/p1');
    await first.operate('setTodoTitle', 't1', '外された');
    await held.until(1);
    const shown = await first.engine.renderShared(null, {
      build: BUILD,
      props: { projectId: 'p1' },
      route: BOARD,
    });
    // Outrun, and the authority closed before it evaluated the board again.
    await first.operate('setTodoTitle', 't1', '再起動の後');
    await first.close();
    const reopened = await open({ filename });
    const heard = await follow(reopened.engine, shown.kind === 'shared' ? shown.view.token : '');

    await expect.poll(() => heard).toStrictEqual([{ epoch: 1, generation: 3, kind: 'ready' }]);
    expect(shownOf(await reopened.ask('/boards/p1'))).toStrictEqual({
      generation: 'g3',
      texts: boardWith('再起動の後'),
    });
  });

  it('tells a page holding an older generation, once, of the one a restart settles its view as again', async () => {
    const filename = await databaseFile();
    const first = await open({ filename });
    await first.ask('/boards/p1');
    // A page holds the first generation; the second is published while it follows nothing, and the
    // authority closed.
    const token = await viewTokenOf(first.engine, 'p1');
    await first.operate('setTodoTitle', 't1', '再起動の前');

    expect(shownOf(await first.ask('/boards/p1')).generation).toBe('g2');

    await first.close();
    const reopened = await open({ filename });
    const heard = await follow(reopened.engine, token);

    // Kept dirty, evaluated again as the page follows it, it shows what it published: told so.
    await expect.poll(() => heard).toStrictEqual([{ epoch: 1, generation: 2, kind: 'ready' }]);
    expect(shownOf(await reopened.ask('/boards/p1'))).toStrictEqual({
      generation: 'g2',
      texts: boardWith('再起動の前'),
    });

    // A write the board reads and shows nothing of settles it as it was once more: nothing told.
    const { sharedEvaluations } = await reopened.engine.stats();
    await reopened.operate('setNote', 'p1', '見えない');
    await reopened.ask('/boards/p1');
    await quiet(reopened.engine);

    await expect(reopened.engine.stats()).resolves.toMatchObject({
      sharedEvaluations: sharedEvaluations + 1,
    });
    expect(heard).toStrictEqual([{ epoch: 1, generation: 2, kind: 'ready' }]);
  });

  it('tells a page holding the generation a restart settles its view as again nothing', async () => {
    const filename = await databaseFile();
    const first = await open({ filename });
    await first.ask('/boards/p1');
    await first.operate('setTodoTitle', 't1', '再起動の前');
    await first.ask('/boards/p1');
    // The page holds the second generation, the one published last.
    const token = await viewTokenOf(first.engine, 'p1');
    await first.close();
    const reopened = await open({ filename });
    const heard = await follow(reopened.engine, token);

    await expect.poll(async () => (await reopened.engine.stats()).sharedEvaluations).toBe(1);

    await quiet(reopened.engine);

    expect(shownOf(await reopened.ask('/boards/p1')).generation).toBe('g2');
    expect(heard).toStrictEqual([]);
  });

  it('evaluates no view kept before a restart for a commit of nothing it read, and tells its page as it settles again', async () => {
    const filename = await databaseFile();
    const first = await open({ filename });
    await first.ask('/boards/p1');
    const token = await viewTokenOf(first.engine, 'p1');
    await first.operate('setTodoTitle', 't1', '再起動の前');
    await first.ask('/boards/p1');
    await first.close();
    const reopened = await open({ filename });
    // Another project's commit: nothing the board read.
    await reopened.operate('setNote', 'p2', '別の');
    await quiet(reopened.engine);

    await expect(reopened.engine.stats()).resolves.toMatchObject({ sharedEvaluations: 0 });

    const heard = await follow(reopened.engine, token);

    await expect.poll(() => heard).toStrictEqual([{ epoch: 1, generation: 2, kind: 'ready' }]);
  });

  it('tells a page that follows a view as it settles again of the generation it shows, where it holds an older one', async () => {
    const { ask, engine, operate } = await open();
    await ask('/boards/p1');
    // A page holds the first generation, and follows the view once the second is published: told
    // of it as its stream starts.
    const older = await viewTokenOf(engine, 'p1');
    await operate('setTodoTitle', 't1', '一覧を直す');
    await ask('/boards/p1');
    const told = await follow(engine, older);
    // A write the board reads and shows nothing of has it evaluated again, and another page that
    // holds the first generation follows it meanwhile: told nothing as its stream starts.
    await operate('setNote', 'p1', '見えない');
    const heard = await follow(engine, older);

    expect(heard).toStrictEqual([]);
    await expect.poll(() => heard).toStrictEqual([{ epoch: 1, generation: 2, kind: 'ready' }]);

    await quiet(engine);

    // The page told as its stream started is told nothing more as the view settles again.
    expect(told).toStrictEqual([{ epoch: 1, generation: 2, kind: 'ready' }]);
  });

  it('answers 503 at once for a view whose artifacts the store fails to keep, making them once for each request', async () => {
    silenced();
    const { ask, asked } = await open({ gateWaitMs: 2000 });
    const kept = vi.spyOn(SharedStore.prototype, 'putArtifact').mockImplementation(() => {
      throw new Error('The disk is full.');
    });
    onTestFinished(() => {
      kept.mockRestore();
    });

    await expect(ask('/boards/p1')).resolves.toMatchObject({ status: 503 });
    expect(asked).toHaveLength(2);

    // The store keeps them again: a later request makes them, and is answered with them.
    kept.mockRestore();

    expect(shownOf(await ask('/boards/p1'))).toStrictEqual({
      generation: 'g1',
      texts: boardWith('一覧を作る'),
    });
    expect(asked).toHaveLength(4);
  });

  it('answers 503 once a generation its site answers no artifact of is given up, asking no more for the request', async () => {
    silenced();
    const { ask, asked, engine } = await open({ gateWaitMs: 5000, site: failingSite });

    await expect(ask('/boards/p1')).resolves.toMatchObject({ status: 503 });
    // Its document asked for as many times as a generation is, and no more.
    expect(asked).toHaveLength(3);
    await expect(engine.stats()).resolves.toMatchObject({ gateWaits: 2, generationFailures: 3 });

    // A later request asks again, as many times.
    await expect(ask('/boards/p1')).resolves.toMatchObject({ status: 503 });
    expect(asked).toHaveLength(6);
  });

  it('answers 503 for every request of a view whose site is down, until it answers again', async () => {
    const { ask, engine, operate } = await open({ gateWaitMs: 50 });
    const etag = headerOf(await ask('/boards/p1'), 'etag') ?? '';
    engine.site(undefined);
    await operate('setTodoTitle', 't1', '配れない');

    await expect(ask('/boards/p1', { rsc: '1' })).resolves.toMatchObject({ status: 503 });
    // Never the earlier artifact, nor a 304 that would have the browser show it again.
    await expect(ask('/boards/p1', { 'if-none-match': etag })).resolves.toMatchObject({
      status: 503,
    });
    await expect(
      engine.gate({ headers: {}, method: 'HEAD', route: BOARD, url: '/boards/p1' }),
    ).resolves.toMatchObject({ body: null, status: 503 });

    engine.site(pageOf(engine));

    await expect
      .poll(async () => shownOf(await ask('/boards/p1')))
      .toStrictEqual({ generation: 'g2', texts: boardWith('配れない') });

    // A withdrawal needs no artifact: refused at once, with the site down again.
    engine.site(undefined);
    await operate('setPublished', 'p1', false);

    await expect(ask('/boards/p1', { 'if-none-match': etag })).resolves.toMatchObject({
      status: 403,
    });
  });

  it.each(['evaluation', 'generation'] as const)(
    'serves after a restart none of the artifacts a commit before it outdated, cut short at its %s',
    async (cut) => {
      silenced();
      const { etag, reopened } = await restarted(cut);
      const answer = await reopened.ask('/boards/p1', { 'if-none-match': etag });

      expect(answer).toMatchObject({ status: 200 });
      // What the commit wrote, not the seed's, in the generation after the one published before.
      expect(shownOf(answer)).toStrictEqual({
        generation: 'g2',
        texts: boardWith('再起動の前'),
      });
      expect(headerOf(answer, 'etag')).not.toBe(etag);
      expect(reopened.asked).toHaveLength(2);
    },
  );

  it('refuses to render as shared a route the registry does not know, or a root no route has', async () => {
    const { asked, engine } = await open();
    const render = async (route: string): Promise<unknown> =>
      engine.renderShared(null, { build: BUILD, props: { projectId: 'p1' }, route });
    const gate = async (route: string, url: string): Promise<unknown> =>
      engine.gate({ headers: {}, method: 'GET', route, url });
    const unknown = { code: 'UNKNOWN_ROUTE', status: 404 };

    await expect(render('/elsewhere/[projectId]')).rejects.toMatchObject(unknown);
    await expect(render('components/board-todos')).rejects.toMatchObject(unknown);
    await expect(gate('/elsewhere/[projectId]', '/elsewhere/p1')).resolves.toStrictEqual({
      kind: 'pass',
    });
    await expect(gate('components/board-todos', '/boards/p1')).resolves.toStrictEqual({
      kind: 'pass',
    });
    await expect(gate(BOARD, '/elsewhere/p1')).resolves.toStrictEqual({ kind: 'pass' });
    // The board's to-dos, rendered as any page renders a root: for a session alone.
    await expect(
      engine.render(null, {
        build: BUILD,
        component: 'components/board-todos',
        props: { projectId: 'p1' },
      }),
    ).resolves.toMatchObject({ status: 'unauthenticated', tree: null });
    await expect(engine.stats()).resolves.toMatchObject({ sharedEvaluations: 0, sharedViews: 0 });
    expect(asked).toHaveLength(0);
  });

  it('refuses another build’s page, and starts the new build’s view at a generation of its own', async () => {
    const filename = await databaseFile();
    const before = await open({ filename });
    await before.ask('/boards/p1');
    await before.operate('setTodoTitle', 't1', '前のビルド');
    const etag = headerOf(await before.ask('/boards/p1'), 'etag') ?? '';
    const token = await viewTokenOf(before.engine, 'p1');
    await before.close();

    const after = await open({ build: NEXT_BUILD, filename });
    const mismatch = { code: BUILD_MISMATCH, status: 409 };

    await expect(after.engine.followShared(token)).rejects.toMatchObject(mismatch);
    await expect(
      after.engine.renderShared(null, { build: BUILD, props: { projectId: 'p1' }, route: BOARD }),
    ).rejects.toMatchObject(mismatch);

    const answer = await after.ask('/boards/p1', { 'if-none-match': etag });

    expect(answer).toMatchObject({ status: 200 });
    // The database's state, rendered anew by the new build's page as its own first generation.
    expect(shownOf(answer)).toStrictEqual({
      generation: 'g1',
      texts: boardWith('前のビルド'),
    });
    expect(after.asked).toHaveLength(2);
  });
});
