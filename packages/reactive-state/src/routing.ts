import type { Json, RenderResult } from './program.ts';

/**
 * What a compile learns of an application's routes, and what the authority, the host and the edge
 * exchange about them: which page renders which root with which of its params, the route middleware
 * around it (each `middleware.ts` under the app directory), whether its document can be one
 * artifact every visitor is answered with, and how a route's gate answers a request for it.
 * Runtime-neutral — the edge's gate, a Function and the authority read it alike.
 */

/** The name the build declares its shared routes' gate under, which the host binds a gate to. */
export const GATE_NAME = 'reactive';

/** The header the edge tells a route's gate which route a request is of. */
export const GATE_ROUTE_HEADER = 'x-upwind-gate-route';

/**
 * The header the edge tells a route's gate which deployment of the site a request is of: its
 * manifest's, as the deployment's Functions name it (`NEXT_DEPLOYMENT_ID`). Under the protocol's
 * prefix, which the edge takes off whatever a visitor sends.
 */
export const GATE_DEPLOYMENT_HEADER = 'x-upwind-gate-deployment';

/** The header a gate answers with to have the request served as if there were no gate. */
export const GATE_ANSWER_HEADER = 'x-upwind-gate';

/** `GATE_ANSWER_HEADER`'s value for a request the gate leaves to the rest of the path. */
export const GATE_PASS = 'pass';

/**
 * The header the delivery route asks a route's page for itself with, past the rewrite that brings
 * every other request of a route under route middleware to it: its value is the build's delivery
 * key (`DELIVERY_KEY_ENV`), which the rewrite matches whole, so that no request a visitor makes
 * reaches such a page without the middleware's envelopes around it.
 */
export const DIRECT_HEADER = 'x-reactive-direct';
/** An initial guard decision, accepted only across the private delivery boundary. */
export const ADMISSION_HEADER = 'x-reactive-admission';

/**
 * The variable the adapter hands the build its delivery key in (`config.env`): made for each build,
 * written into the rewrite and into the delivery route, which Next.js compiles it into; nowhere else.
 */
export const DELIVERY_KEY_ENV = 'REACTIVE_STATE_DELIVERY_KEY';

/**
 * The header the authority asks for a route's page with to make a generation's artifact: the
 * generation's token, signed and short-lived, which the gate lets through to the page and the page
 * hands back to the authority — which renders the generation it prepares, and refuses any other.
 */
export const GENERATION_HEADER = 'x-reactive-generation';

/** The path under the compile's route (`/api/reactive-state`) a middleware route is delivered at. */
export const DELIVER_PATH = 'deliver';

/**
 * A route as the delivery route is told it, in one segment of a path (`deliver/<key>/<params>…`),
 * as the route's rewrite writes it: its name in base64url, which no path normalizes. The route's
 * params follow it, each a segment of its own; a catch-all's, the rest.
 */
export function routeKeyOf(route: string): string {
  const bytes = new TextEncoder().encode(route);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * A dynamic segment of a route, as Next.js reads one (`getSegmentParam`, checked as it sorts its
 * routes): `[name]` takes one segment of a path; a catch-all, `[...name]`, one or more; an optional
 * one, `[[...name]]`, any number. Its name — any text of no bracket that starts with no period:
 * `[$project]`, `[project-id]`, `[v1.0]` — is the key Next.js gives the page the param under; the
 * compile registers a route by it, the authority and the delivery route read a path by it, and the
 * adapter's rewrite matches it, alike.
 */
export interface DynamicSegment {
  readonly name: string;
  readonly kind: 'catchall' | 'dynamic' | 'optional-catchall';
}

/** Each form of a dynamic segment, its name grouped, and the kind it is. */
const DYNAMIC_SEGMENTS: readonly (readonly [RegExp, DynamicSegment['kind']])[] = [
  [/^\[\[\.{3}(?<name>[^.[\]][^[\]]*)\]\]$/u, 'optional-catchall'],
  [/^\[\.{3}(?<name>[^.[\]][^[\]]*)\]$/u, 'catchall'],
  [/^\[(?<name>[^.[\]][^[\]]*)\]$/u, 'dynamic'],
];

/** The dynamic segment a segment of a route is; none for a static one, or one Next.js refuses. */
export function dynamicSegmentOf(segment: string): DynamicSegment | undefined {
  for (const [pattern, kind] of DYNAMIC_SEGMENTS) {
    const name = pattern.exec(segment)?.groups?.['name'];
    if (name !== undefined) {
      return { kind, name };
    }
  }
  return undefined;
}

/**
 * The param a segment of a route takes one segment of a path for (`[projectId]`); none for a static
 * segment, or a catch-all, which the compile registers no route of.
 */
export function paramOfSegment(segment: string): string | undefined {
  const dynamic = dynamicSegmentOf(segment);
  return dynamic?.kind === 'dynamic' ? dynamic.name : undefined;
}

/**
 * A page of the application that renders a reactive root of its route's params: what the compile
 * read of `<app>/<page>`, which resolves the params and hands them to the root, as
 * `const { projectId } = await params; return <PublicBoard projectId={projectId} />;` does.
 */
export interface RouteRegistration {
  /**
   * The route, as Next.js names it — the page's directory under the app, route groups left out,
   * dynamic segments as written (`/boards/[projectId]`).
   */
  readonly route: string;
  /** The page's file, under the app directory (`boards/[projectId]/page.tsx`). */
  readonly page: string;
  /** The root the page renders. */
  readonly root: string;
  /** Each of the root's props, by the route param it is given. */
  readonly props: Readonly<Record<string, string>>;
  /** The route's params, in the order its path names them. */
  readonly params: readonly string[];
  /** The route middleware around the page, outermost first, by its id (`MiddlewareRegistration`). */
  readonly middleware: readonly string[];
  /**
   * Whether the page awaits its params outside any `<Suspense>`: a page its root is the whole of,
   * which Cache Components prerenders as a blocking route only where it is let to.
   */
  readonly blocking: boolean;
  /**
   * Whether the route's document may be one artifact for every visitor: its root is given every
   * param of the route, which the view is one of; it reaches no identity, no input nothing tracks
   * and no binding of a session's; and no layout, template, loading state or page around it reaches
   * the request, the identity, such an input or a library. Where it is not, why (`private`).
   */
  readonly shared: boolean;
  readonly private?: string;
  /**
   * Whether a guard of the route's middleware may answer a response of its own in the route's place
   * — a redirect to a sign-in page, say — rather than let the request on or refuse it. Left out
   * where no guard can.
   */
  readonly answers?: true;
  /**
   * Whether a middleware of the route's has a guard the authority runs: the delivery route asks the
   * authority of each request of the route before it hands it to the page — a write, any request but
   * a `GET` or a `HEAD`, and a read of a route of the request's, before anything of its page renders;
   * a read of a route every visitor shares its gate answers. Left out where none has, which the
   * authority could only let the request on for: it is handed to the page with nothing asked.
   */
  readonly guarded?: true;
}

/**
 * A route under route middleware that is no reactive route: a page that renders no reactive root of
 * the compile's — a sign-in page, say — or a route handler (`route.ts`). Delivered as a reactive
 * route under middleware is — its every request through the delivery route, inside the envelopes —
 * and, where its chain has a guard, asked of the guards before each request is handed on, reads
 * included: no reactive render runs them for it.
 */
export interface PlainRouteRegistration {
  /** What it is: a page of no reactive root, or a route handler. */
  readonly plain: 'handler' | 'page';
  /** The route, as Next.js names it: as a reactive route's (`RouteRegistration.route`). */
  readonly route: string;
  /** Its file, under the app directory (`sign-in/page.tsx`, `api/items/route.ts`). */
  readonly file: string;
  /** The route's params, in the order its path names them: one segment each. */
  readonly params: readonly string[];
  /** The route middleware around it, outermost first, by its id: one at least. */
  readonly middleware: readonly string[];
  /** As a reactive route's (`RouteRegistration.answers`). */
  readonly answers?: true;
  /** Whether a middleware of the route's has a guard: each request is asked of the guards first. */
  readonly guarded?: true;
}

/** A route the compile registered: a reactive one, or one of no reactive root under middleware. */
export type RegisteredRoute = PlainRouteRegistration | RouteRegistration;

/** Whether `route` is one of no reactive root (`PlainRouteRegistration`). */
export function isPlainRoute(route: RegisteredRoute): route is PlainRouteRegistration {
  return 'plain' in route;
}

/**
 * Where under the app directory the compile writes its own route, which delivers the routes under
 * middleware (`<app>/api/reactive-state/[...path]/route.ts`): no route of the application's.
 */
export const COMPILE_ROUTE_DIRECTORY = 'api/reactive-state/[...path]';

/**
 * A route middleware file, `<app>/<dir>/middleware.ts`, as the compile split it at its
 * `await next()`: its guard — what it reads of the database and the session before it, and the
 * conditions on them — which the authority runs; and its envelope — what it computes of the request
 * alone before `next`, and does to the response after it — which the host runs for each request.
 */
export interface MiddlewareRegistration {
  /** The directory under the app it stands in: `''` for the app's own, `boards/[projectId]`. */
  readonly id: string;
  /** Whether its guard reads the session's identity: a route under it is the request's. */
  readonly identity: boolean;
  /** Whether it has a guard the authority runs. */
  readonly guard: boolean;
  /** Whether it has an envelope the host runs. */
  readonly envelope: boolean;
}

/** The params of a route a request is of, by name. */
export type RouteParams = Readonly<Record<string, string>>;

/**
 * A response a guard answers itself, without the rest of the route (`return new Response(…)` before
 * `await next()`): what the host makes the response of.
 */
export interface ResponseDescriptor {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/**
 * A route middleware's guard, as the compile writes it for the authority
 * (`middleware/<id>.guard.mts`): the code before its `await next()` that reads the database or the
 * session, run as written with the route's params. It answers nothing to go on, or the response it
 * answers itself.
 */
export interface MiddlewareProgram {
  readonly protocolVersion: number;
  readonly buildId: string;
  readonly id: string;
  guard(context: { readonly params: RouteParams }): unknown;
}

/**
 * A route middleware's envelope, as the compile writes it for the host
 * (`middleware/<id>.envelope.ts`): what it computes of the request before `next` (`before`, whose
 * answer `after` reads), and what it does to the response after it.
 */
export interface MiddlewareEnvelope {
  readonly id: string;
  readonly before?: (context: {
    readonly request: Request;
    readonly params: RouteParams;
  }) => Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
  readonly after?: (
    locals: Readonly<Record<string, unknown>>,
    response: Response,
  ) => Promise<void> | void;
}

/** What a request for a route's document asks for: the document, a router payload, a prefetch. */
export type Representation = 'document' | 'prefetch' | 'rsc';

/**
 * A shared view a page shows: the signed token its event stream follows it by, the generation of
 * what it shows, and the access epoch it was published in.
 */
export interface SharedView {
  readonly token: string;
  readonly generation: number;
  readonly epoch: number;
}

/** What a shared view's token says of the view it is of, which every generation of it shares. */
export interface ClaimedView {
  readonly route: string;
  readonly params: RouteParams;
  /** The build the view is of: another build's view of the route is another view. */
  readonly build: string;
}

/**
 * What a shared view's token (`SharedView.token`) says of the view it is of — the route, its
 * params, the build — read as it is written, unchecked: for what tells one view from another, or
 * which middleware wraps its stream; the authority checks the token itself, and refuses one it did
 * not sign. None for a token that says none of it.
 */
export function claimedView(token: string): ClaimedView | undefined {
  try {
    const [encoded = ''] = token.split('.', 1);
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    const text = new TextDecoder().decode(
      Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0),
    );
    const claims: unknown = JSON.parse(text);
    const { build, params, route } = (claims ?? {}) as Partial<Record<string, unknown>>;
    return typeof route === 'string' && typeof build === 'string' && isRouteParams(params)
      ? { build, params, route }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a site serves its routes, as Next.js compiled its build: under its `basePath` (`''` for
 * none), and whether each path ends with a slash (`trailingSlash`) — a route's page answered at
 * that form alone, any other redirected or not served (`site-paths.ts`) — unless Next.js makes none
 * of those redirects (`skipTrailingSlashRedirect`), and serves each path at either form.
 */
export interface SiteShape {
  readonly basePath: string;
  readonly trailingSlash: boolean;
  /** Whether Next.js serves each path with a slash after it or not alike: absent where it does not. */
  readonly skipTrailingSlashRedirect?: true;
}

/**
 * A route's root rendered as the route's shared document renders it: the route, and the props the
 * page renders the root with — the route's params, by the props they are given as, and any other
 * JSON the page gives the root, a render of which is of no shared view.
 */
export interface SharedRenderRequest {
  /** The delivery's guard decision, used only by its initial session render. */
  readonly admission?: string;
  readonly route: string;
  readonly props: Readonly<Record<string, Json>>;
  readonly build: string;
  /** The token of the render the authority asked for, which renders the generation it prepares. */
  readonly generation?: string;
  /**
   * Where the site serves its routes, as the page's build says: for the authority to ask for a
   * route's page where it is served, and its gate to read a request's path as Next.js does.
   */
  readonly site?: SiteShape;
}

/**
 * What a shared render answers: the root as every visitor sees it, and the view it is of; or, for a
 * root the request's session decides — a guard or a component read its identity — and for props of
 * no view, the session's render of it, as `render` answers one.
 */
export type SharedRenderAnswer =
  | { readonly kind: 'shared'; readonly result: RenderResult; readonly view: SharedView }
  | { readonly kind: 'session'; readonly result: RenderResult };

/** A request for a route the gate is asked of: its route, what was asked, and how. */
export interface GateRequest {
  readonly route: string;
  /** The pathname and the query the visitor asked for. */
  readonly url: string;
  readonly method: 'GET' | 'HEAD';
  /** The headers of the request the gate reads, lowercased. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Where the site serves its routes, where whoever asks knows it — the application's server, from
   * the build it runs — for the gate to read `url` as Next.js does from the first request on.
   */
  readonly site?: SiteShape;
  /**
   * The deployment of the site the request is of (`NEXT_DEPLOYMENT_ID`): an artifact answers it
   * only where that deployment made it. None where whoever asks names none — an edge older than
   * this, or a site of no deployments — which an artifact a deployment made answers never.
   */
  readonly deployment?: string;
}

/**
 * The gate's answer: the response to give — the artifact, a 304, the generic 403, a 503 — or to
 * serve the request as if there were no gate.
 */
export type GateAnswer =
  | {
      readonly kind: 'respond';
      readonly status: number;
      readonly headers: readonly (readonly [string, string])[];
      /** The body, in base64; none for a 304, or for a `HEAD`. */
      readonly body: string | null;
      /**
       * Where a guard of the route's middleware decided the answer in the route's place, the
       * middleware whose guard did, by id: a response it answered itself, or its refusal of the
       * view (`refused`). What the delivery route reads of which of the envelopes' after parts
       * reach the answer — none of a refusal, which the source's guard throws past every
       * `await next()`; those outside the guard's middleware of its response — and the edge, which
       * runs no envelope, reads nothing of.
       */
      readonly by?: string;
      readonly refused?: true;
    }
  | {
      readonly kind: 'pass';
      /**
       * Let through as the authority's own request for a generation's artifact, its token one the
       * authority signed for the route — what the delivery route lets past the envelopes, and
       * nothing else it is let through for.
       */
      readonly generation?: true;
    };

/**
 * A request of a route its guards are asked of, as the delivery route asks before it asks for the
 * page: the route, and what was asked — of which the authority reads the route's params itself.
 */
export interface GuardRequest {
  /** Ask for a bounded decision for the initial render of a reactive route. */
  readonly admit?: true;
  readonly route: string;
  /** The pathname and the query the visitor asked for. */
  readonly url: string;
}

/**
 * What a route's guards say of a request, for its session: go on to the page; the root refused
 * (`forbidden()`), which the page renders as its render refuses it; or the response a guard answered
 * itself, as the gate answers one — the request's own (`private, no-store`), its body whole — with
 * the middleware whose guard answered it (`by`), outside which alone the envelopes' after parts are
 * around it, as the source's `return` hands it to the `next` of the middleware around.
 */
export type GuardAnswer =
  | Extract<GateAnswer, { readonly kind: 'respond' }>
  | { readonly kind: 'pass'; readonly admission?: string }
  | { readonly kind: 'refused' };

/** What an event stream of a shared view says: a newer generation ready, or the view denied. */
export type SharedEvent =
  | { readonly kind: 'ready'; readonly generation: number; readonly epoch: number }
  | { readonly kind: 'denied'; readonly epoch: number };

/**
 * The registry's routes and middleware, as `authority.mts` exports them: each route middleware by
 * its id, its guard program or `null` for one with no guard.
 */
export interface RouteTable {
  readonly routes: readonly RegisteredRoute[];
  readonly middleware: Readonly<Record<string, MiddlewareProgram | null>>;
}

/**
 * The value `record` holds of `name` itself, none of its prototype's: an object's `constructor` is
 * no route's param, nor a root's prop. A map of params or props is made of its own properties alike
 * (`Object.fromEntries`), which a name assigned — `__proto__` above all — is not.
 */
export function ownValueOf<T>(record: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/** Whether `value` is a JSON object of strings: a route's params. */
export function isRouteParams(value: unknown): value is RouteParams {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Readonly<Record<string, Json>>).every((item) => typeof item === 'string')
  );
}
