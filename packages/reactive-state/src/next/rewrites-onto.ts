import type { NextAdapter } from 'next';

import {
  COMPILE_ROUTE_DIRECTORY,
  DELIVER_PATH,
  DIRECT_HEADER,
  dynamicSegmentOf,
  type SiteShape,
} from '../routing.ts';
import { sitePathOf, underBasePath } from '../site-paths.ts';
import { type Reference, referencesOf } from './rewrite-captures.ts';

/**
 * Which of an application's own rewrites (`next.config`'s `rewrites`) may send a request to a route
 * delivered through its route middleware, read off the routing a build hands its adapter
 * (`onBuildComplete`). Next.js gives every rewrite `check: true` — the page or file its
 * destination names is served as soon as one matches — and the adapter's own rewrites run first in
 * their phase: an application's rewrite onto such a route would have its page answer past the
 * rewrite that delivers it, and so past its middleware — its envelopes, and the guards of a route
 * of no reactive root. A destination is read as the router reads one, as upwind core reads a
 * rewrite onto a gated route (`rewritesOnto`): its dot segments resolved, its escapes decoded as
 * well, a name the build serves as it is — a page of no dynamic segment, its data, a file — served
 * so in place of any dynamic route, and what the rule captured read by what its source pattern lets
 * each capture hold (`referencesOf`): one that may hold `/` or `..` may land anywhere, and anything
 * may follow it. A rule's conditions (`has`, `missing`) are a visitor's to meet, and limit nothing.
 * A redirect reaches no route — the browser asks again, through the delivery — and nor does a
 * rewrite to another origin, which answers it itself.
 */

/** A rule of a build's routing, as `onBuildComplete` hands it, as far as where it sends a request. */
export interface RoutingRule {
  readonly source?: string | undefined;
  readonly sourceRegex: string;
  readonly destination?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly status?: number | undefined;
  readonly missing?: readonly RuleCondition[] | undefined;
}

/** A condition of a rule's (`has`, `missing`), as far as what it names. */
interface RuleCondition {
  readonly type: string;
  readonly key?: string | undefined;
  readonly value?: string | undefined;
}

/** What Next.js hands an adapter as a build completes (`onBuildComplete`). */
type BuildComplete = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];

/** The phases of a build's routing a rewrite may be matched in. */
const PHASES = ['beforeMiddleware', 'beforeFiles', 'afterFiles', 'fallback'] as const;

/** A build's routing, by the phases a rewrite may be matched in. */
type RewritePhases = Readonly<Record<(typeof PHASES)[number], readonly RoutingRule[]>>;

/** What of a build the check reads. */
export interface DeliveredBuild {
  readonly routing: RewritePhases;
  /** The routes delivered through their route middleware, as Next.js names them. */
  readonly delivered: readonly string[];
  /** Where the site serves its routes. */
  readonly site: SiteShape;
  /**
   * Each name the router serves as it is, under the site's base path — a page of no dynamic
   * segment, a member or the data of one it prerendered, a file — and the route it is of: none
   * for a file.
   */
  readonly served: ReadonlyMap<string, string | undefined>;
  /** Whether `rule` is one of the adapter's own, which deliver a route. */
  readonly ours: (rule: RoutingRule) => boolean;
}

/** The origin a path is read under: a path alone, never another origin's. */
const ORIGIN = 'https://n';
/** Another origin's URL, which the router hands to that origin. */
const EXTERNAL = /^https?:\/\//iu;
/** A segment that opens an intercepting route (`(.)`, `(..)`, `(...)`), which none delivers. */
const INTERCEPTING = /\/\(\.{1,3}\)/u;
/** A segment that climbs a level once the router resolves it: `..`, either dot escaped or not. */
const CLIMB = /^(?:\.|%2e){2}$/iu;
/** An escape a path ends in that what follows it may complete. */
const OPEN_ESCAPE = /%[\da-f]?$/iu;
const REDIRECT_HEADERS: ReadonlySet<string> = new Set(['location', 'refresh']);
const LOWEST_REDIRECT = 300;
const HIGHEST_REDIRECT = 399;
/** What follows a page's name in the name of its data: its payload, its prefetch segments. */
const PAYLOAD_SUFFIX = '.rsc';
const SEGMENTS_DIRECTORY = '.segments';
const SEGMENTS_MARK = `${SEGMENTS_DIRECTORY}/`;

/**
 * How a path is compared with a route: as written, as the router finds a page by its name; or in
 * any case, as upwind's runtime matches a dynamic route's pattern.
 */
type Fold = (text: string) => string;
const AS_WRITTEN: Fold = (text) => text;
const ANY_CASE: Fold = (text) => text.toLowerCase();

/** A delivered route as a path is compared with it: its name, and its segments where it is served. */
interface Template {
  readonly route: string;
  readonly segments: readonly string[];
  readonly fold: Fold;
}

/**
 * Where a rule sends the request it matches on the application's own origin: the destination of a
 * rule that does not answer with a redirect — a 3xx said with a `Location` or a `Refresh` — and
 * does not send it to another origin, which answers it itself.
 */
function rewritesTo(rule: RoutingRule): string | undefined {
  const { destination, headers, status } = rule;
  const redirects =
    status !== undefined &&
    status >= LOWEST_REDIRECT &&
    status <= HIGHEST_REDIRECT &&
    Object.keys(headers ?? {}).some((name) => REDIRECT_HEADERS.has(name.toLowerCase()));
  return destination === undefined || redirects || EXTERNAL.test(destination)
    ? undefined
    : destination;
}

/** `path` decoded, as the router finds a page by its name decoded too; none where it is no escape. */
function decoded(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/** A path without the slash it may end in, the root's aside. */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** `path` as the router sets it on the URL: its dot segments resolved, what a URL escapes escaped. */
function spelledOf(path: string): string {
  return new URL(`${ORIGIN}${path}`).pathname;
}

/**
 * The names the router may find a path a rewrite writes whole by: as it sets it on the URL, and
 * that decoded, each with and without a trailing slash.
 */
function readingsOf(path: string): string[] {
  const spelled = spelledOf(path);
  const readings = [spelled, decoded(spelled)];
  return [
    ...new Set(
      readings.flatMap((reading) =>
        reading === undefined ? [] : [reading, withoutTrailingSlash(reading)],
      ),
    ),
  ];
}

/**
 * Each page `path` may be the data of, longest first: the path with its payload's suffix taken off
 * (`.rsc`), and the path as far as each `.segments/` in it — a page's prefetch segments follow its
 * name so.
 */
function dataPagesOf(path: string): string[] {
  const pages = path.endsWith(PAYLOAD_SUFFIX) ? [path.slice(0, -PAYLOAD_SUFFIX.length)] : [];
  for (let at = path.indexOf(SEGMENTS_MARK); at !== -1; at = path.indexOf(SEGMENTS_MARK, at + 1)) {
    pages.push(path.slice(0, at));
  }
  return pages.toSorted((one, other) => other.length - one.length);
}

/** Whether a template's segment takes the rest of a path: a catch-all, optional or not. */
function isCatchAll(segment: string): boolean {
  const kind = dynamicSegmentOf(segment)?.kind;
  return kind === 'catchall' || kind === 'optional-catchall';
}

/**
 * Whether a whole segment of a path may be `named`: a dynamic one as any value, and a static one as
 * itself, decoded or not; or, ahead of what a rewrite captures (`open`), followed by its data's
 * suffix (`projects.segments`). Compared as `fold` has them.
 */
function fitsWhole(segment: string, named: string, open: boolean, fold: Fold): boolean {
  if (dynamicSegmentOf(named) !== undefined) {
    return true;
  }
  const name = fold(named);
  const spelled = fold(segment);
  return (
    spelled === name ||
    fold(decoded(segment) ?? segment) === name ||
    (open && spelled.startsWith(`${name}.`))
  );
}

/** Whether the start of a segment, the rest of it a capture's, may begin `named`. */
function begins(segment: string, named: string, fold: Fold): boolean {
  const name = fold(named);
  const spelled = fold(segment);
  return (
    dynamicSegmentOf(named) !== undefined ||
    name.startsWith(spelled) ||
    spelled.startsWith(`${name}.`)
  );
}

/** The segments of a path, none for the root's, a trailing slash's empty one left off. */
function segmentsOf(path: string): string[] {
  const segments = path.split('/').slice(1);
  return segments.at(-1) === '' ? segments.slice(0, -1) : segments;
}

/**
 * Whether a path a rewrite writes whole may be one of `template`'s: segment by segment, a static one
 * as itself, a dynamic one as any value, a catch-all as the rest.
 */
function mayBeWhole(path: string, template: Template): boolean {
  const asked = segmentsOf(path);
  const named = template.segments;
  for (const [at, segment] of asked.entries()) {
    const expected = named[at];
    if (expected === undefined) {
      return false;
    }
    if (isCatchAll(expected)) {
      return true;
    }
    if (!fitsWhole(segment, expected, false, template.fold)) {
      return false;
    }
  }
  const left = named.slice(asked.length);
  return (
    left.length === 0 ||
    (left.length === 1 && dynamicSegmentOf(left[0] ?? '')?.kind === 'optional-catchall')
  );
}

/**
 * Whether a path a rewrite writes as far as `written`, a capture of its source's after it, may be
 * one of `template`'s. Past the template's last segment, it may be only where the path may end
 * there (`emptied`: no capture of one segment at least, or a climb after it), or in a page's
 * prefetch segments, after their directory. Ambiguous counts as may.
 */
function mayBegin(written: string, template: Template, emptied: boolean): boolean {
  const asked = written.split('/').slice(1);
  const { fold, segments: named } = template;
  for (const [at, segment] of asked.entries()) {
    const last = at === asked.length - 1;
    const expected = named[at];
    if (expected === undefined) {
      return (
        (last && segment === '' && emptied) ||
        fold(asked[at - 1] ?? '').endsWith(SEGMENTS_DIRECTORY)
      );
    }
    if (isCatchAll(expected)) {
      return true;
    }
    if (!(last ? begins(segment, expected, fold) : fitsWhole(segment, expected, true, fold))) {
      return false;
    }
  }
  return true;
}

/** `written` with its last `levels` whole segments climbed out of, the one it ends in among them. */
function climbedOutOf(written: string, levels: number): string {
  if (levels === 0) {
    return written;
  }
  const whole = written.split('/').slice(1, -1);
  const kept = whole.slice(0, Math.max(0, whole.length - levels));
  return ['', ...kept, ''].join('/');
}

/**
 * What a path a rewrite writes as far as a capture may be read as: as written, as the URL has it,
 * and that decoded — as far as an escape it ends in, which the capture may complete.
 */
function writtenReadingsOf(written: string): string[] {
  const spelled = spelledOf(written);
  const open = OPEN_ESCAPE.exec(spelled);
  const whole = open === null ? spelled : spelled.slice(0, open.index);
  return [...new Set([decoded(whole) ?? whole, spelled, written])];
}

/**
 * Whether a path a rewrite puts what its rule captured in may be one of `template`'s. A value of any
 * kind (`any`) may be any path at all. Otherwise each part of a segment it puts in may climb a
 * level, and so may each `..` it writes after the first, which the router resolves once the values
 * are in: the path written ahead of the first, less as many segments, is all that rules a route
 * out, however it is read (`writtenReadingsOf`) — anything may follow it.
 */
function mayReachCaptured(
  path: string,
  references: readonly Reference[],
  template: Template,
): boolean {
  const [first] = references;
  if (first === undefined || references.some((reference) => reference.kind === 'any')) {
    return true;
  }
  const climbs =
    references.filter((reference) => reference.kind === 'part').length +
    path
      .slice(first.at)
      .split('/')
      .filter((segment) => CLIMB.test(segment)).length;
  // Where nothing climbs, a path past one segment of its own ends no sooner than that segment.
  const emptied = first.kind !== 'segment' || climbs > 0;
  return writtenReadingsOf(path.slice(0, first.at)).some((written) =>
    mayBegin(climbedOutOf(written, climbs), template, emptied),
  );
}

/**
 * The delivered routes a path a rewrite writes whole may land on: where any reading of it is a
 * name the build serves as it is (`served`), the route of that name, in place of any dynamic
 * route; otherwise each template the path — or the page it may be the data of — may be whole.
 */
function landedWhole(
  path: string,
  templates: readonly Template[],
  build: DeliveredBuild,
): readonly string[] {
  const readings = readingsOf(path);
  const named = readings.filter((reading) => build.served.has(reading));
  if (named.length > 0) {
    const routes = new Set(named.map((reading) => build.served.get(reading)));
    return build.delivered.filter((route) => routes.has(route));
  }
  const pages = readings.flatMap((reading) => [reading, ...dataPagesOf(reading)]);
  return templates
    .filter((template) => pages.some((page) => mayBeWhole(page, template)))
    .map((template) => template.route);
}

/** The delivered routes a rewrite to `destination`, of the rule of `sourceRegex`, may land on. */
function landedOn(
  destination: string,
  sourceRegex: string,
  templates: readonly Template[],
  build: DeliveredBuild,
): readonly string[] {
  // All the router sets on the URL's path: what comes before a `?` or a `#`.
  const [path = ''] = destination.split(/[#?]/u, 1);
  if (INTERCEPTING.test(path)) {
    return [];
  }
  const references = referencesOf(path, sourceRegex);
  if (references.length === 0) {
    return landedWhole(path, templates, build);
  }
  return templates
    .filter((template) => mayReachCaptured(path, references, template))
    .map((template) => template.route);
}

/** `route` as a path is compared with it where `site` serves it (`Template`). */
function templateOf(route: string, site: SiteShape): Template {
  return {
    fold: route.includes('[') ? ANY_CASE : AS_WRITTEN,
    route,
    segments: segmentsOf(sitePathOf(site, route)),
  };
}

/**
 * Why each of the application's rewrites in `build` that may send a request to a route delivered
 * through its route middleware is refused, naming the rewrite and the routes: none where none may.
 */
export function rewritesOnto(build: DeliveredBuild): string[] {
  const templates = build.delivered.map((route) => templateOf(route, build.site));
  const issues: string[] = [];
  for (const phase of PHASES) {
    const rules = build.routing[phase];
    for (const rule of rules) {
      const destination = rewritesTo(rule);
      if (destination === undefined || build.ours(rule)) {
        continue;
      }
      const landed = landedOn(destination, rule.sourceRegex, templates, build);
      if (landed.length > 0) {
        issues.push(
          `the rewrite of ${rule.source ?? rule.sourceRegex} to ${destination} (${phase}) may send a request to ${landed.join(', ')}, delivered through its route middleware`,
        );
      }
    }
  }
  return issues;
}

/** Where the compile's route delivers a route, under the site's base path (`deliver/`). */
const DELIVERED_UNDER = `/${COMPILE_ROUTE_DIRECTORY.split('/').slice(0, -1).join('/')}/${DELIVER_PATH}/`;

/**
 * The names the router of a build serves as they are, each under the site's base path, and the
 * route each is of — a page or a route handler of no dynamic segment, a member or the data of one it
 * prerendered — or none, for a file. A route's own name in brackets is a class, which a dynamic
 * route finds the members of.
 */
function servedNamesOf(
  outputs: BuildComplete['outputs'],
  basePath: string,
): Map<string, string | undefined> {
  const served = new Map<string, string | undefined>();
  for (const file of outputs.staticFiles) {
    served.set(file.pathname, undefined);
  }
  const routes = [...outputs.appPages, ...outputs.appRoutes, ...outputs.pages, ...outputs.pagesApi];
  for (const { pathname } of routes) {
    if (!pathname.includes('[')) {
      served.set(pathname, underBasePath(basePath, pathname) ?? pathname);
    }
  }
  for (const { pathname, route } of outputs.prerenders) {
    if (!pathname.includes('[')) {
      served.set(pathname, route);
    }
  }
  return served;
}

/** Whether a rule's condition is the one the delivery key is let through by (`DIRECT_HEADER`). */
function carriesKey(condition: RuleCondition, key: string): boolean {
  return condition.type === 'header' && condition.key === DIRECT_HEADER && condition.value === key;
}

/**
 * Whether `rule` is one of the adapter's own: to the compile's route, `under` the site's base path,
 * and missing the header that carries `key`.
 */
function isDelivery(rule: RoutingRule, under: string, key: string): boolean {
  const missing = rule.missing ?? [];
  return (
    rule.destination?.startsWith(under) === true &&
    missing.some((condition) => carriesKey(condition, key))
  );
}

/**
 * The build `context` completes, as the check reads it (`DeliveredBuild`), of the routes a build
 * delivers through their middleware by its delivery key: a rule of the adapter's own sends a
 * request to the compile's route, and lets the one that carries the key through to the page.
 */
export function deliveredBuildOf(
  context: BuildComplete,
  delivering: { readonly routes: readonly string[]; readonly key: string },
): DeliveredBuild {
  const { basePath, trailingSlash } = context.config;
  const under = `${basePath}${DELIVERED_UNDER}`;
  return {
    delivered: delivering.routes,
    ours: (rule) => isDelivery(rule, under, delivering.key),
    routing: context.routing,
    served: servedNamesOf(context.outputs, basePath),
    site: { basePath, trailingSlash },
  };
}
