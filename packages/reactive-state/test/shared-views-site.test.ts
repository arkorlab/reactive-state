import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import type { SiteFetch } from '../src/authority/shared-generate.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import { GENERATION_HEADER, type GateAnswer, type SiteShape } from '../src/routing.ts';
import { sitePathOf } from '../src/site-paths.ts';
import { nextPageParam } from './support/next-page.ts';
import { application, BUILD as APP_BUILD } from './support/program.ts';
import { BOARD, BUILD, open, shownOf } from './support/shared-fixture.ts';

/**
 * A shared view of a site whose routes Next.js serves under a base path (`basePath`), or at paths
 * that end with a slash (`trailingSlash`): the authority asks for a view's page where the site
 * serves it, once whoever knows said where that is — the application's server with a gate's
 * question, from the first request on, or a page's render — kept for the build, across a restart;
 * and its gate reads a request's path as Next.js does, a base path or a route's folder a URL encodes
 * among them, letting through any it cannot, as it lets through every request before it knows.
 * Against the engine-only application of `support/shared-fixture.ts`, its board's page served by a
 * site of each shape; and, for a route a URL encodes, or one of a param no identifier names, the
 * test application with a route of its own.
 */

/** What p1's board shows, in order. */
const BOARD_P1: readonly string[] = ['開発', '一覧を作る', '同期を確認する'];

/** A route whose folder a URL encodes, every visitor shown the same of it. */
const CAFE = '/café/[id]';
/** A route whose param Next.js names by what no identifier is, every visitor shown the same of it. */
const PROJECT = '/boards/[$project]';
/**
 * A route of a param named as what sets an object's prototype where it is assigned, every visitor
 * shown the same of it: one no compile registers, as Next.js hands a page no such param.
 */
const PINS = '/pins/[__proto__]';
const menu: ComponentProgram = {
  buildId: APP_BUILD,
  component: 'components/menu',
  evaluate: (_props: Readonly<Record<string, unknown>>, $: RenderScope) => $.h('p', null, 'menu'),
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/**
 * The test application with `route`, of the one `param` the menu is given as its `id`; its site
 * rendering the route's page of the param its path ends with — a slash after it or not — each path
 * it is asked for in `asked`.
 */
function menuSite(
  route: string,
  param: string,
): { readonly engine: Engine; readonly asked: readonly string[] } {
  const engine = new Engine({
    ...application,
    programs: [...application.programs, menu],
    routes: [
      {
        blocking: true,
        middleware: [],
        page: `${route.slice(1)}/page.tsx`,
        params: [param],
        props: { id: param },
        root: menu.component,
        route,
        shared: true,
      },
    ],
  });
  onTestFinished(async () => {
    await engine.close();
  });
  const asked: string[] = [];
  engine.site(async (page, headers) => {
    asked.push(page);
    const answer = await engine.renderShared(null, {
      build: APP_BUILD,
      generation: headers[GENERATION_HEADER],
      props: { id: nextPageParam(page.split('/').findLast((segment) => segment !== '') ?? '') },
      route,
    });
    return Response.json(answer.result.tree, {
      headers: { 'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html' },
    });
  });
  return { asked, engine };
}

/**
 * The board's page as a site of `shape` serves it, rendering its root as its root entry does with
 * the shape Next.js compiled into it; any other form of a path redirected, as Next.js redirects one.
 */
function shapedSite(engine: Engine, shape: SiteShape): SiteFetch {
  const prefix = `${shape.basePath}/boards/`;
  return async (page, headers) => {
    if (!page.startsWith(prefix) || page.endsWith('/') !== shape.trailingSlash) {
      return new Response(null, { headers: { location: '/' }, status: 308 });
    }
    const projectId = page.slice(prefix.length).replace(/\/$/u, '');
    const answer = await engine.renderShared(null, {
      build: BUILD,
      generation: headers[GENERATION_HEADER],
      props: { projectId: nextPageParam(projectId) },
      route: BOARD,
      site: shape,
    });
    const shown = answer.kind === 'shared' ? `g${String(answer.view.generation)}` : 'session';
    return new Response(`${JSON.stringify(answer.result.tree)}|${shown}`, {
      headers: {
        'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html; charset=utf-8',
      },
    });
  };
}

/** Two deployments of the site at once, each serving its routes as its own shape says. */
const DEPLOYED: Readonly<Record<string, SiteShape>> = {
  dpl_a: { basePath: '/a', trailingSlash: false },
  dpl_b: { basePath: '/b', trailingSlash: true },
};

/**
 * A site serving each deployment of `DEPLOYED` at once, as `shapedSite` serves one: a path under a
 * deployment's base path is that deployment's page, whose every answer names it.
 */
function deployedSite(engine: Engine): SiteFetch {
  const served = Object.entries(DEPLOYED).map(([deployment, shape]) => {
    const render = shapedSite(engine, shape);
    return { deployment, render, shape };
  });
  return async (page, headers, signal) => {
    const serving = served.find(({ shape }) => page.startsWith(`${shape.basePath}/`));
    if (serving === undefined) {
      return new Response(null, { status: 404 });
    }
    const answer = await serving.render(page, headers, signal);
    const named = new Headers(answer.headers);
    named.set('x-nextjs-deployment-id', serving.deployment);
    return new Response(answer.body, { headers: named, status: answer.status });
  };
}

/** The gate's answer to a request of the board at `url`. */
async function gate(engine: Engine, url: string): Promise<GateAnswer> {
  return engine.gate({ headers: {}, method: 'GET', route: BOARD, url });
}

/** p1's board rendered by the page of a site of `shape`, which says where the site serves it. */
async function rendered(engine: Engine, shape: SiteShape): Promise<void> {
  await engine.renderShared(null, {
    build: BUILD,
    props: { projectId: 'p1' },
    route: BOARD,
    site: shape,
  });
}

/** A file in a directory of the test's own under the system's, removed when the test finishes. */
async function databaseFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-site-'));
  onTestFinished(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  return path.join(dir, 'authority.sqlite');
}

describe('a shared view of a site with a base path or trailing slashes', () => {
  it.each([
    [{ basePath: '/docs', trailingSlash: false }, '/docs/boards/p1', '/docs/boards/p1/'],
    [{ basePath: '', trailingSlash: true }, '/boards/p1/', '/boards/p1'],
    [{ basePath: '/docs', trailingSlash: true }, '/docs/boards/p1/', '/boards/p1/'],
  ])(
    'asks a site of %o for its page at %s, and answers a request of it there alone',
    async (shape, served, other) => {
      const { asked, engine } = await open({ site: (opened) => shapedSite(opened, shape) });

      // Before a page said where the site serves its routes: let through, for the page to render.
      await expect(gate(engine, served)).resolves.toStrictEqual({ kind: 'pass' });

      await rendered(engine, shape);
      const answer = await gate(engine, served);

      expect(shownOf(answer)).toStrictEqual({ generation: 'g1', texts: BOARD_P1 });
      expect(asked).toStrictEqual([
        { path: served, rsc: false },
        { path: served, rsc: true },
      ]);
      // Any other form of its path is the site's to redirect, or to serve as no route's page.
      await expect(gate(engine, other)).resolves.toStrictEqual({ kind: 'pass' });
    },
  );

  it.each([
    [{ basePath: '/docs', trailingSlash: true }, '/docs/boards/p1/'],
    [
      { basePath: '/ドキュメント', trailingSlash: false },
      `/${encodeURIComponent('ドキュメント')}/boards/p1`,
    ],
  ])(
    'answers the first request of a site of %o at %s from the view, its question saying where the site serves its routes',
    async (shape, served) => {
      const { asked, engine } = await open({ site: (opened) => shapedSite(opened, shape) });
      // The application's server, as it asks the gate of a request: before any page rendered.
      const answer = await engine.gate({
        headers: {},
        method: 'GET',
        route: BOARD,
        site: shape,
        url: served,
      });

      expect(shownOf(answer)).toStrictEqual({ generation: 'g1', texts: BOARD_P1 });
      expect(asked.map((page) => page.path)).toStrictEqual([
        `${shape.basePath}/boards/p1${shape.trailingSlash ? '/' : ''}`,
        `${shape.basePath}/boards/p1${shape.trailingSlash ? '/' : ''}`,
      ]);
      // Kept for the build: a question that says nothing of it is read so too.
      await expect(gate(engine, served)).resolves.toMatchObject({ status: 200 });
    },
  );

  it('asks a site that keeps its pages behind a slash for a page at the form of its path Next.js serves — none after a param that names a file, or holds a dot of no file’s — and answers a request of it there alone: the other form of one Next.js serves either way is its page’s to render as it is spelled', async () => {
    const { asked, engine } = menuSite('/files/[name]', 'name');
    const site = { basePath: '', trailingSlash: true };
    const kindOf = async (url: string): Promise<string> => {
      const answer = await engine.gate({
        headers: {},
        method: 'GET',
        route: '/files/[name]',
        site,
        url,
      });
      return answer.kind;
    };
    const answered: [string, string][] = [];
    for (const url of [
      '/files/a.txt',
      '/files/abc/',
      '/files/v1.2-beta',
      '/files/v1.2-beta/',
      '/files/a.txt/',
      '/files/abc',
    ]) {
      answered.push([url, await kindOf(url)]);
    }

    expect(answered).toStrictEqual([
      ['/files/a.txt', 'respond'],
      ['/files/abc/', 'respond'],
      ['/files/v1.2-beta', 'respond'],
      ['/files/v1.2-beta/', 'pass'],
      ['/files/a.txt/', 'pass'],
      ['/files/abc', 'pass'],
    ]);
    expect(asked).toStrictEqual(
      ['/files/a.txt', '/files/abc/', '/files/v1.2-beta'].flatMap((page) => [page, page]),
    );
  });

  it('answers a request of a route whose folder a URL encodes, and lets one malformed through', async () => {
    const { engine } = menuSite(CAFE, 'id');
    const asking = (url: string): Promise<GateAnswer> =>
      engine.gate({ headers: {}, method: 'GET', route: CAFE, url });

    await expect(asking('/caf%C3%A9/x')).resolves.toMatchObject({ kind: 'respond', status: 200 });
    await expect(asking('/caf%E9/x')).resolves.toStrictEqual({ kind: 'pass' });
  });

  it('answers a request of a route whose param Next.js names by what no identifier is, its page asked for by the param', async () => {
    const { asked, engine } = menuSite(PROJECT, '$project');
    const answer = await engine.gate({
      headers: {},
      method: 'GET',
      route: PROJECT,
      url: '/boards/a%20b',
    });

    expect(answer).toMatchObject({ kind: 'respond', status: 200 });
    expect(asked).toStrictEqual(['/boards/a%20b', '/boards/a%20b']);
  });

  it('answers a param as a URL spells it from the view of the param Next.js hands the page, the page asked for at that param as it is, a slash in it one segment — and lets another escape of it through, for its page to render as it is spelled', async () => {
    const { asked, engine } = menuSite(PROJECT, '$project');
    const asking = (url: string): Promise<GateAnswer> =>
      engine.gate({ headers: {}, method: 'GET', route: PROJECT, url });

    for (const url of ['/boards/a%2Fb', '/boards/caf%C3%A9', '/boards/café']) {
      await expect(asking(url)).resolves.toMatchObject({ kind: 'respond', status: 200 });
    }

    await expect(asking('/boards/caf%c3%a9')).resolves.toStrictEqual({ kind: 'pass' });

    // A view of each param the page is handed, its page asked for once — each profile — at it.
    expect(asked).toStrictEqual([
      '/boards/a%2Fb',
      '/boards/a%2Fb',
      '/boards/caf%C3%A9',
      '/boards/caf%C3%A9',
    ]);
    // The page's own render of that param is the gate's view, published: none made beside it.
    await expect(
      engine.renderShared(null, { build: APP_BUILD, props: { id: 'caf%C3%A9' }, route: PROJECT }),
    ).resolves.toMatchObject({ kind: 'shared', view: { generation: 1 } });
    expect(asked).toHaveLength(4);
  });

  it('makes no view of a param no page is handed — `..` or `.`, however a path encodes it, which Next.js resolves as another path — the gate letting each through, and asks for no page of one', async () => {
    const { asked, engine } = menuSite(PROJECT, '$project');

    for (const url of [
      '/boards/..',
      '/boards/%2E%2E',
      '/boards/.%2e',
      '/boards/.',
      '/boards/%2E',
    ]) {
      await expect(
        engine.gate({ headers: {}, method: 'GET', route: PROJECT, url }),
      ).resolves.toStrictEqual({ kind: 'pass' });
    }
    // A render of one, which no page of the route's makes — another page's — is of no view: its
    // root rendered for the request as any root is, and its page — the path above the route's, as a
    // URL takes `/boards/..` — never asked for.
    for (const id of ['..', '%2E%2E', '.', '']) {
      await expect(
        engine.renderShared(null, { build: APP_BUILD, props: { id }, route: PROJECT }),
      ).resolves.toMatchObject({ kind: 'session', result: { status: 'rendered' } });
    }

    await expect(engine.stats()).resolves.toMatchObject({ sharedEvaluations: 0, sharedViews: 0 });
    expect(asked).toStrictEqual([]);
  });

  it('asks for the page of a route whose folder holds a `#` at the path that names it, never at the path a `#` would cut it to', async () => {
    const route = '/r/foo#bar/[id]';
    const { asked, engine } = menuSite(route, 'id');

    await expect(
      engine.gate({ headers: {}, method: 'GET', route, url: '/r/foo%23bar/x' }),
    ).resolves.toMatchObject({ kind: 'respond', status: 200 });
    expect(asked).toStrictEqual(['/r/foo%23bar/x', '/r/foo%23bar/x']);
  });

  it('answers each path of a route of a param named `__proto__` from a view of its own, rendered of the param', async () => {
    const { asked, engine } = menuSite(PINS, '__proto__');
    const asking = (url: string): Promise<GateAnswer> =>
      engine.gate({ headers: {}, method: 'GET', route: PINS, url });

    await expect(asking('/pins/a')).resolves.toMatchObject({ kind: 'respond', status: 200 });
    await expect(asking('/pins/b')).resolves.toMatchObject({ kind: 'respond', status: 200 });
    // Each path its own view, its page asked for by its param; and a page's render of it is the view.
    expect(asked).toStrictEqual(['/pins/a', '/pins/a', '/pins/b', '/pins/b']);
    await expect(
      engine.renderShared(null, { build: APP_BUILD, props: { id: 'a' }, route: PINS }),
    ).resolves.toMatchObject({ kind: 'shared', view: { generation: 1 } });
  });

  it('reads each question by the site it says, whatever another deployment’s said meanwhile, and makes each view’s artifacts where its own question’s site serves the page', async () => {
    const { asked, engine, operate } = await open({ site: deployedSite });
    await operate('setPublished', 'p2', true);
    const asking = async (deployment: string, projectId: string): Promise<GateAnswer> => {
      const site = DEPLOYED[deployment] ?? { basePath: '', trailingSlash: false };
      return engine.gate({
        deployment,
        headers: {},
        method: 'GET',
        route: BOARD,
        site,
        url: sitePathOf(site, `/boards/${projectId}`),
      });
    };

    // Two deployments' questions at once, each of a base path of its own: both heard before
    // either is read.
    const [a, b] = await Promise.all([asking('dpl_a', 'p1'), asking('dpl_b', 'p2')]);

    expect([a, b]).toMatchObject([
      { kind: 'respond', status: 200 },
      { kind: 'respond', status: 200 },
    ]);
    expect(asked).toHaveLength(4);
    expect(asked).toStrictEqual(
      expect.arrayContaining([
        { path: '/a/boards/p1', rsc: false },
        { path: '/a/boards/p1', rsc: true },
        { path: '/b/boards/p2/', rsc: false },
        { path: '/b/boards/p2/', rsc: true },
      ]),
    );

    // A commit p1's board shows: made again behind it where dpl_a's site serves it, whatever the
    // page of dpl_b's said since.
    await operate('setTodoTitle', 't1', 'again');

    await expect.poll(() => asked.length).toBe(6);
    expect(asked.slice(4)).toStrictEqual([
      { path: '/a/boards/p1', rsc: false },
      { path: '/a/boards/p1', rsc: true },
    ]);

    // The edge's question of dpl_a, which says nothing of its site, once dpl_b's said its own last:
    // read as dpl_a's questions said.
    await asking('dpl_b', 'p2');

    await expect(
      engine.gate({
        deployment: 'dpl_a',
        headers: {},
        method: 'GET',
        route: BOARD,
        url: '/a/boards/p1',
      }),
    ).resolves.toMatchObject({ kind: 'respond', status: 200 });
  });

  it('answers a request of a site that makes no trailing-slash redirect at the form its artifacts are made of, and lets the other form through for its page to render as it is spelled, from the moment it starts again too', async () => {
    const shape: SiteShape = { basePath: '', skipTrailingSlashRedirect: true, trailingSlash: true };
    const filename = await databaseFile();
    const first = await open({ filename, site: (opened) => shapedSite(opened, shape) });
    await rendered(first.engine, shape);

    await expect(gate(first.engine, '/boards/p1/')).resolves.toMatchObject({ status: 200 });
    // What reads the path renders of it as it is spelled: no artifact of another spelling's.
    await expect(gate(first.engine, '/boards/p1')).resolves.toStrictEqual({ kind: 'pass' });

    await first.close();
    const reopened = await open({ filename, site: (opened) => shapedSite(opened, shape) });

    await expect(gate(reopened.engine, '/boards/p1/')).resolves.toMatchObject({ status: 200 });
    await expect(gate(reopened.engine, '/boards/p1')).resolves.toStrictEqual({ kind: 'pass' });
    expect(reopened.asked).toStrictEqual([]);
  });

  it('lets a request through of an escape the artifact is not spelled in, for its page to render as it is spelled', async () => {
    const shape: SiteShape = { basePath: '', trailingSlash: false };
    const { engine } = await open({ site: (opened) => shapedSite(opened, shape) });
    await rendered(engine, shape);

    await expect(gate(engine, '/boards/p1')).resolves.toMatchObject({ status: 200 });
    await expect(gate(engine, '/boards/%70%31')).resolves.toStrictEqual({ kind: 'pass' });
  });

  it('reads a request where its site serves it from the moment it starts again', async () => {
    const shape: SiteShape = { basePath: '/docs', trailingSlash: true };
    const filename = await databaseFile();
    const first = await open({ filename, site: (opened) => shapedSite(opened, shape) });
    await rendered(first.engine, shape);

    await expect(gate(first.engine, '/docs/boards/p1/')).resolves.toMatchObject({ status: 200 });

    await first.close();
    const reopened = await open({ filename, site: (opened) => shapedSite(opened, shape) });
    // No page rendered since it started: the board answered from what it kept all the same.
    const answer = await gate(reopened.engine, '/docs/boards/p1/');

    expect(shownOf(answer)).toStrictEqual({ generation: 'g1', texts: BOARD_P1 });
    expect(reopened.asked).toStrictEqual([]);
  });
});
