import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { guardsOf } from '../src/authority/guards.ts';
import type { Core } from '../src/authority/model.ts';
import { registryOf } from '../src/authority/programs.ts';
import {
  paramsOfPath,
  paramsOfProps,
  routeRegistryOf,
  viewParamsOf,
} from '../src/authority/route-registry.ts';
import { pathOf } from '../src/authority/shared-generate.ts';
import { scanApp } from '../src/compiler/route-scan.ts';
import { PROTOCOL_VERSION } from '../src/program.ts';
import type {
  MiddlewareProgram,
  PlainRouteRegistration,
  RegisteredRoute,
  RouteRegistration,
} from '../src/routing.ts';

/**
 * The routes an authority is given, checked against the programs it runs before anything is
 * served: a route it could not serve as the compile registered it is refused, the application's
 * fault. A route's dynamic segments are read as the compile read them, by any name Next.js gives a
 * param.
 */

const BUILD = 'b_routes';

/** The roots the authority runs: a route renders one of them, and a root is one route's. */
const registry = registryOf({
  buildId: BUILD,
  programs: ['components/board', 'components/doc', 'components/project'].map((component) => {
    return {
      buildId: BUILD,
      component,
      evaluate: () => null,
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
  }),
});

/** A board of a team's whose page gives its root the project alone, the request's. */
const TEAM_BOARD: RouteRegistration = {
  blocking: true,
  middleware: [],
  page: 'teams/[team]/boards/[projectId]/page.tsx',
  params: ['team', 'projectId'],
  props: { projectId: 'projectId' },
  root: 'components/board',
  route: '/teams/[team]/boards/[projectId]',
  shared: false,
};

/** An app directory of a page in each of `directories`, removed when the test finishes. */
async function appOf(directories: readonly string[]): Promise<string> {
  const appDir = await mkdtemp(path.join(tmpdir(), 'reactive-state-routes-'));
  onTestFinished(async () => {
    await rm(appDir, { force: true, recursive: true });
  });
  for (const directory of directories) {
    await mkdir(path.join(appDir, directory), { recursive: true });
    await writeFile(
      path.join(appDir, directory, 'page.tsx'),
      'export default function Page() {}\n',
    );
  }
  return appDir;
}

/** A page of no reactive root under an account's middleware, whose guard the authority runs. */
const ACCOUNT: PlainRouteRegistration = {
  file: 'account/[tab]/page.tsx',
  guarded: true,
  middleware: ['', 'account'],
  params: ['tab'],
  plain: 'page',
  route: '/account/[tab]',
};

/** The account's middleware's guard. */
const ACCOUNT_GUARD: MiddlewareProgram = {
  buildId: BUILD,
  guard: () => Promise.resolve(),
  id: 'account',
  protocolVersion: PROTOCOL_VERSION,
};

/** Why the authority refuses `route`, the account's guard given it, or `taken` where it takes it. */
function verdictOf(route: RegisteredRoute): string {
  try {
    routeRegistryOf(
      { middleware: { '': null, account: ACCOUNT_GUARD }, routes: [route] },
      registry,
    );
  } catch (error) {
    return (error as Error).message.replace(/^The route "[^"]+" /u, '');
  }
  return 'taken';
}

describe('the routes an authority is given', () => {
  it('takes a route of no reactive root under middleware apart from the routes of a root, and refuses one it could not guard as it says', () => {
    const middleware = { '': null, account: ACCOUNT_GUARD };
    const { plain, routes } = routeRegistryOf(
      { middleware, routes: [ACCOUNT, TEAM_BOARD] },
      registry,
    );
    const refusalOf = (
      route: RegisteredRoute,
      given: Readonly<Record<string, MiddlewareProgram | null>> = middleware,
    ): string => {
      try {
        routeRegistryOf({ middleware: given, routes: [route, TEAM_BOARD] }, registry);
      } catch (error) {
        return (error as Error).message;
      }
      return 'taken';
    };

    expect([...plain.values()]).toStrictEqual([ACCOUNT]);
    expect([...routes.keys()]).toStrictEqual([TEAM_BOARD.route]);
    expect(
      [
        refusalOf({ ...ACCOUNT, params: [] }),
        refusalOf({ ...ACCOUNT, params: ['rest'], route: '/account/[...rest]' }),
        refusalOf({ ...ACCOUNT, middleware: [] }),
        refusalOf(ACCOUNT, { '': null, account: null }),
        refusalOf(ACCOUNT, { account: ACCOUNT_GUARD }),
        refusalOf({ ...ACCOUNT, guarded: undefined } as unknown as RegisteredRoute),
        refusalOf({ ...ACCOUNT, root: 'components/board' }),
        refusalOf({ ...ACCOUNT, route: TEAM_BOARD.route, params: ['team', 'projectId'] }),
      ].map((message) => message.replace(/^The route "[^"]+" /u, '')),
    ).toStrictEqual([
      "names other params than its path's.",
      'has a catch-all, which the compile registers no route of.',
      'is under no route middleware, which a route of no reactive root is registered under.',
      'says it has a guard, where none of its middleware has one the authority runs.',
      'is under the middleware "", of which the authority was given neither a guard nor that it has none.',
      'says it has no guard, where a guard of its middleware is the authority’s.',
      'is of no reactive root, and names one.',
      'is registered twice: a route is one page.',
    ]);
  });

  it('refuses a route of a reactive root whose guards are not as it says, or under middleware the authority was told nothing of, as one of none', () => {
    const refusalOf = (
      route: RouteRegistration,
      middleware: Readonly<Record<string, MiddlewareProgram | null>>,
    ): string => {
      try {
        routeRegistryOf({ middleware, routes: [route] }, registry);
      } catch (error) {
        return (error as Error).message.replace(/^The route "[^"]+" /u, '');
      }
      return 'taken';
    };
    const guarded: RouteRegistration = {
      ...TEAM_BOARD,
      guarded: true,
      middleware: ['', 'account'],
    };

    expect([
      // Its guard's program left out, or the middleware not named at all: served with no guard.
      refusalOf(guarded, { '': null, account: null }),
      refusalOf(guarded, { '': null }),
      // A guard it says it has not, which no request of it would ever be asked of.
      refusalOf({ ...guarded, guarded: undefined } as unknown as RouteRegistration, {
        '': null,
        account: ACCOUNT_GUARD,
      }),
      refusalOf(guarded, { '': null, account: ACCOUNT_GUARD }),
    ]).toStrictEqual([
      'says it has a guard, where none of its middleware has one the authority runs.',
      'is under the middleware "account", of which the authority was given neither a guard nor that it has none.',
      'says it has no guard, where a guard of its middleware is the authority’s.',
      'taken',
    ]);
  });

  it('runs no guard of a chain as passed over that names middleware the authority was not told of: a fault, never a pass', () => {
    const core = {
      routes: routeRegistryOf({ middleware: { '': null, account: ACCOUNT_GUARD } }, registry),
    } as unknown as Core;

    expect(guardsOf(core, ['', 'account'])).toStrictEqual([ACCOUNT_GUARD]);
    expect(() => guardsOf(core, ['', 'teams'])).toThrow(
      'The middleware "teams" is none the authority was given, neither its guard nor that it has none.',
    );
  });

  it('refuses a route of a reactive root registered twice, as it refuses one of none', () => {
    expect(() => {
      return routeRegistryOf(
        { routes: [TEAM_BOARD, { ...TEAM_BOARD, blocking: false }] },
        registry,
      );
    }).toThrow(
      'The route "/teams/[team]/boards/[projectId]" is registered twice: a route is one page.',
    );
  });

  it('refuses a root two routes render, which a root is found by alone: the guards and the params of one would be run for the other', () => {
    const board = {
      ...TEAM_BOARD,
      page: 'boards/[team]/[projectId]/page.tsx',
      route: '/boards/[team]/[projectId]',
    };

    expect(() => routeRegistryOf({ routes: [TEAM_BOARD, board] }, registry)).toThrow(
      'The route "/boards/[team]/[projectId]" renders the root "components/board", which the route "/teams/[team]/boards/[projectId]" renders too: a root is one route\'s — its params, its guards and its shared view.',
    );
  });

  it('refuses a route of a reactive root, as one of none, that names other params than its path’s: none, some, out of order, one more', () => {
    const teamAccount: PlainRouteRegistration = {
      ...ACCOUNT,
      file: 'account/[team]/[tab]/page.tsx',
      params: ['team', 'tab'],
      route: '/account/[team]/[tab]',
    };

    for (const route of [TEAM_BOARD, teamAccount]) {
      const [first = '', second = ''] = route.params;
      // What the page's request withholds of the visitor's query is read of the list
      // (`nxtPprojectId`): one left out of it would reach the page as the visitor gave it.
      const wrong: readonly unknown[] = [
        [],
        [second],
        [first],
        [second, first],
        [first, first],
        [first, second, 'id'],
        undefined,
      ];

      expect(verdictOf(route)).toBe('taken');
      expect(
        wrong.map((params) => verdictOf({ ...route, params } as unknown as RegisteredRoute)),
      ).toStrictEqual(wrong.map(() => "names other params than its path's."));
    }
  });

  it('refuses a route of a reactive root with a catch-all, as one of none, whatever params and props it names', () => {
    // A param of segments, or of none, which no request of the route is read by (`paramsOfPath`)
    // and no view is one of: the compile registers no such route.
    const catchAlls: readonly RouteRegistration[] = [
      {
        ...TEAM_BOARD,
        page: 'docs/[...slug]/page.tsx',
        params: [],
        props: {},
        route: '/docs/[...slug]',
        shared: true,
      },
      {
        ...TEAM_BOARD,
        page: 'docs/[[...slug]]/page.tsx',
        params: [],
        props: {},
        route: '/docs/[[...slug]]',
        shared: true,
      },
      {
        ...TEAM_BOARD,
        page: 'docs/[...slug]/page.tsx',
        params: ['slug'],
        props: { slug: 'slug' },
        route: '/docs/[...slug]',
      },
      {
        ...TEAM_BOARD,
        page: 'teams/[team]/docs/[...slug]/page.tsx',
        params: ['team'],
        props: { team: 'team' },
        route: '/teams/[team]/docs/[...slug]',
        shared: true,
      },
    ];

    expect(catchAlls.map((route) => verdictOf(route))).toStrictEqual(
      catchAlls.map(() => 'has a catch-all, which the compile registers no route of.'),
    );
  });

  it('refuses a route shared whose root is not given every param of its path, as no generation of its view could be rendered', () => {
    const shared = { ...TEAM_BOARD, shared: true };

    expect(() => routeRegistryOf({ routes: [shared] }, registry)).toThrow(
      'The route "/teams/[team]/boards/[projectId]" is shared, but its root is not given every param of its path (team): a view every visitor shares is one of all of them.',
    );
    // What a page renders the root with names no view of the route's.
    expect(paramsOfProps(shared, { projectId: 'p1' })).toBeUndefined();
  });

  it('takes the route as the request’s, and shared where its root is given every param of its path', () => {
    const whole: RouteRegistration = {
      ...TEAM_BOARD,
      page: 'teams/[team]/projects/[projectId]/page.tsx',
      props: { projectId: 'projectId', team: 'team' },
      root: 'components/project',
      route: '/teams/[team]/projects/[projectId]',
      shared: true,
    };
    const { routes } = routeRegistryOf({ routes: [TEAM_BOARD, whole] }, registry);

    expect(routes.get(TEAM_BOARD.route)).toStrictEqual(TEAM_BOARD);
    expect(routes.get(whole.route)).toStrictEqual(whole);
    expect(paramsOfProps(whole, { projectId: 'p1', team: 't1' })).toStrictEqual({
      projectId: 'p1',
      team: 't1',
    });
  });

  it('takes a route of each dynamic segment the compile registers, by any name Next.js gives a param, and reads its paths by them', async () => {
    const appDir = await appOf([
      'boards/[$project]',
      'docs/[doc-id]/v/[v1.0]',
      // A catch-all, or a segment Next.js refuses: no route the compile registers.
      'all/[...slug]',
      'any/[[...slug]]',
      'dotted/[.x]',
      'optional/[[x]]',
    ]);
    const { pages } = scanApp(appDir, path.join(appDir, '.reactive'));

    expect(pages.map(({ route }) => route)).toStrictEqual([
      undefined,
      undefined,
      { params: ['$project'], route: '/boards/[$project]' },
      { params: ['doc-id', 'v1.0'], route: '/docs/[doc-id]/v/[v1.0]' },
      undefined,
      undefined,
    ]);

    // Each shared, its root given every param under its own name.
    const routes = pages.flatMap(({ page, route }): RouteRegistration[] => {
      if (route === undefined) {
        return [];
      }
      const props = Object.fromEntries(route.params.map((param) => [param, param]));
      const root = route.route.startsWith('/docs/') ? 'components/doc' : 'components/board';
      return [
        {
          ...TEAM_BOARD,
          page,
          params: route.params,
          props,
          root,
          route: route.route,
          shared: true,
        },
      ];
    });

    expect([...routeRegistryOf({ routes }, registry).routes.keys()]).toStrictEqual([
      '/boards/[$project]',
      '/docs/[doc-id]/v/[v1.0]',
    ]);
    expect(paramsOfPath('/boards/[$project]', '/boards/p%201')).toStrictEqual({
      $project: 'p%201',
    });
    expect(paramsOfPath('/docs/[doc-id]/v/[v1.0]', '/docs/d1/v/2')).toStrictEqual({
      'doc-id': 'd1',
      'v1.0': '2',
    });
    expect(pathOf('/docs/[doc-id]/v/[v1.0]', { 'doc-id': 'd%201', 'v1.0': '2' })).toBe(
      '/docs/d%201/v/2',
    );
  });

  it('reads a param of a path as Next.js hands it to the page — decoded and encoded again, a slash in it kept in its segment — and none that decodes to nothing, `.` or `..`', () => {
    const route = '/boards/[projectId]';
    const read = (pathname: string): unknown => paramsOfPath(route, pathname)?.['projectId'];

    // What `next start` hands the page at each (Next.js 16.4.2).
    expect(
      [
        '/boards/caf%C3%A9',
        '/boards/caf%c3%a9',
        '/boards/café',
        '/boards/a%2Fb',
        '/boards/a%3Ab',
      ].map((pathname) => read(pathname)),
    ).toStrictEqual(['caf%C3%A9', 'caf%C3%A9', 'caf%C3%A9', 'a%2Fb', 'a%3Ab']);
    expect(
      ['/boards/.x', '/boards/%2E%2Ex', '/boards/%252E%252E'].map((pathname) => read(pathname)),
    ).toStrictEqual(['.x', '..x', '%252E%252E']);

    // Never a page's: the URL parser takes each for a step of the path, before Next.js matches it.
    for (const pathname of [
      '/boards/..',
      '/boards/%2E%2E',
      '/boards/.%2e',
      '/boards/.',
      '/boards/%2E',
    ]) {
      expect(paramsOfPath(route, pathname)).toBeUndefined();
    }

    expect(paramsOfPath(route, '/boards/')).toBeUndefined();
    expect(paramsOfPath(route, '/boards/%E9')).toBeUndefined();
  });

  it('takes a page’s props for a view only where each is a param as Next.js hands one to a page, and writes no path of another page for one', () => {
    const board: RouteRegistration = {
      ...TEAM_BOARD,
      page: 'boards/[projectId]/page.tsx',
      params: ['projectId'],
      route: '/boards/[projectId]',
      shared: true,
    };

    expect(paramsOfProps(board, { projectId: 'caf%C3%A9' })).toStrictEqual({
      projectId: 'caf%C3%A9',
    });

    for (const projectId of ['café', 'caf%c3%a9', 'a/b', '..', '.', '', '%2E%2E', '%E9']) {
      expect(paramsOfProps(board, { projectId })).toBeUndefined();
    }

    // The page of each param asked for at the param as it is: `a%2Fb` one segment.
    expect(pathOf(board.route, { projectId: 'a%2Fb' })).toBe('/boards/a%2Fb');
    expect(pathOf(board.route, { projectId: 'caf%C3%A9' })).toBe('/boards/caf%C3%A9');

    for (const projectId of ['..', '.', '', '%2E%2E', 'café', 'a/b']) {
      expect(pathOf(board.route, { projectId })).toBeUndefined();
    }
  });

  it('takes a page’s render of a root for its view only where its props are those the view renders the root with, and nothing besides', () => {
    // A page that gives its root the one param twice: `<Board first={projectId} second={projectId} />`.
    const twice: RouteRegistration = {
      ...TEAM_BOARD,
      page: 'boards/[projectId]/page.tsx',
      params: ['projectId'],
      props: { first: 'projectId', second: 'projectId' },
      route: '/boards/[projectId]',
      shared: true,
    };

    expect(viewParamsOf(twice, { first: 'p1', second: 'p1' })).toStrictEqual({ projectId: 'p1' });

    for (const props of [
      { first: 'p1', second: 'p2' },
      { first: 'p1', second: 'p1', view: 'compact' },
      { first: 'p1', second: 'p1', view: 2 },
      { first: 'p1' },
      { first: ['p1'], second: 'p1' },
      { first: '..', second: '..' },
    ]) {
      expect(viewParamsOf(twice, props)).toBeUndefined();
    }
  });

  it('writes each folder of a route’s path as a path spells its name, never cut short at a `#` or a `?`, nor a step of the path', () => {
    expect(
      [
        '/reports/foo#bar',
        '/reports/q?x',
        '/reports/sp ace',
        '/reports/100%',
        '/reports/%2E%2E',
      ].map((route) => pathOf(route, {})),
    ).toStrictEqual([
      '/reports/foo%23bar',
      '/reports/q%3Fx',
      '/reports/sp%20ace',
      '/reports/100%25',
      '/reports/%252E%252E',
    ]);
    // What a path holds as it is, kept so: a static segment of a dynamic route is matched as written.
    expect(pathOf('/r/a:b/café/[id]', { id: 'x' })).toBe('/r/a:b/caf%C3%A9/x');
  });
});
