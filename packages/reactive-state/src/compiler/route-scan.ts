import { type Dirent, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { dynamicSegmentOf, paramOfSegment } from '../routing.ts';
import { PAGE_EXTENSIONS } from './page-extensions.ts';
import { byCodeUnits } from './splice.ts';

/**
 * The application's routes as its app directory lays them out: each page and each route handler,
 * the route Next.js serves it at and the params it names, and what stands around it — the layouts,
 * templates and loading states of its directory and of each above it, and the route middleware
 * (`middleware.ts`) of each. The file system alone: what a page or a middleware holds,
 * `page-shape.ts` and `middleware.ts` read.
 */

/** The extensions a convention file of Next.js's is written with, as files end in them. */
const EXTENSIONS: ReadonlySet<string> = new Set(
  PAGE_EXTENSIONS.map((extension) => `.${extension}`),
);

/** What renders around a page in its document, as Next.js nests it: a layout, a template, a loading state or a server response boundary. */
type WrapperKind = 'forbidden' | 'layout' | 'loading' | 'not-found' | 'template' | 'unauthorized';

const WRAPPERS: ReadonlySet<string> = new Set<WrapperKind>([
  'forbidden',
  'layout',
  'loading',
  'not-found',
  'template',
  'unauthorized',
]);

/** The one name a route middleware is written under. */
const MIDDLEWARE = 'middleware.ts';

/** A middleware file of another extension, which is refused rather than left unread. */
const MIDDLEWARE_ELSEWISE = /^middleware\.(?:[cm]?[jt]s|[jt]sx)$/u;

/**
 * A metadata file Next.js answers as a route of its own where it is written as code
 * by its name: an icon, an image of a page — numbered or not — and a sitemap, wherever they stand.
 * Turbopack emits and serves multi-digit variants too, though the JavaScript
 * `isMetadataRouteFile` helper recognizes only one suffix digit.
 */
const METADATA_ROUTE = /^(?:(?:apple-icon|icon|opengraph-image|twitter-image)\d*|sitemap)$/u;

/** The metadata files Next.js reads as code in the app's own directory alone. */
const ROOT_METADATA_ROUTES: ReadonlySet<string> = new Set(['manifest', 'robots']);

/** A route as Next.js names it, and the params its dynamic segments name, in order. */
export interface RouteName {
  readonly route: string;
  readonly params: readonly string[];
}

/** A route file or slot fallback checked for roots; only pages and handlers have served routes. */
export interface RouteFile {
  readonly file: string;
  /** Its path under the app directory, `/`-separated: `boards/[projectId]/page.tsx`. */
  readonly page: string;
  /** Its directory's path under the app directory, `/`-separated: `''` for the app's own. */
  readonly directory: string;
  /**
   * The route it is served at, where a rewrite matches every request of it and no other: none in
   * a private folder, a parallel route's slot, an intercepting route or a catch-all.
   */
  readonly served: RouteName | undefined;
}

/** Pages and named-slot defaults enter root association; slot fallbacks register no route. */
export interface PageEntry extends RouteFile {
  /**
   * The route it is served at, where a page there may be registered as a reactive route: as
   * `served`, but none where a slot renders beside it, whose document holds what the slot renders.
   */
  readonly route: RouteName | undefined;
}

export interface WrapperFile {
  readonly file: string;
  readonly kind: WrapperKind;
}

export interface AppLayout {
  readonly pages: readonly PageEntry[];
  /** Each route handler (`route.ts`). */
  readonly handlers: readonly RouteFile[];
  /**
   * Each metadata file written as code — `opengraph-image.tsx`, `icon.tsx`, `sitemap.ts`,
   * `robots.ts` — which Next.js answers as a route of its own, at a path it names itself.
   */
  readonly metadata: readonly Pick<RouteFile, 'directory' | 'file'>[];
  /** Each `middleware.ts`, by its directory under the app directory: its id. */
  readonly middleware: ReadonlyMap<string, string>;
  /** The layouts, templates, loading states and server response boundaries of each directory, by its path under the app. */
  readonly wrappers: ReadonlyMap<string, readonly WrapperFile[]>;
  /** Each middleware file of another extension than `.ts`. */
  readonly misnamed: readonly string[];
  /**
   * The routes an intercepting route (`(.)photo`, `(..)photo`, `(...)photo`) stands in for on a
   * navigation, each written with its dynamic segments unnamed (`/boards/[]`), by the interceptor's
   * directory under the app directory.
   */
  readonly intercepted: ReadonlyMap<string, string>;
}

/** A route written with its dynamic segments unnamed, as an interceptor's target is compared. */
export function unnamedRoute(route: string): string {
  return route
    .split('/')
    .map((segment) => (segment.startsWith('[') ? '[]' : segment))
    .join('/');
}

/**
 * Whether a segment is a route group's, `(marketing)` or `(release.v2)`, which names no part of the
 * route: one Next.js reads so (`isGroupSegment`), opened by `(` and closed by `)`, whatever is
 * between. A complete group takes precedence over an interception marker: `(.)` and `(.)foo)`
 * both name no segment, as Next.js reads them.
 */
function isGroup(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')');
}

/** Whether a segment names a part of the route: no route group's, no slot's. */
function namesSegment(segment: string): boolean {
  return !isGroup(segment) && !segment.startsWith('@');
}

/**
 * An intercepting segment's levels up — `(.)` none, `(..)` one each, `(...)` the root — and the
 * rest: a segment one of Next.js's markers opens (`INTERCEPTION_ROUTE_MARKERS`: `(.)`, `(..)`,
 * `(..)(..)`, `(...)`), none for any other.
 */
function interceptionOf(
  segment: string,
): { readonly up: number; readonly rest: string } | undefined {
  if (isGroup(segment)) {
    return undefined;
  }
  if (segment.startsWith('(...)')) {
    return { rest: segment.slice('(...)'.length), up: Infinity };
  }
  if (segment.startsWith('(.)')) {
    return { rest: segment.slice('(.)'.length), up: 0 };
  }
  let up = 0;
  let rest = segment;
  while (rest.startsWith('(..)')) {
    up += 1;
    rest = rest.slice('(..)'.length);
  }
  return up === 0 ? undefined : { rest, up };
}

/**
 * The route the intercepting route in `directory` stands in for, unnamed (`unnamedRoute`): the
 * route segments above its interceptor's, as many levels up as it says, then its own and those
 * below it — route groups and slots, which name no segment, left out.
 */
function interceptedBy(directory: string): string | undefined {
  const segments = directory.split('/');
  const at = segments.findIndex((segment) => interceptionOf(segment) !== undefined);
  const interception = at === -1 ? undefined : interceptionOf(segments[at] ?? '');
  if (interception === undefined) {
    return undefined;
  }
  const above = segments.slice(0, at).filter((each) => namesSegment(each));
  const kept = above.slice(0, Math.max(0, above.length - interception.up));
  const below = [interception.rest, ...segments.slice(at + 1)].filter((each) => namesSegment(each));
  return unnamedRoute(underscored(`/${[...kept, ...below].join('/')}`));
}

/** `file`'s path under `directory`, its parts joined by `/` on every system: `''` for the directory. */
function underDirectory(directory: string, file: string): string {
  return path.relative(directory, file).split(path.sep).join('/');
}

/** What a segment of a page's directory makes of its route. */
type SegmentKind = 'group' | 'param' | 'static' | 'unroutable';

/**
 * What a segment makes of the route, as Next.js reads it: a private folder (`_folder`), a parallel
 * route's slot (`@slot`) and an intercepting route (`interceptionOf`) none this compile registers;
 * a route group (`isGroup`) no part of it; a dynamic segment a param; any other segment itself, as
 * it is written, parentheses and all (`v(2)`).
 */
function segmentKind(segment: string): SegmentKind {
  if (segment.startsWith('_') || segment.startsWith('@') || interceptionOf(segment) !== undefined) {
    return 'unroutable';
  }
  if (isGroup(segment)) {
    return 'group';
  }
  // A dynamic segment of one param, by any name Next.js takes — as the authority reads a path by it
  // (`paramOfSegment`) — is the route's; a catch-all, `[...slug]`, none.
  if (segment.startsWith('[')) {
    return paramOfSegment(segment) === undefined ? 'unroutable' : 'param';
  }
  return 'static';
}

/**
 * A segment of a folder's name as Next.js serves it: each `%5F` an underscore
 * (`UnderscoreNormalizer`), the escape that lets a folder name a segment `_admin` — `%5Fadmin` —
 * where `_admin` would be a private folder. Read of the whole path, a dynamic segment's name too.
 */
function underscored(segment: string): string {
  return segment.replaceAll('%5F', '_');
}

/**
 * The route a page or a route handler in `directory` (its path under the app directory) is served
 * at: route groups left out, `/` for the app's own, each dynamic segment as written, each `%5F` an
 * underscore (`underscored`); none where no rewrite places it exactly (`unplacedSegment`), or
 * Next.js serves nothing of it (`isPrivate`).
 */
function routeOf(directory: string): RouteName | undefined {
  const kept: string[] = [];
  const params: string[] = [];
  const segments = directory === '' ? [] : directory.split('/');
  for (const segment of segments) {
    const kind = segmentKind(segment);
    if (kind === 'unroutable') {
      return undefined;
    }
    if (kind === 'group') {
      continue;
    }
    const served = underscored(segment);
    const param = paramOfSegment(served);
    if (param !== undefined) {
      params.push(param);
    }
    kept.push(served);
  }
  return { params, route: `/${kept.join('/')}` };
}

/**
 * The first segment of `directory` no rewrite places a route by: a parallel route's slot, an
 * intercepting route, a catch-all, a dynamic segment Next.js refuses; none where it has none.
 */
export function unplacedSegment(directory: string): string | undefined {
  const segments = directory === '' ? [] : directory.split('/');
  return segments.find((segment) => segmentKind(segment) === 'unroutable');
}

/**
 * The names of a dynamic segment Next.js hands a page no param of: it matches a path's params into
 * an object by assignment, where `__proto__` sets the object's prototype rather than a param.
 */
const UNHELD_PARAMS: ReadonlySet<string> = new Set(['__proto__']);

/**
 * The first segment of `directory` that is a dynamic segment of a name Next.js hands no param of
 * (`[__proto__]`): a page under it is given nothing of the path, every path of the route alike.
 */
export function unheldSegment(directory: string): string | undefined {
  return directory.split('/').find((segment) => {
    const name = dynamicSegmentOf(underscored(segment))?.name;
    return name !== undefined && UNHELD_PARAMS.has(name);
  });
}

/**
 * Whether `directory` is in a private folder (`_folder`), or is one: what Next.js serves no route
 * of, whatever it holds.
 */
export function isPrivate(directory: string): boolean {
  return directory.split('/').some((segment) => segment.startsWith('_'));
}

/**
 * The route a page or a route handler in `directory` answers, as Next.js matches it
 * (`normalizeAppPath`): its segments but route groups and parallel routes' slots, each dynamic one
 * as written, catch-alls among them, each `%5F` an underscore (`underscored`); none for an
 * intercepting route, which answers no path of its own, or a private folder.
 */
export function matchedRouteOf(directory: string): string | undefined {
  const segments = directory === '' ? [] : directory.split('/');
  if (isPrivate(directory) || segments.some((segment) => interceptionOf(segment) !== undefined)) {
    return undefined;
  }
  const kept = segments.filter((segment) => !isGroup(segment) && !segment.startsWith('@'));
  return underscored(`/${kept.join('/')}`);
}

/** `directory` and each directory above it, up to the app's own, outermost first: `['', 'a', 'a/b']`. */
function directoriesAlong(directory: string): readonly string[] {
  const segments = directory === '' ? [] : directory.split('/');
  return ['', ...segments.map((_, index) => segments.slice(0, index + 1).join('/'))];
}

/** The ids of the route middleware around a page in `directory`, outermost first. */
export function chainOf(directory: string, layout: AppLayout): readonly string[] {
  return directoriesAlong(directory).filter((each) => layout.middleware.has(each));
}

/** The layouts, templates, loading states and server response boundaries around a page in `directory`, outermost first. */
export function wrappersOf(directory: string, layout: AppLayout): readonly WrapperFile[] {
  return directoriesAlong(directory).flatMap((each) => layout.wrappers.get(each) ?? []);
}

/**
 * Whether the app's walk passes an entry by, as Next.js walks the app directory
 * (`collectAppFiles`, and Turbopack its own way alike): a private folder or file, by its name
 * (`_folder`) — and what the compile writes (`outDir`). Nothing else: Next.js 16.4.2 serves the
 * routes under a folder of a leading dot (`.well-known`), under `node_modules`, and under a link to
 * a folder, as it serves any other's — and a `%5F` folder's under `_` (`underscored`).
 */
function skipped(full: string, name: string, outDir: string): boolean {
  return full === outDir || name.startsWith('_');
}

/**
 * What an entry the walk met is, as Next.js's walk takes it: a link for what it links to, none
 * where it links to nothing it can reach.
 */
function reached(entry: Dirent, full: string): Pick<Dirent, 'isDirectory' | 'isFile'> | undefined {
  if (!entry.isSymbolicLink()) {
    return entry;
  }
  try {
    return statSync(full);
  } catch {
    return undefined;
  }
}

interface Walk {
  readonly appDir: string;
  readonly outDir: string;
  readonly pages: { readonly file: string; readonly directory: string }[];
  readonly handlers: { readonly file: string; readonly directory: string }[];
  readonly metadata: { readonly file: string; readonly directory: string }[];
  readonly middleware: Map<string, string>;
  readonly wrappers: Map<string, WrapperFile[]>;
  readonly misnamed: string[];
  /** The directories a parallel route's slot (`@slot`) is in. */
  readonly slotted: Set<string>;
}

/** What one file of the app directory is to the routes, recorded in `walk`. */
function recordFile(walk: Walk, file: string, directory: string): void {
  const name = path.basename(file);
  if (name === MIDDLEWARE) {
    walk.middleware.set(directory, file);
    return;
  }
  if (MIDDLEWARE_ELSEWISE.test(name)) {
    walk.misnamed.push(file);
    return;
  }
  const extension = path.extname(name);
  if (!EXTENSIONS.has(extension)) {
    return;
  }
  const base = name.slice(0, -extension.length);
  const slotDefault =
    base === 'default' && directory.split('/').some((segment) => segment.startsWith('@'));
  if (base === 'page' || slotDefault) {
    walk.pages.push({ directory, file });
  } else if (base === 'route') {
    walk.handlers.push({ directory, file });
  } else if (METADATA_ROUTE.test(base) || (directory === '' && ROOT_METADATA_ROUTES.has(base))) {
    walk.metadata.push({ directory, file });
  } else if (WRAPPERS.has(base)) {
    const kind = base as WrapperKind;
    walk.wrappers.set(directory, [...(walk.wrappers.get(directory) ?? []), { file, kind }]);
  }
}

/**
 * Walks `directory`, under the folders `above` it the walk is in, by their own paths: a link to one
 * of them walked no further, which Next.js's walk would follow without end.
 */
function visit(walk: Walk, directory: string, above: ReadonlySet<string> = new Set()): void {
  let entries;
  let real;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
    real = realpathSync(directory);
  } catch {
    return;
  }
  if (above.has(real)) {
    return;
  }
  const along = new Set([...above, real]);
  const relative = underDirectory(walk.appDir, directory);
  const sorted = entries.toSorted((a, b) => byCodeUnits(a.name, b.name));
  for (const entry of sorted) {
    const full = path.join(directory, entry.name);
    const kind = skipped(full, entry.name, walk.outDir) ? undefined : reached(entry, full);
    if (kind?.isDirectory() === true) {
      if (entry.name.startsWith('@')) {
        walk.slotted.add(relative);
      }
      visit(walk, full, along);
    } else if (kind?.isFile() === true) {
      recordFile(walk, full, relative);
    }
  }
}

/** A page or a route handler the walk of `appDir` found, where Next.js serves it. */
function routeFileOf(
  appDir: string,
  { directory, file }: { readonly file: string; readonly directory: string },
): RouteFile {
  return { directory, file, page: underDirectory(appDir, file), served: routeOf(directory) };
}

/**
 * The pages, the route handlers, the middleware and what renders around each page under `appDir`,
 * in a stable order: what Next.js serves routes of, nothing of a private folder's or of what the
 * compile writes (`outDir`) (`skipped`).
 */
export function scanApp(appDir: string, outDir: string): AppLayout {
  const walk: Walk = {
    appDir,
    handlers: [],
    metadata: [],
    middleware: new Map(),
    misnamed: [],
    outDir,
    pages: [],
    slotted: new Set(),
    wrappers: new Map(),
  };
  visit(walk, appDir);
  const pages = walk.pages.map((each): PageEntry => {
    const routeFile = routeFileOf(appDir, each);
    // A route that renders a parallel route's slot beside its page holds what the slot renders too.
    const slotted = directoriesAlong(each.directory).some((one) => walk.slotted.has(one));
    return { ...routeFile, route: slotted ? undefined : routeFile.served };
  });
  const intercepted = new Map<string, string>();
  for (const { directory } of walk.pages) {
    const target = interceptedBy(directory);
    if (target !== undefined) {
      intercepted.set(directory, target);
    }
  }
  return {
    handlers: walk.handlers
      .map((each) => routeFileOf(appDir, each))
      .toSorted((a, b) => byCodeUnits(a.page, b.page)),
    intercepted,
    metadata: walk.metadata.toSorted((a, b) => byCodeUnits(a.file, b.file)),
    middleware: walk.middleware,
    misnamed: walk.misnamed.toSorted(byCodeUnits),
    pages: pages.toSorted((a, b) => byCodeUnits(a.page, b.page)),
    wrappers: walk.wrappers,
  };
}
