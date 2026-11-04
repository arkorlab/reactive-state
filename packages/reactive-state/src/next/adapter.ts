import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { NextAdapter, NextConfig } from 'next';

import {
  DELIVER_PATH,
  DELIVERY_KEY_ENV,
  DIRECT_HEADER,
  type DynamicSegment,
  dynamicSegmentOf,
  GATE_NAME,
  isPlainRoute,
  type PlainRouteRegistration,
  type RegisteredRoute,
  type RouteRegistration,
  routeKeyOf,
} from '../routing.ts';
import {
  compileProject,
  DEFAULT_OUT,
  DEFAULT_SRC,
  EDGE_GATE_ENV,
  layoutOf,
  PLATFORM_ADAPTER_ENV,
  type ProjectLayout,
} from './compile-on-build.ts';
import { type ConfigWritten, configWritten, NOTHING_WRITTEN } from './config-read.ts';
import {
  instantRule,
  type LoaderOptions,
  loaderOptionsOf,
  REACTIVE_SOURCES,
  reactiveRule,
  requirePageExtensions,
  requirePrefetchLife,
  type TurbopackRules,
  withPackage,
  withRule,
} from './config.ts';
import { deliveredBuildOf, rewritesOnto } from './rewrites-onto.ts';
import { refuseCaseShadows } from './route-case-shadows.ts';

/**
 * The Next.js adapter an application of reactive state is built through: what makes it need no
 * `next.config.ts` of its own. A platform's command names it in `NEXT_ADAPTER_PATH`, and the
 * platform's own adapter — the one the build would have gone through — in
 * `REACTIVE_STATE_PLATFORM_ADAPTER`, which this one wraps. As Next.js hands it the config it read,
 * it
 *
 * 1. compiles the application's components (`./compile-on-build.ts`): those under `src`, or under
 *    the `src` a `withReactiveState` the config already has was given; skipped where nothing the
 *    compile reads changed, and one process at a time — and refuses a config of other page
 *    extensions than Next.js's own, which the compile reads the app directory by;
 * 2. adds what the compile's output needs to the config: the Turbopack rule that hands a page the
 *    root entry for the component it imports — no second one where `withReactiveState` added it —
 *    this package among those Next.js compiles, and Cache Components with Partial Prefetching
 *    where the config does not say; a config that turns either off is refused, as a page's roots
 *    that read the request render in the holes of its static shell;
 * 3. lets each page the compile registered as blocking — one that awaits its params outside any
 *    `<Suspense>` to render a root of them — block, as Cache Components otherwise refuses it
 *    (`export const instant = false`, where the page says nothing of it);
 * 4. sends a request for a route with route middleware around it — a page of a reactive root or of
 *    none, a route handler — to the compile's route, which runs the middleware around it — a
 *    request that route makes of the page itself excepted,
 *    by the build's delivery key in its header, which no visitor has — where Next.js would match
 *    the page, and before the application's own rewrites there: a route of a dynamic segment once
 *    the pages and files that are no dynamic route's are looked up, one of none before them, under
 *    each spelling of its path it is served at, escaped as well as written (`pageSourceOf`);
 * 5. declares the gate that answers each route whose document may be one artifact for every
 *    visitor, for the platform's adapter to write into the deployment (`UPWIND_ROUTE_GATES`) —
 *    where the platform's command says its edge binds the gate (`EDGE_GATE_ENV`). An application
 *    with a proxy has none: the compile registers every route of it as the request's, as the proxy
 *    runs ahead of every request and may change any response;
 *
 * and then hands the config to the platform's adapter, as Next.js would have. Everything else of
 * the config stays as the application wrote it. As the build of an application with routes under
 * middleware completes, the adapter refuses it where a rewrite of the application's own may send a
 * request to one of them (`rewritesOnto`): Next.js serves the page a rewrite names as soon as it
 * matches, past the rewrite that delivers the route through its middleware.
 */

type ModifyConfig = NonNullable<NextAdapter['modifyConfig']>;
/** The config `modifyConfig` is handed, as Next.js declares it. */
type BuildConfig = Parameters<ModifyConfig>[0];
type ModifyContext = Parameters<ModifyConfig>[1];
/** What Next.js hands an adapter as a build completes. */
type BuildComplete = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];

/** What a config delivers through route middleware: its routes, by the key its rewrites carry. */
interface Delivering {
  readonly routes: readonly string[];
  readonly key: string;
}

/** What a config's rewrites answer: a list, or lists by when each is matched. */
type Rewrites = Awaited<ReturnType<NonNullable<NextConfig['rewrites']>>>;
type Rewrite = Extract<Rewrites, readonly unknown[]>[number];

/** The variable the platform's adapter reads the routes' gates from: a JSON object, by route. */
export const ROUTE_GATES_ENV = 'UPWIND_ROUTE_GATES';

const NAME = 'reactive-state';
/** The route the compile writes into the application (`<app>/api/reactive-state/[...path]`). */
const ROUTE_PATH = '/api/reactive-state';
/** The phases whose command reads the compile's output: a build's, and a development server's. */
const COMPILING_PHASES: ReadonlySet<string> = new Set([
  'phase-development-server',
  'phase-production-build',
]);
const BUILD_PHASE = 'phase-production-build';

/** The project Next.js builds: the directory it says, or the one it runs in where it says none. */
function projectDirOf(context: ModifyContext): string {
  const said: unknown = context.projectDir;
  return typeof said === 'string' && said !== '' ? said : process.cwd();
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Whether `value` is what each registered route is: its route, its params, its middleware. */
function isNamedRoute(
  value: unknown,
): value is Pick<RegisteredRoute, 'middleware' | 'params' | 'route'> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const route = value as Partial<Record<keyof RegisteredRoute, unknown>>;
  return typeof route.route === 'string' && isStrings(route.params) && isStrings(route.middleware);
}

function isRoute(value: unknown): value is RegisteredRoute {
  if (!isNamedRoute(value)) {
    return false;
  }
  if ('plain' in value) {
    const plain = value as Partial<Record<keyof PlainRouteRegistration, unknown>>;
    return (plain.plain === 'page' || plain.plain === 'handler') && typeof plain.file === 'string';
  }
  const route = value as Partial<Record<keyof RouteRegistration, unknown>>;
  return (
    typeof route.page === 'string' &&
    typeof route.root === 'string' &&
    typeof route.blocking === 'boolean' &&
    typeof route.shared === 'boolean'
  );
}

/**
 * The routes the compile registered (`<out>/manifest.json`): none where it registered none, or
 * where it has written nothing yet.
 */
function registeredRoutes(outDir: string): readonly RegisteredRoute[] {
  const file = path.join(outDir, 'manifest.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (isCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
  const routes = (manifest as { readonly routes?: unknown } | null)?.routes;
  if (routes === undefined) {
    return [];
  }
  if (!Array.isArray(routes) || !routes.every(isRoute)) {
    throw new Error(
      `${file} registers routes this adapter cannot read: it was written by another @arkorlab/reactive-state than the one that builds.`,
    );
  }
  return routes;
}

/** Why a config that turns `option` off is refused. */
function turnedOff(option: string, configFile: string): Error {
  return new Error(
    `${configFile} sets \`${option}: false\`, and @arkorlab/reactive-state renders with it: a page's reactive roots that read the request render in the holes Partial Prerendering leaves in its static shell. Remove the line; the adapter turns ${option} on where the config leaves it unset.`,
  );
}

/** Node.js's interop of a module's default export, as Next.js reads a config module. */
function defaultOf(module: unknown): unknown {
  const exported = (module as { readonly default?: unknown } | null)?.default;
  return exported ?? module;
}

/**
 * Why a config is refused that turns Cache Components off as Next.js read it, of which the adapter
 * cannot read whether the application turned it off: what it says is computed (`configWritten`).
 */
function unreadConfig(configFile: string): Error {
  return new Error(
    `${configFile} leaves Cache Components off as Next.js read it, and computes what it says — a function, a call, a spread, an option written as no literal — which @arkorlab/reactive-state does not run again to see whether it turned it off: Next.js has run it, and a run more may answer otherwise. Say \`cacheComponents: true\` in it; the adapter turns Cache Components on only where a config it reads leaves it unset.`,
  );
}

/** What each `next.config` read in this process writes, by its path and its text: one read of each. */
const configsWritten = new Map<string, ConfigWritten | undefined>();

/**
 * What the application's own `next.config` writes of the options the adapter turns on, read from
 * its source and never run again (`configWritten`): nothing where it has none; none where what it
 * says is computed.
 */
function writtenConfigOf(config: BuildConfig): ConfigWritten | undefined {
  const file: unknown = config.configFile;
  if (typeof file !== 'string') {
    return NOTHING_WRITTEN;
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const key = `${file}\0${text}`;
  if (!configsWritten.has(key)) {
    configsWritten.set(key, configWritten(file, text));
  }
  return configsWritten.get(key);
}

/**
 * Turns on Cache Components and Partial Prefetching where the application's config leaves them
 * unset, with what Next.js makes of `cacheComponents: true` as it reads a config — Next.js has
 * filled in its defaults by now, `false` among them, so whether the application said `false` is read
 * from its own config's source, which is never run again (`writtenConfigOf`). One that says `false`
 * to either is refused, and so is one whose source computes what it says.
 */
function requireCacheComponents(config: BuildConfig): void {
  const flags = config as { cacheComponents?: boolean; partialPrefetching?: boolean };
  if (flags.partialPrefetching === false) {
    throw turnedOff('partialPrefetching', config.configFileName);
  }
  if (flags.cacheComponents !== true) {
    const written = writtenConfigOf(config);
    if (written === undefined) {
      throw unreadConfig(config.configFileName);
    }
    if (written.cacheComponents === false) {
      throw turnedOff('cacheComponents', config.configFileName);
    }
    if (written.useCache === false) {
      throw turnedOff('experimental.useCache', config.configFileName);
    }
    flags.cacheComponents = true;
    // What Next.js derives from `cacheComponents: true` as it fills in a config's defaults: the
    // `'use cache'` directive — deprecated as an option of the application's, and still the flag
    // `cacheLife` and `cacheTag` read — and cached navigations unless the config says otherwise.
    // eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation -- see above
    config.experimental.useCache = true;
    if (!written.cachedNavigations) {
      config.experimental.cachedNavigations = true;
    }
  }
  flags.partialPrefetching ??= true;
}

/** The pages of the routes registered as blocking, each by its path from the project. */
function blockingPages(
  routes: readonly RegisteredRoute[],
  layout: ProjectLayout,
  projectDir: string,
): readonly string[] {
  return routes
    .flatMap((route) => (isPlainRoute(route) || !route.blocking ? [] : [route]))
    .map((route) =>
      path.relative(projectDir, path.join(layout.appDir, route.page)).split(path.sep).join('/'),
    );
}

/**
 * `rules`, with the rule for the components' sources where `loader` says there is none yet, and the
 * rule that lets `pages` block, under their file names.
 */
function rulesWith(
  rules: TurbopackRules | undefined,
  loader: LoaderOptions | undefined,
  pages: readonly string[],
): TurbopackRules {
  let next: TurbopackRules =
    loader === undefined ? { ...rules } : { ...rules, [REACTIVE_SOURCES]: reactiveRule(loader) };
  const byName = Map.groupBy(pages, (page) => path.posix.basename(page));
  for (const [name, files] of byName) {
    next = withRule(next, name, instantRule(files));
  }
  return next;
}

/** What path-to-regexp reads as syntax in a rewrite's source, each to be escaped. */
const PATTERN_SYNTAX = /[$()*+\-.:?[\\\]^{|}]/gu;
/** What a regular expression reads as syntax, escaped in a character of a path one is written of. */
const REGEX_SYNTAX = /[$()*+./?[\\\]^{|}]/gu;
const HEX = 16;
/** A path's slash, as a request may write it: as it is, or escaped (`%2F`, `%2f`). */
const SPELLED_SLASH = '(/|%2[fF])';

/** A hex digit's letter, as a pattern of either case of it: `[aA]`. */
function eitherCase(letter: string): string {
  return `[${letter}${letter.toLowerCase()}]`;
}

/** A byte, escaped as a path may write it: `%` and its two hex digits, a letter of either case. */
function escapedByte(byte: number): string {
  const hex = byte.toString(HEX).toUpperCase().padStart(2, '0');
  return `%${hex.replaceAll(/[A-F]/gu, (letter) => eitherCase(letter))}`;
}

/**
 * A character of a page's path, as each spelling of it a request may write: as it is, or each byte
 * of its UTF-8 escaped, the hex digits of either case (`p`, `%70`; `é`, `%C3%A9`, `%c3%a9`). Written
 * as an unnamed group of path-to-regexp's, which Next.js hands the destination nothing of
 * (`removeUnnamedParams`, `convertRewrites`), and whose pattern may not open with `?`.
 */
function spellingsOf(character: string): string {
  const escaped = [...new TextEncoder().encode(character)]
    .map((byte) => escapedByte(byte))
    .join('');
  const written = character.replaceAll(REGEX_SYNTAX, String.raw`\$&`);
  return `(${written}|${escaped})`;
}

/**
 * How path-to-regexp repeats the param of a dynamic segment of each kind (`dynamicSegmentOf`): one
 * segment, one or more, or any number.
 */
const REPEATS: Readonly<Record<DynamicSegment['kind'], string>> = {
  catchall: '+',
  dynamic: '',
  'optional-catchall': '*',
};
/**
 * The compile's own route, by the segments it is under (`api/reactive-state/[...path]`): what no
 * delivery rewrite may take a request of — an event stream, a sign-in, a delivery itself — as a
 * rewrite of a dynamic route runs before Next.js matches its dynamic routes, this one among them.
 */
const OWN_ROUTE: readonly string[] = ['api', 'reactive-state'];

/**
 * What the param of a route's segment at `index` matches, where it is the first of the route's
 * dynamic segments and every segment before it is the compile's own route's: a segment of the path
 * that opens none of that route's paths (`(?!reactive-state/)`, the rest of them from here). None
 * where the route could match no path of the compile's — it has another static segment there, or
 * too few segments.
 */
function keptOff(
  segments: readonly string[],
  index: number,
  sensitive: boolean,
): string | undefined {
  const before = segments.slice(0, index);
  const own = before.every(
    (segment, at) => (sensitive ? segment : segment.toLowerCase()) === OWN_ROUTE[at],
  );
  if (!own || index >= OWN_ROUTE.length || segments.length <= OWN_ROUTE.length) {
    return undefined;
  }
  return `((?!${OWN_ROUTE.slice(index).join('/')}/)[^/]+?)`;
}

/**
 * A segment of a route of a dynamic segment, as a rewrite's source matches it; its param's token
 * added to `tokens`. Every param is named by its place (`param0`), not as Next.js names it:
 * path-to-regexp holds no name of some (`[project-id]`, `[$project]`), and a name given by a place
 * may be another param's own (`/[$x]/[param0]`), which would take both segments' values. The
 * delivery route reads the params by their places alone, as the destination writes them. The first
 * dynamic segment is kept off the compile's own route (`keptOff`). A static segment is matched as
 * written: Next.js matches a dynamic route against the path as it came (`getRouteMatcher`), as
 * upwind's runtime does (`@next/routing`), so a spelling of it escaped is no path of the route —
 * `/%62oards/p1` is `/[section]/[id]`'s, where the application has that route, and a rewrite of
 * `/boards/[projectId]` taking it would deliver that page inside this route's middleware.
 */
function patternOf(
  segments: readonly string[],
  index: number,
  tokens: string[],
  sensitive: boolean,
): string {
  const segment = segments[index] ?? '';
  const dynamic = dynamicSegmentOf(segment);
  if (dynamic === undefined) {
    return segment.replaceAll(PATTERN_SYNTAX, String.raw`\$&`);
  }
  const name = `:param${String(tokens.length)}`;
  const kept =
    tokens.length === 0 && dynamic.kind === 'dynamic'
      ? keptOff(segments, index, sensitive)
      : undefined;
  tokens.push(`${name}${REPEATS[dynamic.kind]}`);
  return `${name}${kept ?? ''}${REPEATS[dynamic.kind]}`;
}

/**
 * The source of a route of no dynamic segment: its path under every spelling the page is served at.
 * Next.js looks a page up decoded as well as it came (`getItem`, `router-utils/filesystem.ts`), as
 * upwind's runtime does after it (`escapedNameOf`), while a rewrite matches the path as it came: a
 * page asked for as `/%70rojects`, or as `/caf%C3%A9` — how a browser asks for `/café` — would be
 * served past a rewrite of its path as written. So each character is matched as each spelling of it
 * (`spellingsOf`), each slash between two segments as written or escaped (`/account%2Fsettings`),
 * which both decode, and one escaped after the last, which upwind's runtime takes off as both take
 * off one written (`/projects%2F`) — that one in a group of its own (`{…}?`), as path-to-regexp
 * takes a slash before an optional group for the group's: the root's, the whole of its path.
 */
function pageSourceOf(segments: readonly string[]): string {
  const spelled = segments.map((segment) =>
    Array.from(segment, (character) => spellingsOf(character)).join(''),
  );
  return `/${spelled.join(SPELLED_SLASH)}{${SPELLED_SLASH}}?`;
}

/**
 * The rewrite that sends a request for `route` to the compile's route, which delivers it through
 * the route's middleware: the route and its params in the path below `deliver/`
 * (`routeKeyOf`), each param a segment as the request has it, a catch-all's its segments — the
 * path, as a handler is handed the URL the client asked for, not the one a rewrite made of it. The
 * request that route makes of the page itself carries `key` in `DIRECT_HEADER`, and is left to the
 * page; a request with any other value there is delivered like one with none.
 */
function deliveryOf(route: RegisteredRoute, key: string, sensitive: boolean): Rewrite {
  const tokens: string[] = [];
  const segments = route.route.split('/').slice(1);
  const source = isDynamic(route.route)
    ? `/${segments.map((_, index) => patternOf(segments, index, tokens, sensitive)).join('/')}`
    : pageSourceOf(segments);
  const params = tokens.map((token) => `/${token}`).join('');
  return {
    destination: `${ROUTE_PATH}/${DELIVER_PATH}/${routeKeyOf(route.route)}${params}`,
    missing: [{ key: DIRECT_HEADER, type: 'header', value: key }],
    source,
  };
}

/** Whether `route` has a dynamic segment, which Next.js matches after its pages and its files. */
function isDynamic(route: string): boolean {
  return route.split('/').some((segment) => dynamicSegmentOf(segment) !== undefined);
}

/** The rewrites of the routes under middleware, by when Next.js matches each. */
interface Deliveries {
  readonly beforeFiles: readonly Rewrite[];
  readonly afterFiles: readonly Rewrite[];
}

/**
 * `routes`, in the order Next.js matches them (`getSortedRoutes`, of the copy the application
 * depends on): of two that match one path, the one Next.js would serve it from first — `/admin/[id]`
 * before `/[section]/[id]` — so that its rewrite, not the other's, delivers it.
 */
function inNextOrder(
  routes: readonly RegisteredRoute[],
  projectDir: string,
): readonly RegisteredRoute[] {
  const fromProject = createRequire(path.join(projectDir, 'package.json'));
  const { getSortedRoutes } = fromProject('next/dist/shared/lib/router/utils/sorted-routes.js') as {
    readonly getSortedRoutes: (routes: readonly string[]) => readonly string[];
  };
  const order = getSortedRoutes(routes.map((route) => route.route));
  return routes.toSorted((a, b) => order.indexOf(a.route) - order.indexOf(b.route));
}

/**
 * The rewrites of `routes`, each matched where Next.js matches the route's page: a route of a
 * dynamic segment once the application's pages and files are looked up (`afterFiles`) and before
 * its dynamic routes are, so that a page, a route handler or a public file the rewrite's pattern
 * matches too (`/boards/new`, beside `/boards/[projectId]`) is served as itself, as Next.js serves
 * it — the routes in the order Next.js matches them (`inNextOrder`); a route of none before them
 * (`beforeFiles`), its page being one of them.
 */
function deliveriesOf(
  routes: readonly RegisteredRoute[],
  key: string,
  projectDir: string,
  sensitive: boolean,
): Deliveries {
  const dynamic = routes.filter((route) => isDynamic(route.route));
  return {
    afterFiles: inNextOrder(dynamic, projectDir).map((route) => deliveryOf(route, key, sensitive)),
    beforeFiles: routes
      .filter((route) => !isDynamic(route.route))
      .map((route) => deliveryOf(route, key, sensitive)),
  };
}

/** The application's rewrites, each where Next.js matches it, with `ours` before them in each. */
function withRewrites(
  own: NextConfig['rewrites'],
  ours: Deliveries,
): NonNullable<NextConfig['rewrites']> {
  return async () => {
    const theirs = typeof own === 'function' ? await own() : [];
    const grouped = Array.isArray(theirs) ? { afterFiles: theirs } : theirs;
    return {
      ...grouped,
      afterFiles: [...ours.afterFiles, ...(grouped.afterFiles ?? [])],
      beforeFiles: [...ours.beforeFiles, ...(grouped.beforeFiles ?? [])],
    };
  };
}

/** The gates `value` declares, by route: none where it is unset. */
function gatesOf(value: string | undefined): Record<string, string> {
  if (value === undefined || value === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${ROUTE_GATES_ENV} is not JSON.`, { cause: error });
  }
  const isGates =
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((name) => typeof name === 'string');
  if (!isGates) {
    throw new Error(`${ROUTE_GATES_ENV} is no JSON object of a gate's name by route.`);
  }
  return { ...(parsed as Record<string, string>) };
}

/**
 * Declares this package's gate for each route whose document may be one artifact for every visitor
 * and that no middleware is around — a route with middleware is delivered by the compile's route,
 * which asks the gate itself — beside the gates the environment declares already. A route the
 * environment has another gate answer is refused: the two cannot both answer it.
 *
 * None where the platform's command did not say its edge binds the gate (`EDGE_GATE_ENV`); nor in
 * an application with a proxy, of which the compile registers no route shared (`proxyOf`): the
 * edge would answer a gated route before the proxy ran.
 */
function declareGates(routes: readonly RegisteredRoute[]): void {
  const gated = routes.filter(
    (route) => !isPlainRoute(route) && route.shared && route.middleware.length === 0,
  );
  if (gated.length === 0 || process.env[EDGE_GATE_ENV] !== '1') {
    return;
  }
  const gates = gatesOf(process.env[ROUTE_GATES_ENV]);
  for (const { route } of gated) {
    const named = gates[route];
    if (named !== undefined && named !== GATE_NAME) {
      throw new Error(
        `${ROUTE_GATES_ENV} has the gate ${named} answer ${route}, which @arkorlab/reactive-state has its gate (${GATE_NAME}) answer.`,
      );
    }
    gates[route] = GATE_NAME;
  }
  process.env[ROUTE_GATES_ENV] = JSON.stringify(gates);
}

/** How many random bytes a build's delivery key is made of. */
const DELIVERY_KEY_BYTES = 32;

/**
 * The build's delivery key: the one its environment holds, or one made now and left in the
 * environment, where the build's other processes — each of which reads the config again — find it,
 * so that the rewrite each writes and the route Next.js compiles agree. Letters, digits, `-` and `_`
 * alone: a header's value, which a rewrite's condition reads as a pattern, matches it as written.
 */
function deliveryKey(): string {
  const held = process.env[DELIVERY_KEY_ENV];
  if (held !== undefined && /^[\w-]{16,}$/u.test(held)) {
    return held;
  }
  const made = randomBytes(DELIVERY_KEY_BYTES).toString('base64url');
  process.env[DELIVERY_KEY_ENV] = made;
  return made;
}

/** The options of the rule for the components' sources the config has already, if any. */
function configuredLoader(rules: TurbopackRules | undefined): LoaderOptions | undefined {
  const rule = rules?.[REACTIVE_SOURCES];
  if (rule === undefined) {
    return undefined;
  }
  const options = loaderOptionsOf(rule);
  if (options === undefined) {
    throw new Error(
      `turbopack.rules has a rule of its own for ${REACTIVE_SOURCES}, which @arkorlab/reactive-state sets: remove it.`,
    );
  }
  return options;
}

/**
 * `config`, with what the application's compile needs of it (see above), for `context`; and what it
 * delivers through route middleware, if anything.
 */
async function reactiveConfig(
  config: BuildConfig,
  context: ModifyContext,
): Promise<{ readonly config: BuildConfig; readonly delivering: Delivering | undefined }> {
  const projectDir = projectDirOf(context);
  // Typed as Next.js has filled in every option; one the application left out is still unset.
  const rules = (config.turbopack as NextConfig['turbopack'])?.rules;
  const configured = configuredLoader(rules);
  const loader = configured ?? { out: DEFAULT_OUT, root: projectDir, src: DEFAULT_SRC };
  // Next.js's own unless the application said others: it fills its default in.
  requirePageExtensions(config.pageExtensions, config.configFileName);
  requireCacheComponents(config);
  const { database, prefetch, session, share } = loader;
  requirePrefetchLife(prefetch, config, 'The reactive-state adapter');
  const project = {
    out: loader.out,
    projectDir: loader.root,
    src: loader.src,
    ...(database !== undefined && { database }),
    ...(session !== undefined && { session }),
    ...(prefetch !== undefined && { prefetch }),
    ...(share === 'off' && { share: false }),
  };
  if (COMPILING_PHASES.has(context.phase)) {
    await compileProject(project);
  }
  const layout = layoutOf(project);
  const routes = registeredRoutes(layout.outDir);
  config.transpilePackages = withPackage(config.transpilePackages);
  config.turbopack = {
    ...config.turbopack,
    rules: rulesWith(
      rules,
      configured === undefined ? loader : undefined,
      blockingPages(routes, layout, projectDir),
    ),
  };
  const delivered = routes.filter((route) => route.middleware.length > 0);
  let delivering: Delivering | undefined;
  if (delivered.length > 0) {
    const key = deliveryKey();
    config.env = { ...config.env, [DELIVERY_KEY_ENV]: key };
    const sensitive =
      (config.experimental as NextConfig['experimental'])?.caseSensitiveRoutes === true;
    const ours = deliveriesOf(delivered, key, projectDir, sensitive);
    if (!sensitive)
      refuseCaseShadows(
        delivered.map((route) => route.route),
        ours,
        layout,
      );
    config.rewrites = withRewrites(config.rewrites, ours);
    delivering = { key, routes: delivered.map((route) => route.route) };
  }
  if (context.phase === BUILD_PHASE) {
    declareGates(routes);
  }
  return { config, delivering };
}

/**
 * Refuses the build `context` completes where a rewrite of the application's own may send a
 * request to a route `delivering` delivers through its middleware (`rewritesOnto`), naming each
 * rewrite and the routes it may reach.
 */
function refuseRewritesOnto(context: BuildComplete, delivering: Delivering): void {
  const issues = rewritesOnto(deliveredBuildOf(context, delivering));
  if (issues.length > 0) {
    const listed = issues.map((issue) => `- ${issue}`).join('\n');
    throw new Error(
      `${context.config.configFileName} has rewrites that may send a request to a route under route middleware, whose page Next.js would serve past the rewrite that delivers it through its middleware:\n${listed}\nMake each a redirect, which the browser follows through the middleware, or rewrite to a path no route under route middleware serves.`,
    );
  }
}

/**
 * The adapter, around `inner` — the platform's own, whose `modifyConfig` is handed the config this
 * one made, and whose `onBuildComplete` is this one's — or alone, for a build that deploys nowhere.
 * Its `onBuildComplete` checks the application's rewrites first (`refuseRewritesOnto`), where the
 * config it made delivers routes through their middleware: one that delivers none — of no route
 * middleware — and deploys nowhere has none, and Next.js prepares no outputs for it.
 */
export function createReactiveAdapter(inner?: NextAdapter): NextAdapter {
  let delivering: Delivering | undefined;
  const complete = async (context: BuildComplete): Promise<void> => {
    if (delivering !== undefined) {
      refuseRewritesOnto(context, delivering);
    }
    await inner?.onBuildComplete?.(context);
  };
  const adapter: NextAdapter = {
    name: inner === undefined ? NAME : `${NAME}, ${inner.name}`,
    async modifyConfig(config, context) {
      const made = await reactiveConfig(config, context);
      ({ delivering } = made);
      if (delivering !== undefined) {
        adapter.onBuildComplete = complete;
      }
      return (await inner?.modifyConfig?.(made.config, context)) ?? made.config;
    },
  };
  if (inner?.onBuildComplete !== undefined) {
    adapter.onBuildComplete = complete;
  }
  return adapter;
}

function isAdapter(value: unknown): value is NextAdapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly name?: unknown }).name === 'string'
  );
}

/** The platform's adapter `REACTIVE_STATE_PLATFORM_ADAPTER` names, by its module's path; if any. */
async function platformAdapter(): Promise<NextAdapter | undefined> {
  const file = process.env[PLATFORM_ADAPTER_ENV];
  if (file === undefined || file === '') {
    return undefined;
  }
  const module: unknown = await import(pathToFileURL(path.resolve(file)).href);
  const adapter = defaultOf(module);
  if (!isAdapter(adapter)) {
    throw new Error(
      `${PLATFORM_ADAPTER_ENV} names ${file}, whose default export is no Next.js adapter.`,
    );
  }
  return adapter;
}

// `NEXT_ADAPTER_PATH` names a module whose default export is the adapter: this one, around the
// platform's adapter the environment names.
// eslint-disable-next-line import-x/no-default-export
export default createReactiveAdapter(await platformAdapter());
