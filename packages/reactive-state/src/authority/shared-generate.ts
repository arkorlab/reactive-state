import { readsAsWritten } from '../content-coding.ts';
import { GENERATION_HEADER, ownValueOf, paramOfSegment, type RouteParams } from '../routing.ts';
import { isPageParam, spelledSegment } from '../site-paths.ts';
import { HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNAUTHORIZED } from '../status.ts';
import { deploymentOf } from './artifact-deployments.ts';
import { keptHeaders } from './gate-answers.ts';
import type { Profile } from './view-tokens.ts';

/**
 * A generation's artifacts, made the one way the application's pages are rendered: by asking the
 * site for the route's page, as a visitor would, with the generation's token, which has the gate let
 * the request through to the page and the page render the generation the authority prepares (`<root
 * entry>` → `renderShared`). What the page answered is the artifact, as Next.js and React made it:
 * its body, and the page's own headers (`keptHeaders`) — never a cookie, nor anything of a session
 * — where the two are no more than an artifact may be (`MAX_ARTIFACT_BYTES`). The body is asked
 * for in no coding (`Accept-Encoding: identity`), and one still coded as it is read — of a coding
 * the platform's `fetch` leaves as it came (`readsAsWritten`), which a site or what is between
 * may answer whatever it was asked — is no artifact: its bytes are no text, and the artifact keeps
 * no `Content-Encoding` that would say what they are.
 */

/**
 * How the authority asks its site for a path: the host's, which knows the site's address, and lets
 * go of the request — its answer and its body — once `signal` aborts.
 */
export type SiteFetch = (
  path: string,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal,
) => Promise<Response>;

export interface GeneratedArtifact {
  readonly profile: Profile;
  /** The deployment of the site that answered it, as the answer says (`deploymentOf`). */
  readonly deployment: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/** What the page is asked for: its path, the profile of the artifact, and the generation's token. */
interface ArtifactRequest {
  readonly path: string;
  readonly profile: Profile;
  readonly token: string;
}

/**
 * The longest one request for an artifact may take, its body read: an artifact is one render
 * of the route's page by Next.js, which a site that answers at all answers well within it. A request
 * past it is let go of as a failure, and asked again as any other failure is: a site that took the
 * connection and never answers would otherwise hold the view's job, and the view, for good.
 */
export const ARTIFACT_DEADLINE_MS = 20_000;
/**
 * The most an artifact may be: its body and the headers it keeps, as the store writes them (UTF-8,
 * the headers as JSON). Well under the 2 MB a row of a Durable Object's SQLite holds, past which the
 * store would refuse the artifact, and its view would be left pending — every visitor answered 503
 * — for good. A page past it is no artifact (`UnsharedPageError`): its view is the request's.
 */
export const MAX_ARTIFACT_BYTES = 1_048_576;
const HTTP_OK = 200;
/** The statuses of a redirect, the first and the last (RFC 9110 §15.4). */
const FIRST_REDIRECT = 300;
const LAST_REDIRECT = 399;
const DOCUMENT_TYPE = 'text/html';
const PAYLOAD_TYPE = 'text/x-component';

/**
 * A page no artifact holds, let go of as soon as it was: asked for again, it would answer the same —
 * one past `MAX_ARTIFACT_BYTES`, or one that answers with a redirect or an interrupt rather than the
 * document or the payload, as a layout's `redirect()` or `notFound()` does (`outcomeOf`) — and its
 * view is the request's, for the page to answer each request as it does (`reason`, in a few words).
 */
export class UnsharedPageError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnsharedPageError';
    this.reason = reason;
  }
}

/**
 * The statuses Next.js answers a page with where its code says so itself — `notFound()`,
 * `unauthorized()`, `forbidden()` — rather than render it: of the page, whatever is asked again.
 */
const INTERRUPTED: ReadonlySet<number> = new Set([
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_UNAUTHORIZED,
]);

/**
 * What `response` answers in the document's or the payload's place, as its page's code said it
 * would: a redirect — its status, and where to (`Location`) — or an interrupt Next.js answers
 * (`INTERRUPTED`); none of anything else, a fault or the page itself.
 */
function outcomeOf(response: Response): string | undefined {
  const { status } = response;
  if (status >= FIRST_REDIRECT && status <= LAST_REDIRECT && response.headers.has('location')) {
    return 'a redirect';
  }
  return INTERRUPTED.has(status) ? `a ${String(status)}` : undefined;
}

/**
 * The media type of a `Content-Type`, as HTTP reads one: what is before its parameters, its blanks
 * aside, in any case (`Text/HTML; charset=utf-8` is `text/html`) — the whole type, never a prefix of
 * another (`text/html-extra`).
 */
function mediaTypeOf(contentType: string): string {
  return (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/** The bytes `text` takes as the store writes it, and as it is served: UTF-8's. */
export function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The payload decoder preserves every valid UTF-8 byte; documents retain their native text decoder. */
function decoderFor(profile: Profile): TextDecoder {
  return profile === 'rsc'
    ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    : new TextDecoder();
}

/**
 * The text of `body`, where it takes no more than `budget` bytes as the store writes it; `undefined`
 * where it would take more, the stream cancelled as soon as it does, never read whole.
 * RSC bytes must roundtrip through UTF-8 without replacements or dropping a BOM; otherwise the
 * existing private-generation path answers the page instead of keeping a corrupt payload.
 */
async function textWithin(
  body: ReadableStream<Uint8Array> | null,
  budget: number,
  profile: Profile,
): Promise<string | undefined> {
  if (body === null) {
    return budget < 0 ? undefined : '';
  }
  const reader = body.getReader();
  const decoder = decoderFor(profile);
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    let piece: string;
    try {
      piece = done ? decoder.decode() : decoder.decode(value, { stream: true });
    } catch (error) {
      if (profile !== 'rsc') throw error;
      await reader.cancel();
      throw new UnsharedPageError(
        'an rsc payload that cannot be kept as UTF-8 text',
        'A generation RSC payload contains bytes the text artifact store cannot preserve.',
        { cause: error },
      );
    }
    size += bytesOf(piece);
    if (size > budget) {
      await reader.cancel();
      return undefined;
    }
    text += piece;
    if (done) {
      return text;
    }
  }
}

/**
 * The path of a route's page for its params: each static segment its folder's name as a path spells
 * it (`spelledSegment`: `foo#bar` is `foo%23bar`, never a path cut short), and each dynamic segment
 * (`paramOfSegment`) its param as it is, as a page is handed one (`isPageParam`) — the segment of a
 * path that spells it, `a%2Fb` one segment. None where a param is no page's: written into a path, it
 * would be another (`..` is the path above), or one whose page renders other params, and the site
 * would answer another page.
 */
export function pathOf(route: string, params: RouteParams): string | undefined {
  const spelled = route.split('/').map((segment) => {
    const param = paramOfSegment(segment);
    if (param === undefined) {
      return spelledSegment(segment);
    }
    const value = ownValueOf(params, param) ?? '';
    return isPageParam(value) ? value : undefined;
  });
  return spelled.includes(undefined) ? undefined : spelled.join('/');
}

/**
 * The path of the page a view of `route` is made of, for its `params` (`pathOf`): a fault where
 * none is, never the path of another page — no view of such params is admitted (`paramsOfPath`,
 * `paramsOfProps`).
 */
export function pagePathOf(route: string, params: RouteParams): string {
  const path = pathOf(route, params);
  if (path === undefined) {
    throw new Error(`A shared view of ${route} has params no page is handed.`);
  }
  return path;
}

/**
 * What `promise` settles to, unless `signal` aborts first: its reason, then — whether or not what
 * `promise` waits for heeds the signal.
 */
async function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const abort = (): void => {
    reject(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/**
 * The page's answer for a generation's profile: refused unless it is the artifact asked for, and
 * as oversized where it is more than an artifact may be.
 */
async function artifactOf(
  fetchSite: SiteFetch,
  request: ArtifactRequest,
  signal: AbortSignal,
): Promise<GeneratedArtifact> {
  const { path, profile, token } = request;
  const headers: Record<string, string> = {
    'accept-encoding': 'identity',
    [GENERATION_HEADER]: token,
  };
  if (profile === 'rsc') {
    headers['rsc'] = '1';
  }
  const response = await fetchSite(path, headers, signal);
  const outcome = outcomeOf(response);
  if (outcome !== undefined) {
    await response.body?.cancel();
    throw new UnsharedPageError(
      `a ${profile} answered with ${outcome}`,
      `The page ${path} answered a generation's ${profile} with ${outcome} (${String(response.status)}).`,
    );
  }
  const type = response.headers.get('content-type') ?? '';
  const expected = profile === 'rsc' ? PAYLOAD_TYPE : DOCUMENT_TYPE;
  if (response.status !== HTTP_OK || mediaTypeOf(type) !== expected) {
    await response.body?.cancel();
    throw new Error(
      `The page ${path} answered ${String(response.status)} (${type || 'no content type'}) for a generation's ${profile}.`,
    );
  }
  if (!readsAsWritten(response)) {
    await response.body?.cancel();
    throw new Error(
      `The page ${path} answered a generation's ${profile} in a coding the platform's fetch reads as it came (${response.headers.get('content-encoding') ?? ''}).`,
    );
  }
  const kept = keptHeaders(response.headers);
  const body = await textWithin(
    response.body,
    MAX_ARTIFACT_BYTES - bytesOf(JSON.stringify(kept)),
    profile,
  );
  if (body === undefined) {
    throw new UnsharedPageError(
      `a ${profile} past the ${String(MAX_ARTIFACT_BYTES)} bytes an artifact may be`,
      `The page ${path} answered a generation's ${profile} past the ${String(MAX_ARTIFACT_BYTES)} bytes an artifact may be.`,
    );
  }
  return { body, deployment: deploymentOf(response.headers, body), headers: kept, profile };
}

/**
 * The page's answer for a generation's profile, its body read, within `ARTIFACT_DEADLINE_MS`:
 * refused unless it is the artifact asked for, refused as no artifact where it redirects or is past
 * `MAX_ARTIFACT_BYTES` (`UnsharedPageError`), and given up past the deadline — or as soon as `closing` aborts, as the
 * authority closes: the request and its deadline let go of then, neither left to outlive it.
 */
export async function fetchArtifact(
  fetchSite: SiteFetch,
  request: ArtifactRequest,
  closing: AbortSignal,
): Promise<GeneratedArtifact> {
  closing.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(
        `The page ${request.path} answered no generation's ${request.profile} within ${String(ARTIFACT_DEADLINE_MS)} ms.`,
      ),
    );
  }, ARTIFACT_DEADLINE_MS);
  const close = (): void => {
    controller.abort(closing.reason);
  };
  closing.addEventListener('abort', close, { once: true });
  try {
    return await unlessAborted(
      artifactOf(fetchSite, request, controller.signal),
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
    closing.removeEventListener('abort', close);
  }
}
