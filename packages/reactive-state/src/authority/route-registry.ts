import { PROTOCOL_VERSION } from '../program.ts';
import {
  dynamicSegmentOf,
  isPlainRoute,
  type MiddlewareProgram,
  ownValueOf,
  paramOfSegment,
  type PlainRouteRegistration,
  type RegisteredRoute,
  type RouteParams,
  type RouteRegistration,
} from '../routing.ts';
import { isPageParam, pageParamOf, segmentNames } from '../site-paths.ts';
import type { Registry } from './programs.ts';

/**
 * What the engine checks of the routes a compile registered — each a page that renders a root of its
 * route's params, or a page of none or a route handler under route middleware — and of the guards
 * of the route middleware around them, before anything is served: each route names its path's
 * params, in order, none left out, each of one segment — no catch-all — and of a name of its own; a
 * route names a root the authority runs, props of its params alone, and middleware it was given the
 * guard of where that middleware has one; a route of no root is under middleware, and says whether a
 * guard of it is among the authority's as it is. What fails is the application's fault.
 */

export interface RouteRegistry {
  /** Each route of a reactive root, by its name (`/boards/[projectId]`). */
  readonly routes: ReadonlyMap<string, RouteRegistration>;
  /**
   * Each route of no reactive root under middleware, by its name: whose guards the host asks of
   * before it hands a request of it on, and nothing else is served of.
   */
  readonly plain: ReadonlyMap<string, PlainRouteRegistration>;
  /**
   * Each route middleware of the compile's, by its id: its guard, or `null` for one with no guard.
   * Every middleware a route names is one of them (`routeRegistryOf`): none of a route's guards is
   * ever passed over as one it was not given (`guardsOf`).
   */
  readonly middleware: ReadonlyMap<string, MiddlewareProgram | null>;
}

export interface RouteOptions {
  readonly routes?: readonly RegisteredRoute[] | undefined;
  /**
   * Each route middleware of the compile's, by its id, as `authority.mts` exports them: its guard
   * program, or `null` for one with no guard. A route under middleware this names neither of is
   * refused.
   */
  readonly middleware?: Readonly<Record<string, MiddlewareProgram | null>> | undefined;
  /**
   * Whether a route the compile found to be one view for every visitor is shared: unless this says
   * `false`, which renders every route's root for each request, as a route that is the request's —
   * what a measurement compares sharing with, on the same build and the same data.
   */
  readonly shareViews?: boolean | undefined;
}

function middlewareOf(
  given: Readonly<Record<string, MiddlewareProgram | null>>,
  buildId: string,
): ReadonlyMap<string, MiddlewareProgram | null> {
  const byId = new Map<string, MiddlewareProgram | null>();
  for (const [id, program] of Object.entries(given)) {
    if (program === null) {
      byId.set(id, null);
      continue;
    }
    if (typeof program !== 'object' || typeof program.guard !== 'function') {
      throw new TypeError(
        `The middleware ${JSON.stringify(id)} has no guard the authority can run.`,
      );
    }
    if (program.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `The middleware ${JSON.stringify(id)} was compiled for protocol ${String(program.protocolVersion)}, and this authority speaks ${String(PROTOCOL_VERSION)}: compile the application again.`,
      );
    }
    if (program.buildId !== buildId || program.id !== id) {
      throw new Error(
        `The middleware ${JSON.stringify(id)} is of another compile than the application's: an authority runs one compile.`,
      );
    }
    byId.set(id, program);
  }
  return byId;
}

/**
 * Why the middleware `route` names are not as the authority was given them, or nothing where they
 * are: a list of ids, each a middleware of the compile's (`RouteOptions.middleware`) — its guard, or
 * none — with a guard among them where the route says it has one (`guarded`), and none where it
 * says it has none.
 */
function malformedChain(
  route: RegisteredRoute,
  middleware: ReadonlyMap<string, MiddlewareProgram | null>,
): string | undefined {
  // Read as the module it was imported of has it, whatever its type says.
  const chain: unknown = route.middleware;
  if (!Array.isArray(chain) || chain.some((id: unknown) => typeof id !== 'string')) {
    return 'names its middleware as no list of ids';
  }
  const unknown = route.middleware.find((id) => !middleware.has(id));
  if (unknown !== undefined) {
    return `is under the middleware ${JSON.stringify(unknown)}, of which the authority was given neither a guard nor that it has none`;
  }
  const guarded = route.middleware.some((id) => (middleware.get(id) ?? null) !== null);
  if (guarded === (route.guarded === true)) {
    return undefined;
  }
  return guarded
    ? 'says it has no guard, where a guard of its middleware is the authority’s'
    : 'says it has a guard, where none of its middleware has one the authority runs';
}

/**
 * Why the params `route` names are not its path's — each of its dynamic segments', in the order the
 * path names them, none left out and none more, each of one segment: no catch-all (`[...slug]`,
 * `[[...slug]]`), which the compile registers no route of, reactive or plain; and each of a name no
 * other segment has, as a request's params hold one value of a name, and Next.js serves no path that
 * names one twice — or nothing where they are: what a request of the route is read by
 * (`paramsOfPath`), and what the page's own request withholds of the visitor's query under Next.js's
 * prefixes (`nxtPprojectId`), which a param left out of the list would let through to the page.
 */
function malformedParams(route: RegisteredRoute): string | undefined {
  const kinds = route.route.split('/').map((segment) => dynamicSegmentOf(segment)?.kind);
  if (kinds.some((kind) => kind !== undefined && kind !== 'dynamic')) {
    return 'has a catch-all, which the compile registers no route of';
  }
  const params = paramsOfRoute(route.route);
  const twice = params.find((param, index) => params.indexOf(param) !== index);
  if (twice !== undefined) {
    return `names the param ${JSON.stringify(twice)} in two of its segments: Next.js serves no path of it, and a request's params hold one value of each name`;
  }
  // Read as the module it was imported of has it, whatever its type says.
  const named: unknown = route.params;
  return Array.isArray(named) &&
    named.length === params.length &&
    named.every((param, index) => param === params[index])
    ? undefined
    : "names other params than its path's";
}

/** Why `route` is none the authority can serve, or nothing when it is one. */
function malformedRoute(
  route: RouteRegistration,
  registry: Registry,
  middleware: ReadonlyMap<string, MiddlewareProgram | null>,
): string | undefined {
  if (typeof route.route !== 'string' || !route.route.startsWith('/')) {
    return 'names no route';
  }
  if (!registry.programs.has(route.root)) {
    return `renders ${route.root}, which the authority does not run`;
  }
  const wrongParams = malformedParams(route);
  if (wrongParams !== undefined) {
    return wrongParams;
  }
  const params = new Set(paramsOfRoute(route.route));
  const given = Object.values(route.props);
  if (given.some((param) => !params.has(param))) {
    return 'gives its root a prop of no param of its path';
  }
  const chain = malformedChain(route, middleware);
  if (chain !== undefined) {
    return chain;
  }
  // A shared view is one of all the path's params, as the gate reads them: a generation is
  // rendered with the props of them, which a root given fewer cannot render.
  const ungiven = paramsOfRoute(route.route).filter((param) => !given.includes(param));
  return route.shared && ungiven.length > 0
    ? `is shared, but its root is not given every param of its path (${ungiven.join(', ')}): a view every visitor shares is one of all of them`
    : undefined;
}

/** Whether `values` are text, each of them, and at least one. */
function isNamesList(values: unknown): values is readonly string[] {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value: unknown) => typeof value === 'string')
  );
}

/**
 * Why `route`, a route of no reactive root, is none the authority can guard, or nothing when it is
 * one: a route of one page — no catch-all — its params its path's, in order, under middleware, of a
 * guard of the authority's where it says it has one, and of none where it says it has none.
 */
function malformedPlain(
  route: PlainRouteRegistration,
  middleware: ReadonlyMap<string, MiddlewareProgram | null>,
): string | undefined {
  if (typeof route.route !== 'string' || !route.route.startsWith('/')) {
    return 'names no route';
  }
  // Read as the module it was imported of has it, whatever its type says.
  const what: unknown = route.plain;
  if (what !== 'page' && what !== 'handler') {
    return 'is neither a page nor a route handler';
  }
  const wrongParams = malformedParams(route);
  if (wrongParams !== undefined) {
    return wrongParams;
  }
  if (!isNamesList(route.middleware)) {
    return 'is under no route middleware, which a route of no reactive root is registered under';
  }
  const chain = malformedChain(route, middleware);
  if (chain !== undefined) {
    return chain;
  }
  return 'root' in route || 'props' in route || 'shared' in route
    ? 'is of no reactive root, and names one'
    : undefined;
}

/** The names of a route's dynamic segments, in order. */
function paramsOfRoute(route: string): readonly string[] {
  return route.split('/').flatMap((segment) => {
    const param = paramOfSegment(segment);
    return param === undefined ? [] : [param];
  });
}

/** The registry being made: its maps, which `register` takes each route into. */
interface Registering {
  readonly middleware: ReadonlyMap<string, MiddlewareProgram | null>;
  readonly routes: Map<string, RouteRegistration>;
  readonly plain: Map<string, PlainRouteRegistration>;
}

/** Checks `route` against what the authority runs, and takes it into `into`: refuses it otherwise. */
function register(
  route: RegisteredRoute,
  into: Registering,
  context: { readonly options: RouteOptions; readonly registry: Registry },
): void {
  const wrong = isPlainRoute(route)
    ? malformedPlain(route, into.middleware)
    : malformedRoute(route, context.registry, into.middleware);
  if (wrong !== undefined) {
    throw new Error(`The route ${JSON.stringify(route.route)} ${wrong}.`);
  }
  const name = route.route;
  if (into.plain.has(name) || into.routes.has(name)) {
    throw new Error(`The route ${JSON.stringify(name)} is registered twice: a route is one page.`);
  }
  if (isPlainRoute(route)) {
    into.plain.set(name, route);
  } else {
    // A root is found by its component alone (`routeOfRoot`), as the compile names one route of each.
    for (const owner of into.routes.values()) {
      if (owner.root === route.root) {
        throw new Error(
          `The route ${JSON.stringify(name)} renders the root ${JSON.stringify(route.root)}, which the route ${JSON.stringify(owner.route)} renders too: a root is one route's — its params, its guards and its shared view.`,
        );
      }
    }
    const shared = context.options.shareViews === false ? { ...route, shared: false } : route;
    into.routes.set(name, shared);
  }
}

/** What a compile registered, checked against the programs the authority runs. */
export function routeRegistryOf(options: RouteOptions, registry: Registry): RouteRegistry {
  const into: Registering = {
    middleware: middlewareOf(options.middleware ?? {}, registry.buildId),
    plain: new Map(),
    routes: new Map(),
  };
  if (options.routes !== undefined) {
    for (const route of options.routes) {
      register(route, into, { options, registry });
    }
  }
  return into;
}

/**
 * The params of `route` a pathname names, as Next.js hands them to the route's page (`pageParamOf`):
 * `/boards/caf%c3%a9` and `/boards/café` both `caf%C3%A9`, the props of the root its page renders;
 * nothing where the pathname is not of the route. A route's static segments are matched as its
 * folders name them — a pathname's segment as it is, or decoded, as a URL encodes one (`/caf%C3%A9`
 * of `/café`, `segmentNames`) — and each dynamic one takes one segment, of a param a page is handed:
 * none that decodes to nothing, `.` or `..`, which Next.js resolves as another path before any
 * route. Each param is the map's own, whatever its name: `constructor` too.
 */
export function paramsOfPath(route: string, pathname: string): RouteParams | undefined {
  const pattern = route === '/' ? [''] : route.split('/').slice(1);
  const segments = pathname === '/' ? [''] : pathname.split('/').slice(1);
  if (segments.length !== pattern.length) {
    return undefined;
  }
  const params: [string, string][] = [];
  for (const [index, segment] of pattern.entries()) {
    const given = segments[index] ?? '';
    const param = paramOfSegment(segment);
    if (param === undefined) {
      if (!segmentNames(given, segment)) {
        return undefined;
      }
      continue;
    }
    const value = pageParamOf(given);
    if (value === undefined) {
      return undefined;
    }
    params.push([param, value]);
  }
  return Object.fromEntries(params);
}

/** The props a route's root is rendered with, of the route's params: each the map's own. */
export function rootPropsOf(
  route: RouteRegistration,
  params: RouteParams,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(route.props).flatMap(([prop, param]) => {
      const value = ownValueOf(params, param);
      return value === undefined ? [] : [[prop, value]];
    }),
  );
}

/** Whether `params` are exactly the params `route` has: no other, none missing. */
function holdsParams(route: RouteRegistration, params: RouteParams): boolean {
  const names = paramsOfRoute(route.route);
  const given = Object.keys(params);
  return (
    given.length === names.length &&
    names.every((name) => typeof ownValueOf(params, name) === 'string')
  );
}

/**
 * The params a root's props give its route, each the map's own; none where they do not give every
 * one of them, or give one no page is handed (`isPageParam`): a page renders its root of the params
 * Next.js hands it, and a view of others would be asked for at a path no page of them answers.
 */
export function paramsOfProps(
  route: RouteRegistration,
  props: Readonly<Record<string, unknown>>,
): RouteParams | undefined {
  const params: [string, string][] = [];
  for (const [prop, param] of Object.entries(route.props)) {
    const value = ownValueOf(props, prop);
    if (typeof value !== 'string' || !isPageParam(value)) {
      return undefined;
    }
    params.push([param, value]);
  }
  const held = Object.fromEntries(params);
  return holdsParams(route, held) ? held : undefined;
}

/**
 * The params of the view a page's render of `route`'s root is of: where the props the page renders
 * it with are those the view renders it with (`rootPropsOf`), each a param a page is handed
 * (`paramsOfProps`), and nothing besides. None where the page gave the root anything else — a prop
 * of no param, as another page may: a search param's value, a constant — or a param's prop of no
 * such text: the view of its params alone renders the root without what that page gave it.
 */
export function viewParamsOf(
  route: RouteRegistration,
  props: Readonly<Record<string, unknown>>,
): RouteParams | undefined {
  const params = paramsOfProps(route, props);
  if (params === undefined) {
    return undefined;
  }
  const shown = rootPropsOf(route, params);
  const given = Object.keys(props);
  return given.length === Object.keys(shown).length &&
    given.every((prop) => ownValueOf(shown, prop) === ownValueOf(props, prop))
    ? params
    : undefined;
}
