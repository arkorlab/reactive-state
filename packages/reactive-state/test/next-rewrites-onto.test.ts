import { createRequire } from 'node:module';

import type { NextAdapter } from 'next';
import { describe, expect, it } from 'vitest';

import { deliveredBuildOf, rewritesOnto, type RoutingRule } from '../src/next/rewrites-onto.ts';
import { DIRECT_HEADER, routeKeyOf } from '../src/routing.ts';

/**
 * The application's own rewrites a build of routes under middleware is refused for: those that may
 * send a request to such a route, which Next.js serves past the rewrite that delivers it. Each
 * rewrite is handed over as Next.js hands an adapter one (`buildRewriteItem`, `build-complete.ts`):
 * compiled by `@vercel/routing-utils`, a slash after it optional.
 */

type BuildComplete = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];

const { convertRewrites } = createRequire(import.meta.url)(
  'next/dist/compiled/@vercel/routing-utils',
) as {
  readonly convertRewrites: (
    rewrites: readonly {
      readonly destination: string;
      readonly has?: readonly unknown[];
      readonly source: string;
    }[],
    internalParams: readonly string[],
  ) => readonly { readonly dest?: string; readonly src: string }[];
};
const { modifyRouteRegex } = createRequire(import.meta.url)('next/dist/lib/redirect-status.js') as {
  readonly modifyRouteRegex: (regex: string) => string;
};

/** An application's rewrite of `source` to `destination`, as Next.js hands an adapter one. */
function rewrite(source: string, destination: string, has?: readonly unknown[]): RoutingRule {
  const [converted] = convertRewrites(
    [{ destination, source, ...(has !== undefined && { has }) }],
    ['nextInternalLocale'],
  );
  return {
    destination: converted?.dest ?? destination,
    source,
    sourceRegex: modifyRouteRegex(converted?.src ?? ''),
  };
}

/** The build's delivery key, which the adapter's own rewrites let through. */
const KEY = 'the-build-s-delivery-key_0123456789';
/** The routes under middleware: the home page, the projects index, a project, the board. */
const DELIVERED: readonly string[] = [
  '/',
  '/projects',
  '/projects/[projectId]',
  '/boards/[projectId]',
];

/** The adapter's own rewrite of `route`, under `basePath`, as a build hands it over. */
function delivery(route: string, basePath: string): RoutingRule {
  return {
    destination: `${basePath}/api/reactive-state/deliver/${routeKeyOf(route)}${route.includes('[') ? '/$1' : ''}`,
    missing: [{ key: DIRECT_HEADER, type: 'header', value: KEY }],
    source: `${basePath}${route}`,
    sourceRegex: '^.*$',
  };
}

/** The names a build serves as they are, under `basePath`, as Next.js hands its outputs over. */
function outputsOf(basePath: string): BuildComplete['outputs'] {
  const at = (pathname: string): string =>
    pathname === '/' ? basePath || '/' : `${basePath}${pathname}`;
  const pages = ['/', '/projects', '/about', '/boards/new', '/boards/[projectId]', '/posts/[id]'];
  const prerendered: readonly (readonly [string, string])[] = [
    ['/', '/'],
    ['/index.rsc', '/'],
    ['/projects', '/projects'],
    ['/projects.rsc', '/projects'],
    ['/projects.segments/_tree.segment.rsc', '/projects'],
    ['/about', '/about'],
    ['/boards/[projectId].rsc', '/boards/[projectId]'],
  ];
  return {
    appPages: pages.map((pathname) => ({ pathname: at(pathname) })),
    appRoutes: [{ pathname: at('/api/reactive-state/[...path]') }],
    pages: [],
    pagesApi: [],
    prerenders: prerendered.map(([pathname, route]) => ({ pathname: at(pathname), route })),
    staticFiles: [{ pathname: at('/robots.txt') }, { pathname: at('/_next/static/a.js') }],
  } as unknown as BuildComplete['outputs'];
}

/** The application's own rules, by the phase each is matched in. */
type Own = Partial<
  Record<'afterFiles' | 'beforeFiles' | 'beforeMiddleware' | 'fallback', RoutingRule[]>
>;

/**
 * Why a build of `own` rules beside the adapter's is refused, under `basePath`, of `delivered`
 * routes under middleware: none where it is not.
 */
function refusals(own: Own, basePath = '', delivered = DELIVERED): string[] {
  const ours = (dynamic: boolean): RoutingRule[] => {
    const routes = delivered.filter((route) => route.includes('[') === dynamic);
    return routes.map((route) => delivery(route, basePath));
  };
  const context = {
    config: { basePath, trailingSlash: false },
    outputs: outputsOf(basePath),
    routing: {
      afterFiles: [...ours(true), ...(own.afterFiles ?? [])],
      beforeFiles: [...ours(false), ...(own.beforeFiles ?? [])],
      beforeMiddleware: [
        {
          headers: { Location: '/$1' },
          source: '/:path+/',
          sourceRegex: String.raw`^(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))\/$`,
          status: 308,
        },
        ...(own.beforeMiddleware ?? []),
      ],
      dynamicRoutes: [],
      fallback: own.fallback ?? [],
    },
  } as unknown as BuildComplete;
  return rewritesOnto(deliveredBuildOf(context, { key: KEY, routes: delivered }));
}

/** The routes a refusal of `source`'s rewrite names: none where there is none. */
function reached(issues: readonly string[], source: string): string | undefined {
  const issue = issues.find((each) => each.startsWith(`the rewrite of ${source} `));
  return issue?.slice(issue.indexOf('may send a request to ') + 'may send a request to '.length);
}

const UNDER = ', delivered through its route middleware';

describe('an application’s own rewrite onto a route under middleware', () => {
  it('is refused in each phase, naming the rewrite and the route it may send a request to', () => {
    const issues = refusals({
      afterFiles: [rewrite('/old-boards/:id', '/boards/:id')],
      beforeFiles: [rewrite('/old-projects', '/projects')],
      fallback: [rewrite('/fallback-projects', '/projects')],
    });

    expect(issues).toStrictEqual([
      `the rewrite of /old-projects to /projects (beforeFiles) may send a request to /projects${UNDER}`,
      `the rewrite of /old-boards/:id to /boards/$1 (afterFiles) may send a request to /boards/[projectId]${UNDER}`,
      `the rewrite of /fallback-projects to /projects (fallback) may send a request to /projects${UNDER}`,
    ]);
  });

  it('refuses none of the adapter’s own, no redirect and no rewrite to another origin', () => {
    expect(
      refusals({
        afterFiles: [rewrite('/elsewhere', 'https://example.com/projects')],
        beforeMiddleware: [
          {
            headers: { location: '/projects' },
            source: '/moved',
            sourceRegex: String.raw`^\/moved(?:\/)?$`,
            status: 307,
          },
          {
            destination: '/projects',
            headers: { Refresh: '0; url=/projects' },
            source: '/refreshed',
            sourceRegex: String.raw`^\/refreshed(?:\/)?$`,
            status: 302,
          },
        ],
      }),
    ).toStrictEqual([]);
  });

  it('reads a destination written whole as the router does: escaped, its dot segments resolved, with a trailing slash, as a page’s data, in any case where a dynamic route finds it', () => {
    const destinations = [
      '/%70rojects',
      '/about/../projects',
      '/projects/',
      '/projects.rsc',
      '/projects.segments/_tree.segment.rsc',
      '/index.rsc',
      '/boards/p1.rsc',
      '/boards/p1.segments/_tree.segment.rsc',
      '/BOARDS/p1',
    ];
    const issues = refusals({
      afterFiles: destinations.map((destination, index) =>
        rewrite(`/a${String(index)}`, destination),
      ),
    });

    expect(destinations.map((_, index) => reached(issues, `/a${String(index)}`))).toStrictEqual([
      `/projects${UNDER}`,
      `/projects${UNDER}`,
      `/projects${UNDER}`,
      `/projects${UNDER}`,
      `/projects${UNDER}`,
      `/${UNDER}`,
      `/boards/[projectId]${UNDER}`,
      `/boards/[projectId]${UNDER}`,
      `/boards/[projectId]${UNDER}`,
    ]);
  });

  it('lets a rewrite to a name the router serves as it is in place of a route under middleware, to a file, or to a path of no route under middleware', () => {
    const destinations = [
      '/about',
      '/boards/new',
      '/robots.txt',
      '/posts/1',
      '/PROJECTS',
      '/missing',
    ];

    expect(
      refusals({
        afterFiles: destinations.map((destination, index) =>
          rewrite(`/a${String(index)}`, destination),
        ),
      }),
    ).toStrictEqual([]);
  });

  it('reads what a destination puts a capture in by what the rule’s pattern lets it hold', () => {
    const issues = refusals({
      afterFiles: [
        rewrite('/docs/:path*', '/documentation/:path*'),
        rewrite('/old/:slug', '/boards/:slug'),
        rewrite(String.raw`/legacy/:id(\d+)`, '/posts/:id'),
        rewrite(String.raw`/numbered/:id(\d+)`, '/projects/:id'),
        rewrite('/swap/:a/:b', '/:b/:a'),
        rewrite('/feed-photo/:id', '/feed/(..)photo/:id'),
      ],
    });

    expect([
      reached(issues, '/docs/:path*'),
      reached(issues, '/old/:slug'),
      reached(issues, String.raw`/legacy/:id(\d+)`),
      reached(issues, String.raw`/numbered/:id(\d+)`),
      reached(issues, '/swap/:a/:b'),
      reached(issues, '/feed-photo/:id'),
    ]).toStrictEqual([
      undefined,
      `/boards/[projectId]${UNDER}`,
      undefined,
      `/projects/[projectId]${UNDER}`,
      `/projects, /projects/[projectId], /boards/[projectId]${UNDER}`,
      undefined,
    ]);
  });

  it('takes a capture that may hold `/` or `..` for one that may send a request to any route: a condition’s, a part of a segment, one written to climb', () => {
    const everywhere = `${DELIVERED.join(', ')}${UNDER}`;
    const issues = refusals({
      afterFiles: [
        rewrite('/q', '/posts/:v', [{ key: 'v', type: 'query', value: '(?<v>.*)' }]),
        rewrite('/img/:name.png', '/images/:name'),
        rewrite('/up/:slug', '/posts/:slug/../../projects'),
        rewrite('/any/:rest(.*)', '/posts/:rest'),
      ],
    });

    expect([
      reached(issues, '/q'),
      reached(issues, '/img/:name.png'),
      reached(issues, '/up/:slug'),
      reached(issues, '/any/:rest(.*)'),
    ]).toStrictEqual([everywhere, everywhere, everywhere, everywhere]);
  });

  it('refuses none of the adapter’s own rules, nor a rewrite to an intercepting route, beside a route of as many dynamic segments as the compile’s route’s paths', () => {
    const delivered = ['/projects', '/[a]/[b]/[c]/[d]'];
    const issues = refusals(
      {
        afterFiles: [
          rewrite('/feed-photo/:id', '/feed/(..)photo/:id'),
          rewrite('/photo/:id', '/feed/photo/:id/x'),
        ],
      },
      '',
      delivered,
    );

    expect(issues).toStrictEqual([
      `the rewrite of /photo/:id to /feed/photo/$1/x (afterFiles) may send a request to /[a]/[b]/[c]/[d]${UNDER}`,
    ]);
  });

  it('reads a destination where the site serves its routes, under its base path', () => {
    const issues = refusals(
      {
        afterFiles: [
          rewrite('/docs/old', '/docs/projects'),
          rewrite('/docs/outside', '/projects'),
          rewrite('/docs/up/:slug', '/:slug'),
        ],
      },
      '/docs',
    );

    expect([
      reached(issues, '/docs/old'),
      reached(issues, '/docs/outside'),
      reached(issues, '/docs/up/:slug'),
    ]).toStrictEqual([
      `/projects${UNDER}`,
      undefined,
      `/, /projects, /projects/[projectId], /boards/[projectId]${UNDER}`,
    ]);
  });
});
