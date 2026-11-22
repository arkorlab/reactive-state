import { isDecoded, readsAsWritten } from '../content-coding.ts';
import {
  ADMISSION_HEADER,
  COMPILE_ROUTE_DIRECTORY,
  DIRECT_HEADER,
  type DynamicSegment,
  dynamicSegmentOf,
  type GateAnswer,
  GENERATION_HEADER,
  type GuardAnswer,
  isPlainRoute,
  type MiddlewareEnvelope,
  ownValueOf,
  type RegisteredRoute,
  type RouteParams,
  type RouteRegistration,
  routeKeyOf,
  type SiteShape,
} from '../routing.ts';
import { cacheDirectivesOf, SHARED_CACHE_HEADERS } from '../shared-cache.ts';
import { routePathOf, sitePathOf, spelledSegment, underBasePath } from '../site-paths.ts';
import { authority, routeSession, type SessionSource } from './authority.ts';
import { type GuardedAnswer, throughChain } from './chain.ts';
import { holdsKey, keptFromBody } from './delivery-key.ts';
import { siteShape } from './site.ts';

/**
 * A route under route middleware, delivered: every request for the route's page — its document, the
 * router's payloads and prefetches, a `HEAD`, a Server Action posted to it — reaches here, through
 * the rewrite the deployment adapter made of the route (`/api/reactive-state/deliver/<route>/…`),
 * and is answered inside the route's middleware's envelopes. A route whose document every visitor
 * shares is answered as its gate decides — the artifact, a 304, the generic 403, a 503 — and a
 * route of the request's whose middleware has a guard as its guards do, asked of for the request's
 * session first: the generic 403 where one refuses it, the response a guard answered itself, or a
 * 503 where the authority could not answer. Any other request is answered as the page renders it
 * for the request: the page asked for again here, with the request's method, its own headers — not
 * the hop's (`forwardedOf`) — and its body, and `x-reactive-direct` set to the build's delivery
 * key, the one value the rewrite lets through — at the route's own path (`originalUrl`), whatever
 * spelling of it brought the request, so that the page that answers is the route's, and its gate
 * and its guards are asked of that path. A visitor asking for the delivery route by its own path is
 * answered 404: such a request names whatever route it likes. The page's initial session render
 * reuses a matching, unexpired guard decision from delivery. Direct renders and later views run
 * their guards normally. A write — a Server Action posted to the route,
 * any request but a `GET` or a `HEAD` — is asked of the route's guards before it reaches the page,
 * shared or not, where a middleware of the route has a guard (`guarded`): one they refuse is
 * answered the generic 403, as the root rendered refused after it could not undo what it did. Where
 * none has one, nothing is asked, which could only let it on.
 *
 * A route of no reactive root under middleware (`PlainRouteRegistration`) — a page of none, a route
 * handler — is delivered as one of the request's is, every request of it, reads included, asked of
 * its guards first where it has any: no reactive render runs them for it. Whatever the route, the
 * page asked for again for a visitor is answered `private`, kept by no shared cache — a static
 * page's `s-maxage` dropped — as its envelopes ran for the request and its guards for the session.
 *
 * The authority's own request for a generation's artifact (`x-reactive-generation`) is the one
 * request the envelopes are not around: the artifact is every visitor's, and each visitor's request
 * for it is delivered in the envelopes again. A request is the authority's where the route's gate
 * lets its token through as a generation's — the Function holds no key to check one, the authority
 * does — and is handed to the page as it is, which has the authority render the generation. Any
 * other that names a generation — a write, a read of a route no visitor shares, one of a token the
 * gate does not let through — is delivered as any request is, the name taken off the page's.
 */

/** What a route handler is handed to deliver routes: what the compile registered of them. */
export interface Registry {
  readonly routes: readonly RegisteredRoute[];
  readonly envelopes: Readonly<Record<string, MiddlewareEnvelope>>;
  /**
   * How the application reads its own signed-in session, where it signs its users in itself: the
   * compile's (`<out>/request-session.ts`). Without it, a session is the demo's the cookie names.
   */
  readonly session?: SessionSource | undefined;
}

/** The delivery route's catch-all (`[...path]`), whose segments name a route and its params. */
const CATCH_ALL = 'path';
/** The compile's own route's path's segments (`api/reactive-state`), above its catch-all. */
const OWN_ROUTE: readonly string[] = COMPILE_ROUTE_DIRECTORY.split('/').slice(0, -1);
/** Next.js's prefixes of a route's params in a query (`nxtP`), and of an intercepted route's (`nxtI`). */
const PARAM_PREFIXES: readonly string[] = ['nxtP', 'nxtI'];
/**
 * The delivery route's own param, as a platform puts it in the query of the URL it hands the
 * route's handler: its catch-all, under either prefix. No other key is the platform's, of either
 * prefix or not: a visitor's `nxtPromo` is the page's. Each is matched by its name as the query is
 * read, however escaped (`visitorQuery`), as Next.js reads it.
 */
const PLATFORM_PARAMS: readonly string[] = PARAM_PREFIXES.map((prefix) => `${prefix}${CATCH_ALL}`);
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
/** The lowest status of an answer the authority could not give: unreachable, too slow, a fault. */
const HTTP_SERVER_ERROR = 500;
/** The directives of an answer the route makes itself, which nothing keeps: one visitor's. */
const UNKEPT = 'private, no-store';
const HTTP_UNAVAILABLE = 503;
/** The request's headers a route's gate reads. */
const GATE_HEADERS: readonly string[] = [
  'if-none-match',
  'next-router-prefetch',
  'next-router-segment-prefetch',
  'next-router-state-tree',
  'rsc',
];
/**
 * The build's delivery key (`DELIVERY_KEY_ENV`), which Next.js writes in as it compiles this module
 * from the config the adapter made; none in a build no adapter made, which has no route to deliver.
 */
function deliveryKey(): string | undefined {
  // Read by its whole name, as Next.js replaces it, rather than through `DELIVERY_KEY_ENV`.
  const key = process.env['REACTIVE_STATE_DELIVERY_KEY'];
  return key === undefined || key === '' ? undefined : key;
}

/** Taken as the module is evaluated: the global one is Next.js's, which a render's stores govern. */
const platformFetch: typeof fetch = fetch.bind(globalThis);

/**
 * Params no page is handed: none, and those the URL parser reads as a step of the path itself,
 * however a path encodes them (`..`, `%2E%2E`) — as the authority refuses one (`pageParamOf`).
 */
const NO_PAGE_PARAMS: ReadonlySet<string> = new Set(['', '.', '..']);

/**
 * `value`, a segment of the delivery path as the route handler's catch-all has it — decoded — as
 * Next.js hands a page a param: encoded again (`getDynamicParam`), `caf%C3%A9` of `café`, `a%2Fb` of
 * a slash its segment held. None for one no page is handed (`NO_PAGE_PARAMS`), or none that no text
 * encodes (a string not well formed).
 */
function pageParamOf(value: string): string | undefined {
  return NO_PAGE_PARAMS.has(value) || !value.isWellFormed() ? undefined : encodeURIComponent(value);
}

/**
 * The route's params, from the segments of the path its rewrite wrote them into, in the route's
 * order — one segment each, a catch-all's the rest — each as Next.js hands a page one
 * (`pageParamOf`), as the authority reads it for the route's guards, and the middleware is handed
 * it around the response alike; each the map's own, whatever its name. `undefined` where the
 * segments are not the route's, or one is no page's param.
 */
function paramsOf(route: RegisteredRoute, values: readonly string[]): RouteParams | undefined {
  const params: [string, string][] = [];
  let at = 0;
  for (const segment of route.route.split('/')) {
    const dynamic = dynamicSegmentOf(segment);
    if (dynamic === undefined) {
      continue;
    }
    const taken = dynamic.kind === 'dynamic' ? values.slice(at, at + 1) : values.slice(at);
    const given = taken.map((value) => pageParamOf(value));
    if ((dynamic.kind === 'dynamic' && taken.length === 0) || given.includes(undefined)) {
      return undefined;
    }
    params.push([dynamic.name, given.join('/')]);
    at += taken.length;
  }
  return at === values.length ? Object.fromEntries(params) : undefined;
}

/** Whether `given`, a segment of a path, is `value` decoded, as Next.js decodes a param of one. */
function decodesTo(given: string, value: string): boolean {
  try {
    return decodeURIComponent(given) === value;
  } catch {
    return false;
  }
}

/**
 * `value`, a param decoded, as a segment of the route's path spells it: as the visitor's path did
 * (`asked`), where that is the value decoded — the page then sees the path the visitor's browser
 * shows, and is the route's: spelled otherwise, a param may be another route's static segment,
 * `/%62oards/p1` of `/[section]/[id]` being `/boards/[projectId]`'s path as `/boards/p1` — or else
 * as a browser would (`spelledSegment`).
 */
function spelledOf(value: string, asked: string | undefined): string {
  return asked !== undefined && decodesTo(asked, value) ? asked : spelledSegment(value);
}

/**
 * A dynamic segment of a route as a path's segments spell it, of `value`, its param as a page is
 * handed it: one segment, as `spelledOf` spells it decoded of the visitor's (`asked`); a
 * catch-all's, a segment each of its parts — none of an empty one.
 */
function spellingsOf(
  dynamic: DynamicSegment,
  value: string,
  asked: string | undefined,
): readonly string[] {
  if (dynamic.kind === 'dynamic') {
    return [spelledOf(decodeURIComponent(value), asked)];
  }
  return value === ''
    ? []
    : value.split('/').map((part) => spelledOf(decodeURIComponent(part), undefined));
}

/**
 * The path of a route's page for its params: each static segment its folder's name as a browser
 * spells it (`spelledSegment`: `foo#bar` is `foo%23bar`, never a path cut short, as the authority
 * spells it), whatever spelling of it the visitor's path has — another case, escaped characters,
 * which the route's rewrite matches as Next.js does not look a page up by them — and each dynamic
 * one its param (`spellingsOf`), of the visitor's path's segment at its place where that path has
 * as many as the route (`asked`).
 */
function pathOf(route: string, params: RouteParams, asked: readonly string[] | undefined): string {
  const pattern = route.split('/');
  const placed = asked?.length === pattern.length ? asked : undefined;
  return pattern
    .flatMap((segment, index) => {
      const dynamic = dynamicSegmentOf(segment);
      return dynamic === undefined
        ? [spelledSegment(segment)]
        : spellingsOf(dynamic, ownValueOf(params, dynamic.name) ?? '', placed?.[index]);
    })
    .join('/');
}

/**
 * Whether `pathname`, of the URL the delivery route was handed, is one Next.js matched the
 * compile's own route by (`/api/reactive-state/…`, under the site's base path): its segments up to
 * the catch-all's as that route's pattern matches them — as written, as Next.js and upwind's runtime
 * match a dynamic route against the path as it came, and in any case, as upwind's runtime matches
 * one — and one at least after them, however escaped, which the catch-all decodes. The visitor asked
 * for the delivery route itself, then, as a request a rewrite brought is handed the URL the client
 * asked for, which no rewrite takes under that route. Such a request is no route's: its path names
 * the route and params it likes, and the page of those — `/[section]`'s of `/projects`, say — may
 * be another route's, whose own middleware would never run. A path that spells those segments
 * otherwise (`/api/%72eactive-state/events`), or has none after them, is no path of the compile's
 * route, and one a rewrite of a route of its own segments brought (`/[a]/[b]/[c]`'s) is that route's.
 */
function isOwnRoute(pathname: string, basePath: string): boolean {
  const segments = (underBasePath(basePath, pathname) ?? pathname).split('/').slice(1);
  return (
    segments.length > OWN_ROUTE.length &&
    OWN_ROUTE.every((name, index) => segments[index]?.toLowerCase() === name)
  );
}

/**
 * `spelled`, the route's path where the site serves it, in the slash form of the path the visitor
 * asked for (`visited`), where the site makes no trailing-slash redirect and serves either form
 * (`skipTrailingSlashRedirect`): the page asked for as it was, whose code renders what it reads of
 * its path (`usePathname()`) of that, as the gate answers either form of its own.
 */
function inVisitedForm(spelled: string, visited: string, site: SiteShape): string {
  const slashed = visited.endsWith('/');
  if (spelled === '/' || spelled.endsWith('/') === slashed) {
    return spelled;
  }
  if (site.skipTrailingSlashRedirect !== true) {
    return spelled;
  }
  return slashed ? `${spelled}/` : spelled.slice(0, -1);
}

/**
 * The URL a request of `route` is answered for — asked for again, and of its gate and its guards —
 * so that the page that answers it is the route's own: the route's path for its params (`pathOf`),
 * where the site serves it (under its base path, in its trailing-slash form), with the query the
 * visitor sent as it sent it (`visitorQuery`), but the delivery route's own param a platform puts
 * in the query it hands a handler (`PLATFORM_PARAMS`), which is not the page's. None for a request
 * of the compile's own route (`isOwnRoute`).
 */
function originalUrl(
  request: Request,
  route: RegisteredRoute,
  params: RouteParams,
): URL | undefined {
  const url = new URL(request.url);
  const site = siteShape();
  if (isOwnRoute(url.pathname, site.basePath)) {
    return undefined;
  }
  const path = pathOf(route.route, params, routePathOf(site, url.pathname)?.split('/'));
  const original = new URL(inVisitedForm(sitePathOf(site, path), url.pathname, site), url);
  original.search = visitorQuery(url, withheldOf(route));
  return original;
}

/**
 * The names of the query's components the page is not handed (`visitorQuery`): the delivery route's
 * own param (`PLATFORM_PARAMS`), and each of the route's own params under Next.js's prefixes
 * (`nxtPprojectId`), which Next.js reads as the param itself, ahead of the path's — a visitor's own
 * would have the page rendered for another param than the path's, which the gate and the guards are
 * asked of. A key of a prefix that names no param of the route (`nxtPromo`) is the page's.
 */
function withheldOf(route: RegisteredRoute): ReadonlySet<string> {
  const withheld = new Set(PLATFORM_PARAMS);
  for (const param of route.params) {
    for (const prefix of PARAM_PREFIXES) {
      withheld.add(`${prefix}${param}`);
    }
  }
  return withheld;
}

/**
 * The query of `url` as the visitor wrote it — each of its components as it came, in its order —
 * but those `withheld` names (`withheldOf`), by each component's name as the query is read
 * (`nameOf`): none decoded and written again, which would ask the page for another target than the
 * visitor's (`%20` as `+`, `%2f` as `%2F`, `%ZZ` as `%25ZZ`) — a signature over the query among what
 * reads it.
 */
function visitorQuery(url: URL, withheld: ReadonlySet<string>): string {
  const query = url.search.slice(1);
  if (query === '') {
    return '';
  }
  const kept = query.split('&').filter((component) => !withheld.has(nameOf(component)));
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}

/**
 * The name of a component of a query as the query is read (`URLSearchParams`), as Next.js reads it
 * too: `nxtP%70ath`'s is `nxtPpath`, which Next.js takes for the catch-all's param however it is
 * spelled. The `&` in front keeps a leading `?` the component's own, which the constructor would
 * take for the query's.
 */
function nameOf(component: string): string {
  const [name = ''] = new URLSearchParams(`&${component}`).keys();
  return name;
}

/**
 * A gate's answer, or a guard's, as the response it is: an empty body as none, which a status that
 * has no body (a guard's 204, say) takes.
 */
function responseOf(answer: Extract<GateAnswer, { kind: 'respond' }>): Response {
  const body =
    answer.body === null || answer.body === ''
      ? null
      : Uint8Array.from(atob(answer.body), (char) => char.codePointAt(0) ?? 0);
  const headers = new Headers();
  for (const [name, value] of answer.headers) {
    headers.append(name, value);
  }
  return new Response(body, { headers, status: answer.status });
}

/** The answer of a route whose gate or guards the authority could not answer for: kept by nobody. */
function unavailable(): Response {
  return new Response(null, {
    headers: { 'cache-control': UNKEPT },
    status: HTTP_UNAVAILABLE,
  });
}

/** The answer of a write the route's guards did not let on: the generic 403, kept by nobody. */
function forbidden(): Response {
  return new Response(null, {
    headers: { 'cache-control': UNKEPT },
    status: HTTP_FORBIDDEN,
  });
}

/** The pathname and the query the visitor asked for, as the authority is told them. */
function askedOf(original: URL): string {
  return `${original.pathname}${original.search}`;
}

/** The directives of `Cache-Control` a shared cache keeps an answer by, or that `private` takes over. */
const SHARED_DIRECTIVES: ReadonlySet<string> = new Set(['private', 'public', 's-maxage']);

/**
 * `headers`, of an answer to one visitor's request, kept by no shared cache: its envelopes ran for
 * the request, and its guards for the request's session — a static page's `s-maxage` gone, and
 * the browser's own caching kept as the page said it (`private`, and the rest of its directives,
 * each whole as written, a quoted string's commas its own: `cacheDirectivesOf`).
 */
function keptByNoSharedCache(headers: Headers): void {
  for (const name of SHARED_CACHE_HEADERS) {
    headers.delete(name);
  }
  const kept = cacheDirectivesOf(headers.get('cache-control') ?? '')
    .filter((directive) => !SHARED_DIRECTIVES.has(directive.name))
    .map((directive) => directive.text);
  headers.set('cache-control', ['private', ...kept].join(', '));
}

/** The answer to a request whose page answered what holds the build's key: a fault, naming nothing. */
function keyHeld(): Response {
  return new Response(null, {
    headers: { 'cache-control': UNKEPT },
    status: HTTP_SERVER_ERROR,
  });
}

/**
 * The page's answer, its body streamed as it comes: where the platform's `fetch` decoded the body,
 * without the coding it no longer has, nor the length it had in it, which the visitor would
 * otherwise decode it by again; and, as a visitor's (`visitor`), kept by no shared cache. Never
 * one that holds the build's key, which the page was asked with (`delivery-key.ts`): one whose
 * headers or status text hold it, or whose body is in a coding no reading sees into, is a fault,
 * answered before anything of it is sent; a body is read for it as it streams, ended where it is.
 */
async function pageAnswer(response: Response, visitor: boolean, key: string): Promise<Response> {
  if (holdsKey(response, key) || !readsAsWritten(response)) {
    await response.body?.cancel();
    return keyHeld();
  }
  const headers = new Headers(response.headers);
  if (isDecoded(response)) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  if (visitor) {
    keptByNoSharedCache(headers);
  }
  return new Response(response.body === null ? null : keptFromBody(response.body, key), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * The headers of a hop rather than of the request, which a request asked for again does not carry
 * on (RFC 9110 §7.6.1) — `Connection`, and each it names, `Keep-Alive`, `Proxy-Connection`, `TE`,
 * `Trailer`, `Transfer-Encoding`, `Upgrade` — and those the platform's `fetch` makes of the request
 * it sends itself: `Expect`, `Host`, and `Content-Length`, the body being sent whole. Node's `fetch`
 * (undici's) refuses a request of `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `Expect`, or a
 * length its body is not of.
 */
const HOP_HEADERS: readonly string[] = [
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
/** A header's name, as `Headers` takes one: a token. */
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/u;

/** `headers` without what a hop has of them (`HOP_HEADERS`, and what `Connection` names). */
function forwardedOf(headers: Headers): Headers {
  const forwarded = new Headers(headers);
  const named = (headers.get('connection') ?? '').split(',').map((name) => name.trim());
  for (const name of HOP_HEADERS) {
    forwarded.delete(name);
  }
  for (const name of named) {
    if (HEADER_NAME.test(name)) {
      forwarded.delete(name);
    }
  }
  return forwarded;
}

/** A member of an `Accept-Encoding` a page may answer in `zstd` for: the coding's name, or any (`*`). */
const MAY_BE_ZSTD = /^\s*(?:zstd|\*)\s*(?:;|$)/iu;

/**
 * `accepted`, a request's `Accept-Encoding`, without the members a page may answer in `zstd` for
 * (`MAY_BE_ZSTD`), the rest as they came. Node's `fetch` undoes that coding from Node 24.4 on; an
 * earlier one hands the body on as it came, and `isDecoded` cannot tell the two apart: the page's
 * answer would leave coded, named as of no coding, and unread for the build's key. So no page is
 * asked for it, whichever Node runs this. `identity` where no member is left: no coding, as the
 * visitor took none of those a page is asked for.
 */
function withoutZstd(accepted: string): string {
  const kept = accepted.split(',').filter((member) => !MAY_BE_ZSTD.test(member));
  return kept.length === 0 ? 'identity' : kept.join(',');
}

/**
 * The page, asked for again as the request asked for it, past the rewrite (`key`): of the
 * request's own headers (`forwardedOf`), whichever of its copies the envelopes left it as, but
 * `zstd` among the codings it takes (`withoutZstd`); with a generation's token where the request is
 * the authority's for an artifact (`generation`), and with none it carried otherwise; and given up
 * as the request is (its `signal`), where its asker goes away — a visitor, or the authority past an
 * artifact's deadline — rather than rendered for nobody.
 */
async function pageFor(
  request: Request,
  original: URL,
  key: string,
  options: { readonly generation: boolean; readonly admission?: string | undefined },
): Promise<Response> {
  const { admission, generation } = options;
  // The visitor's `Accept-Encoding` as it came but for `zstd`, as the page would read it asked
  // directly: an answer in a coding `fetch` is known not to undo is refused (`readsAsWritten`).
  const headers = forwardedOf(request.headers);
  const accepted = headers.get('accept-encoding');
  if (accepted !== null) {
    headers.set('accept-encoding', withoutZstd(accepted));
  }
  headers.delete(ADMISSION_HEADER);
  if (!generation && admission !== undefined) {
    headers.set(ADMISSION_HEADER, admission);
  }
  headers.set(DIRECT_HEADER, key);
  if (!generation) {
    headers.delete(GENERATION_HEADER);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const response = await platformFetch(original, {
    body: hasBody ? request.body : null,
    headers,
    method: request.method,
    redirect: 'manual',
    signal: request.signal,
    ...(hasBody && { duplex: 'half' }),
  });
  return pageAnswer(response, !generation, key);
}

/**
 * The gate's answer below the envelopes: where a guard of the route's middleware decided it
 * (`GateAnswer.by`), as the guard's — its refusal reached by no after part, its own response by
 * those of the middleware outside its own; any other — the artifact, a 304, the view's root
 * refusing it, as a page's 403 is under middleware — by every one.
 */
function gateAnswered(answer: Extract<GateAnswer, { kind: 'respond' }>): GuardedAnswer | Response {
  const response = responseOf(answer);
  if (answer.by === undefined) {
    return response;
  }
  return answer.refused === true ? { response } : { by: answer.by, response };
}

/**
 * A shared route's answer from its gate, to a `GET` or a `HEAD`: the artifact, a 304, the generic
 * 403, a 503 — as a guard decided it, where one did (`gateAnswered`); none for a request it lets
 * through, nor for one of another method. The gate is told where the site serves its routes, as
 * this build does (`siteShape`), which it reads the URL by from the first request on, before any
 * page of the site's said it. An authority that could not be asked is a failure no after part
 * reaches, as where the delivery route asks the guards.
 */
async function gateAnswer(
  request: Request,
  route: RouteRegistration,
  original: URL,
): Promise<GuardedAnswer | Response | undefined> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const name of GATE_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers[name] = value;
    }
  }
  const answer = await authority().gate({
    headers,
    method: request.method,
    route: route.route,
    site: siteShape(),
    url: askedOf(original),
  });
  if (!answer.ok) {
    return { response: unavailable() };
  }
  return answer.value.kind === 'respond' ? gateAnswered(answer.value) : undefined;
}

/** Whether `request` reads the route — a `GET` or a `HEAD` — rather than writes to it. */
function isRead(request: Request): boolean {
  return request.method === 'GET' || request.method === 'HEAD';
}

/**
 * What the route's guards say of the request's session. The authority is told the route's own
 * path, which it reads the params off — the site's base path and trailing slash taken off what the
 * visitor asked for — and the query.
 */
async function guardsOf(
  request: Request,
  route: RegisteredRoute,
  original: URL,
  source: SessionSource | undefined,
): ReturnType<ReturnType<typeof authority>['guardRoute']> {
  const path = routePathOf(siteShape(), original.pathname) ?? original.pathname;
  return authority().guardRoute(await routeSession(request, source), {
    ...(!isPlainRoute(route) && { admit: true }),
    route: route.route,
    url: `${path}${original.search}`,
  });
}

/** A response a guard answered itself, of the middleware that answered it (`GuardedAnswer`). */
function answeredBy(answer: Extract<GuardAnswer, { readonly kind: 'respond' }>): GuardedAnswer {
  const response = responseOf(answer);
  return answer.by === undefined ? { response } : { by: answer.by, response };
}

/** A successful decision for the page's initial session render, not a response. */
interface Admitted {
  readonly admission: string;
}

/**
 * A request as the route's guards answer the request's session before the page is asked for it:
 * none where they let it on; the response a guard answered itself; the generic 403 where one refuses
 * it, or the authority refuses the question; a 503 where it could not answer. Asked of every request
 * of a route a middleware of which has a guard (`guarded`) — any other's the authority could only
 * let on — but a read of a route every visitor shares, which its gate answers: a write — a Server
 * Action posted to it, any request but a `GET` or a `HEAD` — which the root the page renders refused
 * after it could not undo; a read of a route of the request's, before anything of its page renders —
 * its layouts, its metadata, whatever else the page's code does — as the source's guard runs before
 * all of it; and every request of a route of no reactive root, whose guards no render runs.
 */
async function strictAnswer(
  request: Request,
  route: RegisteredRoute,
  original: URL,
  source: SessionSource | undefined,
): Promise<GuardedAnswer | Admitted | undefined> {
  const answer = await guardsOf(request, route, original, source);
  if (!answer.ok) {
    return { response: answer.status >= HTTP_SERVER_ERROR ? unavailable() : forbidden() };
  }
  if (answer.value.kind === 'pass') {
    return answer.value.admission === undefined ? undefined : { admission: answer.value.admission };
  }
  return answer.value.kind === 'refused' ? { response: forbidden() } : answeredBy(answer.value);
}

/**
 * What answers the request before the page is asked for it, if anything: the gate of a route every
 * visitor shares, for a read; otherwise its guards (`strictAnswer`). A read the gate lets through —
 * a prefetch, a view it found the request's, an artifact of another deployment's — is the page's to
 * render. A route with a guard asks them first, as a route of the request's does, a prefetch among
 * them — its headers are the visitor's to send — and carries a successful decision to that page's
 * initial session render. Other render contexts run their guards normally.
 */
async function answeredFirst(
  request: Request,
  route: RegisteredRoute,
  original: URL,
  source: SessionSource | undefined,
): Promise<GuardedAnswer | Response | Admitted | undefined> {
  if (!isPlainRoute(route) && route.shared && isRead(request)) {
    const gated = await gateAnswer(request, route, original);
    if (gated === undefined && route.guarded === true) {
      return strictAnswer(request, route, original, source);
    }
    return gated;
  }
  return route.guarded === true ? strictAnswer(request, route, original, source) : undefined;
}

/** The route's response, below its envelopes: its gate's or its guards', or the page's. */
async function downstream(
  request: Request,
  route: RegisteredRoute,
  original: URL,
  { key, source }: { readonly key: string; readonly source: SessionSource | undefined },
): Promise<GuardedAnswer | Response> {
  const answer = await answeredFirst(request, route, original, source);
  if (answer === undefined || 'admission' in answer) {
    return pageFor(request, original, key, { admission: answer?.admission, generation: false });
  }
  return answer;
}

/**
 * A request the rewrite of a route under middleware brought, answered inside the route's chain: the
 * route and its params as the path below `deliver/` names them (`segments`), as the route handler's
 * catch-all has them.
 */
export async function deliver(
  request: Request,
  registry: Registry,
  segments: readonly string[],
): Promise<Response> {
  const [named, ...values] = segments;
  const route = registry.routes.find((each) => routeKeyOf(each.route) === named);
  const params = route === undefined ? undefined : paramsOf(route, values);
  if (route === undefined || params === undefined) {
    return new Response(null, { status: HTTP_NOT_FOUND });
  }
  const key = deliveryKey();
  if (key === undefined) {
    return new Response(null, { status: HTTP_UNAVAILABLE });
  }
  if (request.headers.get(DIRECT_HEADER) === key) {
    // A request past the rewrite is a page's, and one here named the delivery route itself: asked
    // for again, it would only come back here.
    return new Response(null, { status: HTTP_NOT_FOUND });
  }
  const original = originalUrl(request, route, params);
  if (original === undefined) {
    return new Response(null, { status: HTTP_NOT_FOUND });
  }
  if (await isAuthorityRequest(request, route, original)) {
    return pageFor(request, original, key, { generation: true });
  }
  // Below the envelopes, the request they hand on: its body whole, whatever an envelope read of it.
  return throughChain(
    { envelopes: registry.envelopes, ids: route.middleware, params, request },
    async (handed) => downstream(handed, route, original, { key, source: registry.session }),
  );
}

/**
 * Whether `request` is the authority's own for an artifact of `route`: a read of a route every
 * visitor shares that names a generation, which the route's gate lets through as one. The gate is
 * asked of the name alone, as a `HEAD`: it lets a token it signed through before it reads anything
 * else, it lets nothing through as a prefetch where it is told of none, and it answers no body to
 * the question. A view it found the request's it lets every request through, a token or not: the
 * page has the authority judge the token then, which renders nothing for one it did not sign. Any
 * other request is asked nothing more.
 */
async function isAuthorityRequest(
  request: Request,
  route: RegisteredRoute,
  original: URL,
): Promise<boolean> {
  const generation = request.headers.get(GENERATION_HEADER);
  if (generation === null || isPlainRoute(route) || !route.shared || !isRead(request)) {
    return false;
  }
  const answer = await authority().gate({
    headers: { [GENERATION_HEADER]: generation },
    method: 'HEAD',
    route: route.route,
    site: siteShape(),
    url: askedOf(original),
  });
  return answer.ok && answer.value.kind === 'pass' && answer.value.generation === true;
}
