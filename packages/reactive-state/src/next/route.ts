import type { Failure } from '../client/index.ts';
import { type Result, SESSION_COOKIE } from '../program.ts';
import { claimedView, DELIVER_PATH } from '../routing.ts';
import { HTTP_BAD_REQUEST, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNAUTHORIZED } from '../status.ts';
import { authority, refused, routeSession, sessionOf } from './authority.ts';
import { chainAround, throughChain } from './chain.ts';
import { deliver, type Registry } from './deliver.ts';

/**
 * The route a compile writes for an application (`<app>/api/reactive-state/[...path]/route.ts`,
 * which re-exports these handlers):
 *
 * - `GET events?subscription=…`: a root's event stream, as the authority writes it — each `frame`
 *   says a newer render of the root shows something else, and `revoked` ends it. A refusal before
 *   it starts that a reconnection would meet again — a session that ended, a subscription that is
 *   not the session's, another build — is answered as a stream that says `revoked` and ends, as an
 *   `EventSource` hears of nothing else but an error it reconnects after; one that may pass, as one
 *   of an authority that did not answer, as itself. The stream ends with the request: the host
 *   cancels it as the browser leaves, and where it aborts the request's signal, the signal cancels
 *   it too.
 * - `POST session` with `{ user }`, and `DELETE session`: the demo's sign-in and sign-out. The
 *   authority opens and ends the session; the cookie that carries it is the application's to set,
 *   on its own origin: opaque, `HttpOnly`, `SameSite=Strict`, and `Secure` over https — the
 *   request's own, or the one a proxy in front of the application says the browser used.
 * - `deliver/<route>/<params>…`: a route under route middleware, delivered (`deliver.ts`) whatever
 *   the request's method — each a route handler may be asked with, `OPTIONS`, `PUT` and `PATCH`
 *   among them, which its paths of its own answer as Next.js would answer a handler without them.
 */

/** What Next.js hands a route's handler beside the request: the catch-all's segments. */
export interface RouteContext {
  readonly params?:
    | Promise<Readonly<Record<string, string | readonly string[] | undefined>>>
    | undefined;
}

const HTTP_NO_CONTENT = 204;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
/** How long the browser keeps a session: as long as the authority does, a day. */
const SESSION_SECONDS = 86_400;
const NO_STORE = { 'Cache-Control': 'no-store' };
const STREAM_HEADERS = {
  'Cache-Control': 'no-store, no-transform',
  'Content-Type': 'text/event-stream; charset=utf-8',
  'X-Accel-Buffering': 'no',
};

/**
 * A route's answer for a failure: its status, and its code and message as the authority's are,
 * with `headers` beside its own.
 */
function refusal(failure: Failure, headers: Readonly<Record<string, string>> = {}): Response {
  return Response.json(
    { code: failure.code, error: failure.message },
    { headers: { ...headers, ...NO_STORE }, status: failure.status },
  );
}

function notFound(): Response {
  return refusal(refused(HTTP_NOT_FOUND, 'NOT_FOUND', 'Nothing is served here.'));
}

function notAllowed(allowed: string): Response {
  return refusal(
    refused(HTTP_METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED', `Only ${allowed} is served here.`),
    { Allow: allowed },
  );
}

/** The route's path below `api/reactive-state/`: the catch-all's segments, or the URL's last. */
async function segmentsOf(
  request: Request,
  context: RouteContext | undefined,
): Promise<readonly string[]> {
  const path: unknown = (await context?.params)?.['path'];
  if (Array.isArray(path)) {
    return path.map(String);
  }
  if (typeof path === 'string') {
    return [path];
  }
  return [new URL(request.url).pathname.split('/').findLast((segment) => segment !== '') ?? ''];
}

/**
 * The host the browser addressed: the one a proxy in front of the application was asked for, the
 * request's own otherwise. Not the request's URL, which `next start` names `localhost` whatever
 * host the browser asked for.
 */
function hostOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-host')?.split(',', 1)[0]?.trim();
  return forwarded ?? request.headers.get('host') ?? new URL(request.url).host;
}

/**
 * Refuses a request that did not come from the application's own pages, as Next.js refuses a
 * Server Action's: its `Origin` names another host than the one it was sent to. The authority takes
 * the application's server at its word, so this is where a browser's request is checked.
 */
function foreign(request: Request): Failure | undefined {
  const origin = request.headers.get('origin');
  return origin !== null && URL.canParse(origin) && new URL(origin).host === hostOf(request)
    ? undefined
    : refused(HTTP_FORBIDDEN, 'ORIGIN_REJECTED', 'The origin does not match.');
}

/** A request's JSON body; an empty body is an empty object, and one that is not JSON is refused. */
async function bodyOf(request: Request): Promise<Result<Partial<Record<string, unknown>>>> {
  let body: unknown;
  try {
    const text = await request.text();
    body = JSON.parse(text === '' ? '{}' : text);
  } catch {
    return refused(HTTP_BAD_REQUEST, 'INVALID_JSON', 'The body is not JSON.');
  }
  return { ok: true, value: typeof body === 'object' && body !== null ? body : {} };
}

/**
 * Whether the browser reached the application over https: the request's URL says so, or the proxy
 * in front of it does (`x-forwarded-proto`), as `next start` behind one is asked over plain http.
 */
function isSecure(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim();
  return new URL(request.url).protocol === 'https:' || forwarded?.toLowerCase() === 'https';
}

function sessionCookie(request: Request, sessionId: string, maxAge: number): string {
  const secure = isSecure(request) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(maxAge)}${secure}`;
}

async function events(request: Request, registry: Registry): Promise<Response> {
  const subscription = new URL(request.url).searchParams.get('subscription');
  if (subscription === null || subscription === '') {
    return refusal(refused(HTTP_BAD_REQUEST, 'INVALID_SUBSCRIPTION', 'Name the subscription.'));
  }
  if (request.method === 'HEAD') {
    return streamHead();
  }
  // The application's own session, read again as each stream opens — a renewed one too — so that
  // a sign-in that ended stops the stream at its next opening.
  const session = await routeSession(request, registry.session);
  return streamed(request, await authority().events(session, subscription));
}

/**
 * The answer to a `HEAD` of a stream: the headers its `GET` opens one with, and no body — as
 * Next.js answers a `HEAD` by the `GET` it has, and sends none of its body — the stream unopened.
 * The authority would hold one open, and a shared view's following with it, until the request's
 * signal ended it, which nothing need do of a `HEAD` answered whole.
 */
function streamHead(): Response {
  return new Response(null, { headers: STREAM_HEADERS });
}

/** An event stream the authority opened, handed on until the request ends; its refusal otherwise. */
function streamed(request: Request, stream: Result<ReadableStream<Uint8Array>>): Response {
  if (!stream.ok) {
    return isFinal(stream) ? revokedStream(stream) : refusal(stream);
  }
  const body = stream.value.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
    signal: request.signal,
  });
  return new Response(body, { headers: STREAM_HEADERS });
}

/** A response's status and headers alone, without opening or retaining its body. */
function headResponse(response: Response): Response {
  return new Response(null, { headers: response.headers, status: response.status });
}

/**
 * The shared stream is authenticated before its token selects an envelope or supplies params.
 * A HEAD asks the same authority call to check the token without following the view.
 */
async function sharedEvents(request: Request, view: string, registry: Registry): Promise<Response> {
  const client = authority();
  const head = request.method === 'HEAD';
  const opened = head ? await client.sharedEvents(view, true) : await client.sharedEvents(view);
  if (!opened.ok) {
    const response = streamed(request, opened);
    return head ? headResponse(response) : response;
  }
  if (head) await opened.value.cancel();
  const response = head ? streamHead() : streamed(request, opened);
  const claimed = claimedView(view);
  const route = registry.routes.find((each) => each.route === claimed?.route);
  let answered: Response | undefined;
  try {
    answered = await throughChain(
      {
        envelopes: registry.envelopes,
        ids: route?.middleware ?? [],
        params: claimed?.params ?? {},
        request,
      },
      () => Promise.resolve(response),
    );
    return answered;
  } finally {
    // A throwing envelope or a chain's own terminal answer must not retain the opened stream.
    if (answered?.body !== response.body) await response.body?.cancel();
  }
}

/** Whether a refusal to open a stream is one every reconnection would meet: a 4xx but a pause's. */
function isFinal(failure: Failure): boolean {
  return (
    failure.status < HTTP_SERVER_ERROR &&
    failure.status !== HTTP_REQUEST_TIMEOUT &&
    failure.status !== HTTP_TOO_MANY_REQUESTS
  );
}

/** A stream that says `revoked`, with the refusal's code and message, as it opens, and ends. */
function revokedStream(failure: Failure): Response {
  const data = JSON.stringify({ code: failure.code, error: failure.message });
  return new Response(`: open\n\nevent: revoked\ndata: ${data}\n\n`, { headers: STREAM_HEADERS });
}

async function signIn(request: Request): Promise<Response> {
  const rejected = foreign(request);
  if (rejected !== undefined) {
    return refusal(rejected);
  }
  const body = await bodyOf(request);
  if (!body.ok) {
    return refusal(body);
  }
  const { user } = body.value;
  if (typeof user !== 'string') {
    return refusal(refused(HTTP_BAD_REQUEST, 'INVALID_USER', "Name one of the demo's users."));
  }
  const client = authority();
  const signedIn = await client.login(user);
  if (!signedIn.ok) {
    return refusal(signedIn);
  }
  const { sessionId, userId } = signedIn.value;
  // Signing in replaces the browser's session: the one its cookie named ends, and with it each
  // stream the browser still holds under it — in another tab too. One that had ended is no matter.
  // Where it could not be ended, the new one is ended too, as the browser never hears of it: the
  // browser keeps the session it had, as it was before it asked.
  const previous = sessionOf(request);
  if (previous !== null) {
    const ended = await client.logout(previous);
    if (!ended.ok && ended.status !== HTTP_UNAUTHORIZED) {
      await client.logout(sessionId);
      return refusal(ended);
    }
  }
  return Response.json(
    { user: { id: userId } },
    { headers: { ...NO_STORE, 'Set-Cookie': sessionCookie(request, sessionId, SESSION_SECONDS) } },
  );
}

async function signOut(request: Request): Promise<Response> {
  const rejected = foreign(request);
  if (rejected !== undefined) {
    return refusal(rejected);
  }
  // Every answer clears the cookie, a refusal of a session that had already ended included: the
  // browser is signed out either way, rather than left sending a session that is gone.
  const cleared = { 'Set-Cookie': sessionCookie(request, '', 0) };
  const signedOut = await authority().logout(sessionOf(request));
  if (!signedOut.ok) {
    return refusal(signedOut, cleared);
  }
  return Response.json({ ok: true }, { headers: { ...NO_STORE, ...cleared } });
}

/** The directory under the app the compile writes this route into, which middleware may wrap. */
const ROUTE_DIRECTORY = 'api/reactive-state/[...path]';

/**
 * The methods the route's own paths are asked with: what Next.js answers `OPTIONS` with for a
 * handler of them alone, as the route answered before it took every method for those it delivers.
 */
const OWN_METHODS = 'DELETE, GET, HEAD, OPTIONS, POST';

/** The route's own answer for `OPTIONS`, as Next.js answers a handler that exports none: its methods. */
function options(): Promise<Response> {
  return Promise.resolve(
    new Response(null, { headers: { Allow: OWN_METHODS }, status: HTTP_NO_CONTENT }),
  );
}

/**
 * The route's own answer for a method none of its paths is asked with — `PUT`, `PATCH` — as Next.js
 * answers a handler that exports none of it: 405.
 */
function unserved(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: HTTP_METHOD_NOT_ALLOWED }));
}

const NO_REGISTRY: Registry = Object.freeze({ envelopes: {}, routes: [] });

/** The route's own answer for `GET`, below the middleware around it. */
async function get(request: Request, path: string, registry: Registry): Promise<Response> {
  switch (path) {
    case 'events': {
      const view = new URL(request.url).searchParams.get('view');
      return view === null ? events(request, registry) : sharedEvents(request, view, registry);
    }
    case 'session': {
      // An application that signs its users in itself has no demo sign-in to be asked of.
      return registry.session === undefined ? notAllowed('POST, DELETE') : notFound();
    }
    default: {
      return notFound();
    }
  }
}

async function post(request: Request, path: string, registry: Registry): Promise<Response> {
  switch (path) {
    case 'events': {
      return notAllowed('GET');
    }
    case 'session': {
      return registry.session === undefined ? signIn(request) : notFound();
    }
    default: {
      return notFound();
    }
  }
}

async function remove(request: Request, path: string, registry: Registry): Promise<Response> {
  switch (path) {
    case 'events': {
      return notAllowed('GET');
    }
    case 'session': {
      return registry.session === undefined ? signOut(request) : notFound();
    }
    default: {
      return notFound();
    }
  }
}

type Handler = (request: Request, context?: RouteContext) => Promise<Response>;

/** Whether `request` reads what it is asked of — a `GET` or a `HEAD` — rather than writes to it. */
function isRead(request: Request): boolean {
  return request.method === 'GET' || request.method === 'HEAD';
}

/**
 * The route's handlers for an application, with what its compile registered (`<out>/routes.ts`):
 * its own paths inside the middleware around the route's directory, a shared view's stream — a read
 * of `events` naming a view — inside its route's, and the routes under middleware delivered
 * (`deliver`), whatever their method — a handler for each a route handler may be asked with, as
 * Next.js answers any other without calling the route, around no middleware. Any other request of
 * `events` — a preflight, a write, which open no stream — is the route's own, a `view` in its query
 * or not.
 */
export function routeHandlers(registry: Registry): {
  readonly DELETE: Handler;
  readonly GET: Handler;
  readonly HEAD: Handler;
  readonly OPTIONS: Handler;
  readonly PATCH: Handler;
  readonly POST: Handler;
  readonly PUT: Handler;
} {
  const own = chainAround(ROUTE_DIRECTORY, registry.envelopes);
  const handled = (answer: (request: Request, path: string) => Promise<Response>): Handler => {
    return async (request, context) => {
      const segments = await segmentsOf(request, context);
      if (segments[0] === DELIVER_PATH) {
        return deliver(request, registry, segments.slice(1));
      }
      const path = segments.join('/');
      if (path === 'events' && isRead(request) && new URL(request.url).searchParams.has('view')) {
        return answer(request, path);
      }
      // The route's own answer reads the request it is handed: a sign-in's body, whole whatever an
      // envelope read of it.
      return throughChain(
        { envelopes: registry.envelopes, ids: own, params: {}, request },
        async (handed) => answer(handed, path),
      );
    };
  };
  return {
    DELETE: handled(async (request, path) => remove(request, path, registry)),
    GET: handled(async (request, path) => get(request, path, registry)),
    HEAD: handled(async (request, path) => get(request, path, registry)),
    OPTIONS: handled(options),
    PATCH: handled(unserved),
    POST: handled(async (request, path) => post(request, path, registry)),
    PUT: handled(unserved),
  };
}

/** The handlers of an application that registered no route: the route's own paths alone. */
export const { DELETE, GET, POST } = routeHandlers(NO_REGISTRY);
