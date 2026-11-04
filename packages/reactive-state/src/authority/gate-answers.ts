import {
  type GateAnswer,
  type GateRequest,
  type Representation,
  type ResponseDescriptor,
} from '../routing.ts';
import { SHARED_CACHE_HEADERS } from '../shared-cache.ts';
import { shortDigest } from './canonical.ts';
import type { StoredArtifact } from './shared-store.ts';
import type { Profile } from './view-tokens.ts';

/**
 * What a route's gate answers, made of what the authority decided: an artifact as the page answered
 * it, a 304 for the artifact a browser holds, the generic 403 — the same for a project that is gone
 * and one that is not public — and the 503 of a decision the authority could not make. None is for
 * a shared cache: each is the request's own (`private`), an artifact one a browser revalidates.
 */

const HTTP_OK = 200;
const HTTP_NOT_MODIFIED = 304;
const HTTP_FORBIDDEN = 403;
const HTTP_UNAVAILABLE = 503;

const CACHE_CONTROL = 'cache-control';
/** What a browser may keep of an artifact: its own copy, revalidated before every use. */
const ARTIFACT_CACHE = 'private, no-cache';
/** What no one keeps: a refusal, an outage, a guard's own response. */
const NO_STORE = 'private, no-store';
/**
 * The cache directives of a guard's own response, which the gate's `NO_STORE` answers for in their
 * place: one beside it — a browser's own `Cache-Control`, or one a shared cache reads in its place
 * (`SHARED_CACHE_HEADERS`) — would be read as well, or first, or alone, by whatever reads only one.
 */
const GUARD_CACHE_HEADERS: ReadonlySet<string> = new Set([CACHE_CONTROL, ...SHARED_CACHE_HEADERS]);
/**
 * The request headers an artifact varies on, as Next.js's own responses say: with whatever else the
 * page's own `Vary` names (`varyOf`).
 */
const VARY = 'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch';
const VARY_HEADER = 'vary';

/**
 * The headers of a page's answer that are the page's own, as Next.js 16.4.2 writes them on a
 * document or a payload: what an artifact keeps, to answer each request with as the page would.
 * Its media type; its `Vary` (`getVaryHeader`), which the gate's is merged with; the preloads React
 * hints at as it renders (`Link`, Fizz's `onHeaders`); what the browser's router reads of what it is
 * answered — the deployment it is of (`x-nextjs-deployment-id`), how long it may keep it
 * (`x-nextjs-stale-time`), that its render was postponed (`x-nextjs-postponed`), that the build
 * prerendered it (`x-nextjs-prerender`); and `X-Powered-By`, where the config leaves it on.
 *
 * Nothing a routing rule lays on a request — `next.config`'s `headers()`, its policies, CORS, a
 * rewrite's — which held, or not, for the authority's own request: the edge lays the rules a
 * visitor's request matches on a gated answer, and the Function's runtime on a delivered one. Nor
 * anything of a session's, of the gate's own (its lifetime and validators), of the one
 * transmission's, or of Next.js's cache for the one request (`x-nextjs-cache`).
 */
const PAGE_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'link',
  'vary',
  'x-nextjs-deployment-id',
  'x-nextjs-postponed',
  'x-nextjs-prerender',
  'x-nextjs-stale-time',
  'x-powered-by',
]);

/** The page's headers an artifact keeps, of the page's answer to the authority (`PAGE_HEADERS`). */
export function keptHeaders(headers: Headers): (readonly [string, string])[] {
  return [...headers].filter(([name]) => PAGE_HEADERS.has(name));
}

/** The `Vary` of an artifact's answer: the gate's, and whatever else the page said it varies on. */
function varyOf(headers: readonly (readonly [string, string])[]): string {
  const tokens = new Map<string, string>();
  const values = headers.filter(([name]) => name === VARY_HEADER).map(([, value]) => value);
  const named = [VARY, ...values].flatMap((value) => value.split(','));
  for (const token of named) {
    const trimmed = token.trim();
    if (trimmed !== '' && !tokens.has(trimmed.toLowerCase())) {
      tokens.set(trimmed.toLowerCase(), trimmed);
    }
  }
  return [...tokens.values()].join(', ');
}

const FORBIDDEN_PAGE =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>';
const UNAVAILABLE_PAGE =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>503 Service Unavailable</title></head><body><h1>503 Service Unavailable</h1></body></html>';

export const PASS: GateAnswer = Object.freeze({ kind: 'pass' });
/** `PASS`, for the authority's own request for a generation's artifact (`GENERATION_HEADER`). */
export const GENERATION_PASS: GateAnswer = Object.freeze({ generation: true, kind: 'pass' });

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function page(status: number, html: string, request: GateRequest): GateAnswer {
  return {
    body: request.method === 'HEAD' ? null : base64(html),
    headers: [
      [CACHE_CONTROL, NO_STORE],
      ['content-type', 'text/html; charset=utf-8'],
    ],
    kind: 'respond',
    status,
  };
}

/** The generic refusal: the same whether the route's record is gone or not public. */
export function forbiddenAnswer(request: GateRequest): GateAnswer {
  return page(HTTP_FORBIDDEN, FORBIDDEN_PAGE, request);
}

/** The answer of a decision the authority could not make in time, or of an artifact it failed. */
export function unavailableAnswer(request: GateRequest): GateAnswer {
  return page(HTTP_UNAVAILABLE, UNAVAILABLE_PAGE, request);
}

/**
 * The response a route middleware's guard answered: for every visitor, at the gate, or for the
 * request's session (`guardRoute`), whose answer is the body whole, as a `GET`'s — each of its
 * headers as it set them, a field it repeats (`Set-Cookie`) repeated, and kept by no one: the gate's
 * `private, no-store` its only cache directive (`GUARD_CACHE_HEADERS`).
 */
export function respondedAnswer(
  response: ResponseDescriptor,
  request: Pick<GateRequest, 'method'>,
): Extract<GateAnswer, { readonly kind: 'respond' }> {
  const own = response.headers.filter(([name]) => !GUARD_CACHE_HEADERS.has(name.toLowerCase()));
  return {
    body: request.method === 'HEAD' ? null : base64(response.body),
    headers: [[CACHE_CONTROL, NO_STORE], ...own],
    kind: 'respond',
    status: response.status,
  };
}

/**
 * `answer`, as a guard of the route's middleware decided it in the route's place — refused the view
 * (`refused`), or answered a response of its own — by the middleware `by`; as it is where none did,
 * the view's root refusing it among what is so. The delivery route reads it for which of the
 * envelopes' after parts reach the answer; the edge reads nothing of it.
 */
export function decidedBy(
  answer: GateAnswer,
  by: string | undefined,
  refused: boolean,
): GateAnswer {
  if (by === undefined || answer.kind !== 'respond') {
    return answer;
  }
  return refused ? { ...answer, by, refused: true } : { ...answer, by };
}

/** What a request asks for of a route's page: a prefetch, the router's payload, or the document. */
export function representationOf(request: GateRequest): Representation {
  const { headers } = request;
  if (headers['rsc'] !== '1') {
    return 'document';
  }
  return headers['next-router-prefetch'] === undefined &&
    headers['next-router-segment-prefetch'] === undefined
    ? 'rsc'
    : 'prefetch';
}

/**
 * The ETag of a generation's artifact: its view, generation, access epoch, profile and the deployment
 * of the site that made it — a browser's copy of one deployment's page is no 304 of another's.
 */
export function etagOf(
  view: string,
  generation: number,
  epoch: number,
  made: { readonly profile: Profile; readonly deployment: string },
): string {
  return `"rs-${shortDigest([view, generation, epoch, made.profile, made.deployment])}"`;
}

/**
 * An entity-tag as it opens a list's element (RFC 9110 §8.8.3): `W/` where it is weak, then its
 * opaque tag — any visible character but a double quote, or any byte past ASCII, between double
 * quotes, a comma among them.
 */
const ENTITY_TAG = /^(?:W\/)?"[\u{21}\u{23}-\u{7E}\u{80}-\u{FF}]*"/u;
/** The optional whitespace around a list's elements (§5.6.3). */
const BLANKS = /^[\t ]*/u;

/** `text`, its leading optional whitespace aside. */
function pastBlanks(text: string): string {
  return text.slice(BLANKS.exec(text)?.[0].length ?? 0);
}

/**
 * The entity-tags an `If-None-Match` lists (§13.1.2): each element of the list (§5.6.1) parted from
 * the next by a comma outside the quotes — a comma inside an opaque tag is the tag's own — empty
 * elements and the blanks around them aside. None of a field that is no such list — text that is no
 * entity-tag, two with no comma between them, a quote left open, a `*` among tags — which names
 * nothing, as `fresh` matches nothing of one.
 */
function entityTagsOf(field: string): readonly string[] | undefined {
  const tags: string[] = [];
  let rest = pastBlanks(field);
  while (rest !== '') {
    if (rest.startsWith(',')) {
      rest = pastBlanks(rest.slice(1));
      continue;
    }
    const tag = ENTITY_TAG.exec(rest)?.[0];
    if (tag === undefined) {
      return undefined;
    }
    tags.push(tag);
    rest = pastBlanks(rest.slice(tag.length));
    if (rest !== '' && !rest.startsWith(',')) {
      return undefined;
    }
  }
  return tags;
}

/** An entity-tag's opaque tag: weakly compared, `W/"x"` names what `"x"` does (§8.8.3.2). */
function opaqueOf(tag: string): string {
  return tag.startsWith('W/') ? tag.slice('W/'.length) : tag;
}

/**
 * Whether `ifNoneMatch` names `etag`: `*` as the whole field, or one entity-tag of its list compared
 * weakly (`entityTagsOf`).
 */
function names(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) {
    return false;
  }
  if (ifNoneMatch.trim() === '*') {
    return true;
  }
  const opaque = opaqueOf(etag);
  return entityTagsOf(ifNoneMatch)?.some((tag) => opaqueOf(tag) === opaque) ?? false;
}

/**
 * An artifact, as the gate answers it: a 304 where the browser holds it, itself otherwise — the
 * page's own headers, with the gate's lifetime, validator and `Vary` (`varyOf`). Of a request's
 * preconditions, `If-None-Match` alone is judged, compared weakly — as Next.js 16.4.2 answers a
 * page's `GET` or `HEAD`, whose answer is judged by `fresh` (`sendRenderResult`), which reads
 * `If-None-Match` and `If-Modified-Since` and nothing else: an `If-Match` the page fails, or an
 * `If-Unmodified-Since` before it, is answered the page all the same, and the 304 an `If-None-Match`
 * beside it asks for. Only its file server (`send`) answers 412, and the platform's edge judges
 * them of shipped files alone, as `send` does. The gate is asked of a `GET` or a `HEAD` alone: any
 * other request goes to the page.
 */
export function artifactAnswer(artifact: StoredArtifact, request: GateRequest): GateAnswer {
  const headers: (readonly [string, string])[] = [
    ...artifact.headers.filter(([name]) => name !== VARY_HEADER),
    [CACHE_CONTROL, ARTIFACT_CACHE],
    ['etag', artifact.etag],
    [VARY_HEADER, varyOf(artifact.headers)],
  ];
  if (names(request.headers['if-none-match'], artifact.etag)) {
    return { body: null, headers, kind: 'respond', status: HTTP_NOT_MODIFIED };
  }
  return {
    body: request.method === 'HEAD' ? null : base64(artifact.body),
    headers,
    kind: 'respond',
    status: HTTP_OK,
  };
}

/** The profile of the artifact a representation is answered with; none for a prefetch. */
export function profileOf(representation: Representation): Profile | undefined {
  if (representation === 'prefetch') {
    return undefined;
  }
  return representation === 'rsc' ? 'rsc' : 'document';
}
