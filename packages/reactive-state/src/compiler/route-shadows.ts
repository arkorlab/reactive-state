import path from 'node:path';

import { COMPILE_ROUTE_DIRECTORY, dynamicSegmentOf, type DynamicSegment } from '../routing.ts';
import { ReactiveCompileError } from './errors.ts';
import type { Modules } from './modules.ts';
import { pagesRoutesOf } from './pages-routes.ts';
import { type AppLayout, chainOf, matchedRouteOf, type RouteFile, scanApp } from './route-scan.ts';

/**
 * A route under route middleware is delivered by a rewrite, which Next.js runs before it matches its
 * dynamic routes (`afterFiles`): one of a dynamic segment takes every request its pattern matches,
 * a request Next.js would have matched to a more specific dynamic route among them. Where that
 * route is delivered too, its rewrite is matched first (the adapter orders them as Next.js orders
 * the routes); where it is not — no middleware is around it — its requests would be delivered as
 * the other route's, through that route's middleware, and its page answer them past it. Such a pair
 * is refused, saying which. The compile's own route (`api/reactive-state/[...path]`) is kept off
 * every rewrite by the adapter itself.
 */

/** What a segment of a route is, in the order Next.js matches them at one place (`UrlNode`). */
const RANKS: Readonly<Record<DynamicSegment['kind'] | 'static', number>> = {
  catchall: 2,
  dynamic: 1,
  'optional-catchall': 3,
  static: 0,
};

/** A segment of a route, as its pattern matches one. */
interface Matched {
  readonly kind: DynamicSegment['kind'] | 'static';
  readonly segment: string;
}

/** The segments of `route`, each as it matches. */
function matchedOf(route: string): readonly Matched[] {
  return route
    .split('/')
    .slice(1)
    .filter((segment) => segment !== '')
    .map((segment) => ({ kind: dynamicSegmentOf(segment)?.kind ?? 'static', segment }));
}

/** Whether two segments may match one segment of a path: not two static ones of other names. */
function compatible(a: Matched, b: Matched, insensitive: boolean): boolean {
  if (a.kind !== 'static' || b.kind !== 'static' || a.segment === b.segment) return true;
  if (!insensitive) return false;
  const escaped = a.segment.replaceAll(/[$()*+./?[\\\]^{|}]/gu, String.raw`\$&`);
  // oxlint-disable require-unicode-regexp -- Next.js rewrites use legacy /i semantics.
  // eslint-disable-next-line require-unicode-regexp, security/detect-non-literal-regexp -- Escaped literals use Next.js legacy /i matching.
  return new RegExp(`^${escaped}$`, 'i').test(b.segment);
  // oxlint-enable require-unicode-regexp
}

/** Whether a route of `fixed` segments and then a catch-all of `last`'s kind, if any, takes `length`. */
function takes(length: number, fixed: number, last: Matched['kind'] | undefined): boolean {
  if (last === 'catchall') {
    return length > fixed;
  }
  return last === 'optional-catchall' ? length >= fixed : length === fixed;
}

/**
 * Whether `delivered` — of single segments, static or dynamic — and `other` match a path both: of
 * as many segments, or as many as `other`'s catch-all takes, each place's segments alike.
 */
function overlaps(
  delivered: readonly Matched[],
  other: readonly Matched[],
  insensitive = false,
): boolean {
  const last = other.at(-1)?.kind;
  const fixed =
    last === 'catchall' || last === 'optional-catchall' ? other.length - 1 : other.length;
  const fits = takes(delivered.length, fixed, last);
  return (
    fits &&
    other.slice(0, fixed).every((each, index) => {
      const mine = delivered[index];
      return mine !== undefined && compatible(mine, each, insensitive);
    })
  );
}

/** Whether Next.js matches `other` before `delivered`: at the first place they differ, by its rank. */
function matchedFirst(delivered: readonly Matched[], other: readonly Matched[]): boolean {
  for (const [index, mine] of delivered.entries()) {
    const theirs = other[index];
    if (theirs === undefined) {
      return false;
    }
    if (mine.kind !== theirs.kind) {
      return RANKS[theirs.kind] < RANKS[mine.kind];
    }
  }
  return false;
}

/** A route the compile delivers: its route, and its file under the app directory. */
interface DeliveredRoute {
  readonly route: string;
  readonly file: string;
}

/**
 * A route Next.js serves with no route middleware around it: its route, as it matches, and what
 * moving it under middleware takes — none for a route of the Pages Router, which no route middleware
 * of this package's is around.
 */
interface FreeRoute {
  readonly route: string;
  readonly matched: readonly Matched[];
  /** Its file: its page under the app directory, or its path from beside `pages`. */
  readonly file: string;
  readonly pages: boolean;
}

/**
 * The routes Next.js serves with no route middleware around them: each page and route handler of
 * the app directory under none — the compile's own route aside — and each route of the Pages Router
 * (`pagesRoutesOf`), its API routes among them. A case-shadow scan includes routes under middleware
 * too: their insensitive rewrites can capture each other even when both are delivered.
 */
function freeRoutesOf(
  layout: AppLayout,
  appDir: string,
  includeMiddleware = false,
): readonly FreeRoute[] {
  const fromApp = [...layout.pages, ...layout.handlers].flatMap((entry: RouteFile) => {
    const route = matchedRouteOf(entry.directory);
    const free = chainOf(entry.directory, layout).length === 0;
    return route === undefined ||
      (!free && !includeMiddleware) ||
      entry.directory === COMPILE_ROUTE_DIRECTORY
      ? []
      : [{ file: entry.page, matched: matchedOf(route), pages: false, route }];
  });
  const fromPages = pagesRoutesOf(appDir).map(({ file, segments }) => {
    const route = `/${segments.join('/')}`;
    const named = path.relative(path.dirname(appDir), file).split(path.sep).join('/');
    return { file: named, matched: matchedOf(route), pages: true, route };
  });
  return [...fromApp, ...fromPages];
}

/** Why `delivered`'s rewrite is refused, taking the requests of `shadowed`. */
function shadowedReason(delivered: string, shadowed: FreeRoute): string {
  const named = `\`${shadowed.route}\` (\`${shadowed.file}\`${shadowed.pages ? ', of the Pages Router' : ''})`;
  const remedy = shadowed.pages
    ? 'Give the two routes paths that do not overlap.'
    : `Put \`${shadowed.file}\` under the middleware too, or give the two routes paths that do not overlap.`;
  return `\`${delivered}\` is delivered through its route middleware by a rewrite Next.js runs before its dynamic routes, which would take the requests of ${named} — a route Next.js matches first, with no middleware around it — and deliver them as \`${delivered}\`'s, through its middleware. ${remedy}`;
}

/**
 * Refuses each route of `delivered` of a dynamic segment whose rewrite would take the requests of a
 * more specific dynamic route Next.js serves with no middleware around it (`freeRoutesOf`), of the
 * App Router or the Pages Router.
 */
export function checkShadows(
  delivered: readonly DeliveredRoute[],
  context: { readonly layout: AppLayout; readonly modules: Modules; readonly appDir: string },
): void {
  const { appDir, layout, modules } = context;
  const others = freeRoutesOf(layout, appDir);
  for (const each of delivered) {
    const mine = matchedOf(each.route);
    if (mine.every((segment) => segment.kind === 'static')) {
      continue;
    }
    const shadowed = others.find((other) => {
      return (
        other.matched.some((segment) => segment.kind !== 'static') &&
        overlaps(mine, other.matched) &&
        matchedFirst(mine, other.matched)
      );
    });
    if (shadowed !== undefined) {
      throw new ReactiveCompileError(shadowedReason(each.route, shadowed), {
        fileName: modules.nameOf(path.join(appDir, each.file)),
        position: { character: 0, line: 0 },
      });
    }
  }
}

/** One path a case-insensitive delivery rewrite may take from a native case-distinct route. */
interface CaseShadow {
  readonly route: string;
  readonly pathname: string;
  readonly reason: string;
}

/** A path of both patterns under insensitive matching, retaining the other route's static spelling. */
function sharedPath(delivered: readonly Matched[], other: readonly Matched[]): string {
  return `/${delivered
    .map((mine, index) => {
      const theirs = other[index];
      if (theirs?.kind === 'static') return theirs.segment;
      return mine.kind === 'static' ? mine.segment : 'reactive-shadow';
    })
    .join('/')}`;
}

/**
 * Native case-distinct routes a default delivery rewrite could take. Static files precede
 * afterFiles; the adapter validates each remaining witness against its actual generated rewrite.
 */
export function caseShadowsOf(
  delivered: readonly string[],
  layout: { readonly appDir: string; readonly outDir: string },
): readonly CaseShadow[] {
  const others = freeRoutesOf(scanApp(layout.appDir, layout.outDir), layout.appDir, true);
  return delivered.flatMap((route) => {
    const mine = matchedOf(route);
    const beforeFiles = mine.every((segment) => segment.kind === 'static');
    return others.flatMap((other) => {
      const reached = beforeFiles || other.matched.some((segment) => segment.kind !== 'static');
      if (!reached || overlaps(mine, other.matched) || !overlaps(mine, other.matched, true))
        return [];
      return [
        {
          route,
          pathname: sharedPath(mine, other.matched),
          reason: `The case-insensitive delivery rewrite of \`${route}\` would take requests of \`${other.route}\` (\`${other.file}\`), which Next.js serves as a distinct native route, including when it has route middleware too. Give the routes paths that do not overlap under the configured rewrite matching.`,
        },
      ];
    });
  });
}
