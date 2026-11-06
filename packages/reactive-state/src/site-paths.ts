import type { SiteShape } from './routing.ts';

/**
 * A route's path as a site serves it, and back (`SiteShape`): under the site's base path, and in its
 * trailing-slash form — `/boards/p1` served at `/docs/boards/p1/` under `basePath: '/docs'` and
 * `trailingSlash: true`, the root at `/docs/`, and `/rss.xml`, whose last segment names a file, with
 * no slash (`slashFormOf`). Next.js redirects any other form of a path, or does not serve it, and so
 * neither is a route's page — but where it makes none of those redirects
 * (`skipTrailingSlashRedirect`), which serves each path at either form.
 */

/** A site that serves its routes at their own paths: no base path, and no trailing slash. */
export const PLAIN_SITE: SiteShape = Object.freeze({ basePath: '', trailingSlash: false });

/** Whether `known` says what `told` says: none says nothing. */
export function sameSite(known: SiteShape | undefined, told: SiteShape): boolean {
  return (
    known?.basePath === told.basePath &&
    known.trailingSlash === told.trailingSlash &&
    known.skipTrailingSlashRedirect === told.skipTrailingSlashRedirect
  );
}

/**
 * Whether a pathname's segment `given` names `name`, a segment as a route or a base path writes it:
 * as it is, or as a URL encodes it (`caf%C3%A9`, of `café`) — a malformed encoding names nothing.
 */
export function segmentNames(given: string, name: string): boolean {
  if (given === name) {
    return true;
  }
  try {
    return decodeURIComponent(given) === name;
  } catch {
    return false;
  }
}

/**
 * What a segment of a URL's path cannot hold as it is, each escaped where one is spelled: what the
 * URL parser escapes itself — a control, a space, `"`, `<`, `>`, `^`, `` ` ``, `{`, `}`, and past the
 * printable ASCII — and what it would read as another part of the URL, or of another segment: `#`,
 * `?`, `/`, `\` (a `/` to it), and `%`, which would spell another character with what follows it.
 * The delivery route spells a param by the same (`deliver.ts`).
 */
const PATH_ESCAPED = /[^\u{21}-\u{7E}]|["#%/<>?\\^`{}]/gu;

/**
 * A segment of a path that spells `name`, a folder's, as a browser's URL parser makes of it, and
 * escaping what it would read otherwise (`PATH_ESCAPED`): `foo#bar` is `foo%23bar` — never a path cut
 * short at `#` — `café` `caf%C3%A9`, and `a:b` as it is.
 */
export function spelledSegment(name: string): string {
  return name.replaceAll(PATH_ESCAPED, (char) => encodeURIComponent(char));
}

/**
 * Segments no page is handed as a param, however a path encodes them: none, and those the URL parser
 * reads as a step of the path itself (`.`, `..`; `%2E%2E` as well) — Next.js resolves `/boards/..`
 * and `/boards/%2E%2E` as `/`, and redirects `/boards/.` to `/boards`, before it matches a route.
 */
const NO_PARAMS: ReadonlySet<string> = new Set(['', '.', '..']);

/**
 * The param Next.js hands a page for a segment of its path, `segment`: decoded, as its router's
 * matcher decodes one (`getRouteMatcher`), and encoded again, as its app render passes a param to
 * user code (`getDynamicParam`) — `caf%C3%A9` of `café`, `caf%c3%a9` and `caf%C3%A9` alike, and
 * `a%2Fb` of `a%2Fb`, a slash in it kept in its segment. None where the segment is malformed, or
 * decodes to what no page is handed (`NO_PARAMS`).
 */
export function pageParamOf(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    return NO_PARAMS.has(decoded) ? undefined : encodeURIComponent(decoded);
  } catch {
    return undefined;
  }
}

/**
 * Whether `value` is a param as Next.js hands one to a page (`pageParamOf`): the segment of a path
 * that spells it, as it is — a value that is not names no page.
 */
export function isPageParam(value: string): boolean {
  return pageParamOf(value) === value;
}

/**
 * What of `pathname` is under `basePath`, from the slash after it — `/` for the base path itself —
 * each of the base path's segments named as `segmentNames` reads one; none for a path outside it.
 */
export function underBasePath(basePath: string, pathname: string): string | undefined {
  if (basePath === '') {
    return pathname;
  }
  const based = basePath.split('/').slice(1);
  const segments = pathname.split('/').slice(1);
  if (based.some((name, index) => !segmentNames(segments[index] ?? '', name))) {
    return undefined;
  }
  const rest = segments.slice(based.length);
  return rest.length === 0 ? '/' : `/${rest.join('/')}`;
}

/**
 * A path under `/.well-known` at the root of the whole path, in any case — as Next.js's router
 * matches its rules (`sensitive: false`) — which its trailing-slash redirects leave alone. They are
 * added after the base path is put before every other rule's source (`processRoutes`), and so are
 * matched against the whole path, the base path in it: under a base path `/docs`,
 * `/docs/.well-known/keys` is redirected as any path is.
 */
const WELL_KNOWN = /^\/\.well-known/iu;
/**
 * A last segment Next.js reads as a file's name: a dot, and a word after it — `rss.xml`, `a.txt`,
 * not `v1.2-beta` — as its redirect that takes a slash off one reads it (`[^/]+\.\w+`).
 */
const NAMES_FILE = /^[^/]+\.\w+$/u;

/** How a site under `trailingSlash` serves a path: with a slash after it, without one, or either. */
type SlashForm = 'bare' | 'either' | 'slashed';

/**
 * How a site of `shape` serves `bare` — a path whole, its base path in it, without a slash after
 * it — as Next.js 16.4.2's redirects decide (`loadCustomRoutes`): none of a slash's without
 * `trailingSlash`; with it, the base path's own root with one, which a redirect of its own gives it;
 * and, each matched against the whole path, a slash where its last segment holds no dot, which the
 * one that gives a path its slash redirects to, none where its last segment names a file
 * (`NAMES_FILE`), which the one that takes the slash off redirects to, and either way where neither
 * matches — a dot in a name of no file's, or a path under `/.well-known` at its root (`WELL_KNOWN`).
 * A base path that names a file has its root redirected both ways, and served at neither.
 */
function slashFormOf(shape: SiteShape, bare: string): SlashForm {
  if (!shape.trailingSlash) {
    return 'bare';
  }
  if (shape.basePath !== '' && bare === shape.basePath) {
    return 'slashed';
  }
  if (WELL_KNOWN.test(bare)) {
    return 'either';
  }
  const last = bare.slice(bare.lastIndexOf('/') + 1);
  if (!last.includes('.')) {
    return 'slashed';
  }
  return NAMES_FILE.test(last) ? 'bare' : 'either';
}

/**
 * The path a site of `shape` serves the route path `path` at: under its base path, with a slash
 * after it where Next.js gives a path one (`slashFormOf`) — the root under a base path among them,
 * which a redirect of its own gives one — and none anywhere else.
 */
export function sitePathOf(shape: SiteShape, path: string): string {
  const { basePath } = shape;
  const based = basePath === '' || path !== '/' ? `${basePath}${path}` : basePath;
  return !based.endsWith('/') && slashFormOf(shape, based) === 'slashed' ? `${based}/` : based;
}

/**
 * The route path a site of `shape` serves at `pathname`; none for a path outside its base path, or
 * in a form of it Next.js redirects rather than serves: with a slash after it where the site gives
 * none, or the path names a file (`slashFormOf`), and without one where it gives one — of a site
 * that makes none of those redirects (`skipTrailingSlashRedirect`), either form.
 */
export function routePathOf(shape: SiteShape, pathname: string): string | undefined {
  if (pathname === '/') {
    return underBasePath(shape.basePath, pathname);
  }
  const slashed = pathname.endsWith('/');
  const bare = slashed ? pathname.slice(0, -1) : pathname;
  const form = shape.skipTrailingSlashRedirect === true ? 'either' : slashFormOf(shape, bare);
  if (form !== 'either' && (form === 'slashed') !== slashed) {
    return undefined;
  }
  return underBasePath(shape.basePath, bare);
}
