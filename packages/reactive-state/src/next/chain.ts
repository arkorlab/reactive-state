import type { MiddlewareEnvelope, RouteParams } from '../routing.ts';
import { HTTP_PAYLOAD_TOO_LARGE } from '../status.ts';

/**
 * A route middleware chain's envelope, around one real request: what each middleware computes of the
 * request before `next`, outermost first; the route's response (`downstream`); then what each does
 * to the response after `next`, innermost first — parent before, child before, the response, child
 * after, parent after. The guards before `next` are the authority's, in the render or the decision
 * `downstream` asks it for. The response is the request's own: one made of a shared artifact is made
 * anew for each request, so that nothing an envelope sets reaches what the next request is answered
 * with. `downstream` runs once, or not at all where a middleware's `before` throws.
 *
 * What a guard answers in the route's place is reached by the after parts the source's would reach
 * (`GuardedAnswer`): none for a refusal, which the source's `forbidden()` throws past every
 * `await next()`, nor for an authority that could not answer; and, for a response a guard answered
 * itself, those of the middleware around the one whose guard did, whose `next` its `return` answers
 * — not its own, which comes after the `next` it never called.
 *
 * Each `before` and `downstream` is handed a request of its own, its body whole: what one reads of
 * the body (`await request.json()`) is not gone from the next, nor from the page asked for below
 * them, and what one sets of its headers is its own, as a body or none — the page is asked with the
 * request as it came, as Next.js's own middleware forwards no change to its request. Where an
 * envelope's `before` is handed the request, a body is read once, into memory, and each request is
 * made of it — a body longer than `MAX_BODY_BYTES` is refused (413) before any envelope runs; where
 * none is, the body streams through to `downstream` unread.
 */

/**
 * The most of a request's body the chain holds to hand it whole to each envelope and to the route
 * below them: 4 MiB, four times the 1 MB Next.js takes of a Server Action's body unless the
 * application says otherwise (`serverActions.bodySizeLimit`).
 */
export const MAX_BODY_BYTES = 4_194_304;

/**
 * What a guard of the chain answered in the route's place, below the envelopes: the response, and
 * the middleware whose guard answered it of its own (`by`), by id — none for a refusal, or for an
 * authority that could not answer.
 */
export interface GuardedAnswer {
  readonly response: Response;
  readonly by?: string;
}

export interface Chain {
  readonly request: Request;
  readonly params: RouteParams;
  /** The middleware around the route, outermost first, by id. */
  readonly ids: readonly string[];
  readonly envelopes: Readonly<Record<string, MiddlewareEnvelope>>;
}

/** The envelopes of `ids`, outermost first: those of a middleware with one. */
function envelopesOf(chain: Chain): readonly MiddlewareEnvelope[] {
  return chain.ids.flatMap((id) => {
    const envelope = Object.hasOwn(chain.envelopes, id) ? chain.envelopes[id] : undefined;
    return envelope === undefined ? [] : [envelope];
  });
}

/** A response whose headers the envelopes may set: a copy of `response`'s, its body as it streams. */
function ownResponse(response: Response): Response {
  return new Response(response.body, {
    headers: new Headers(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
}

/** `stream` read whole, into one buffer; `undefined` once it holds more than `MAX_BODY_BYTES`. */
async function bufferOf(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    length += read.value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(read.value);
  }
  const buffer = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, at);
    at += chunk.byteLength;
  }
  return buffer;
}

/**
 * What makes a request of `request` for each envelope and for `downstream`, each with the body
 * whole and headers of its own: `request` itself, where no envelope is handed it; one made of its
 * parts, otherwise — of its body, read once, where it has one; none for a body longer than
 * `MAX_BODY_BYTES`, the length it declares included, which is not read at all.
 */
async function requestsOf(
  request: Request,
  envelopes: readonly MiddlewareEnvelope[],
): Promise<(() => Request) | undefined> {
  // A generated before binds one context parameter only where it reads it; its own arguments
  // cannot be read. An argument-free before leaves the request to downstream alone.
  if (envelopes.every((envelope) => (envelope.before?.length ?? 0) === 0)) {
    return () => request;
  }
  const stream = request.body;
  if (stream !== null && Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    await stream.cancel();
    return undefined;
  }
  const body = stream === null ? null : await bufferOf(stream);
  if (body === undefined) {
    return undefined;
  }
  // Made of the request's parts, not of the request: the one a route handler is handed is
  // Next.js's own, which a platform's Request may not take as one (workerd reads it as a URL). Its
  // headers copied into each, so that what one envelope sets of them reaches no other, nor the
  // page; its signal with them, so that what each is handed to gives up as the request is given up.
  const { headers, method, signal, url } = request;
  return () => new Request(url, { body, headers, method, redirect: request.redirect, signal });
}

/**
 * How many of the chain's envelopes, outermost first, an after part of reaches what `below`
 * answered: each, for the route's own response; for a guard's, those of the middleware around the
 * one whose guard answered it, and none where no middleware did (`GuardedAnswer`).
 */
function reachOf(below: GuardedAnswer | Response, chain: Chain, envelopes: number): number {
  if (below instanceof Response) {
    return envelopes;
  }
  const at = below.by === undefined ? -1 : chain.ids.indexOf(below.by);
  return at === -1 ? 0 : envelopesOf({ ...chain, ids: chain.ids.slice(0, at) }).length;
}

/** The response of what is below the envelopes. */
function responseOf(below: GuardedAnswer | Response): Response {
  return below instanceof Response ? below : below.response;
}

/** Runs `downstream` inside the chain's envelopes, and answers the response they leave. */
export async function throughChain(
  chain: Chain,
  downstream: (request: Request) => Promise<GuardedAnswer | Response>,
): Promise<Response> {
  const envelopes = envelopesOf(chain);
  if (envelopes.length === 0) {
    return responseOf(await downstream(chain.request));
  }
  const requestOf = await requestsOf(chain.request, envelopes);
  if (requestOf === undefined) {
    return new Response(null, {
      headers: { 'cache-control': 'private, no-store' },
      status: HTTP_PAYLOAD_TOO_LARGE,
    });
  }
  const locals: Readonly<Record<string, unknown>>[] = [];
  for (const envelope of envelopes) {
    locals.push(
      envelope.before === undefined
        ? {}
        : await envelope.before({ params: chain.params, request: requestOf() }),
    );
  }
  const below = await downstream(requestOf());
  const response = ownResponse(responseOf(below));
  for (let index = reachOf(below, chain, envelopes.length) - 1; index >= 0; index -= 1) {
    await envelopes[index]?.after?.(locals[index] ?? {}, response);
  }
  return response;
}

/** The middleware ids around `path` (a directory under the app), of those with an envelope. */
export function chainAround(
  path: string,
  envelopes: Readonly<Record<string, MiddlewareEnvelope>>,
): readonly string[] {
  const segments = path.split('/').filter((segment) => segment !== '');
  const ids = [''];
  for (let index = 1; index <= segments.length; index += 1) {
    ids.push(segments.slice(0, index).join('/'));
  }
  return ids.filter((id) => Object.hasOwn(envelopes, id));
}
