import { createElement, type ReactNode, type ReactPortal } from 'react';

import { AUTHORITY_UNAVAILABLE, type PublicView, type SessionId } from '../client/index.ts';
import {
  type FieldOperation,
  type FieldReceipt,
  type Json,
  type RenderResult,
  type Result,
  type Value,
  type View,
  VIEW_LIMITS,
  type ViewRequest,
} from '../program.ts';
import { LiveRoot } from '../react/live-root.tsx';
import { toJsonRecord } from '../runtime/json.ts';
import type { ViewAnswer as RootAnswer } from '../runtime/view.ts';
import { sitePathOf } from '../site-paths.ts';
import { HTTP_BAD_REQUEST } from '../status.ts';
import { authority, refused, requestSession, type SessionSource } from './authority.ts';
import { refusedRender } from './refusals.ts';
import { type Elements, renderTree } from './render.ts';
import { renderRouteRoot } from './shared-root.ts';
import { siteShape } from './site.ts';

/**
 * Reactive state in a Next.js application's server: what the files a compile writes call. A page
 * renders a root (`<Project projectId=… />`) as it renders any component; the root's entry asks the
 * authority to render it — the root and every reactive component it renders, at one revision — and
 * renders the tree it answers inside a `LiveRoot`, which keeps it current in the browser. The page
 * comes back through the compile's Server Functions: `viewRoot` renders the root again for the
 * sites the page shows; `updateField` writes a persistent state's setter's value; and `operate`
 * runs the application's own `'use server'` functions in the authority.
 */

export { authority, requestSession, routeSession, type SessionSource } from './authority.ts';
export { endSession, sessionKey } from './server-calls.ts';
export { type AuthorityRefusal, authorityRefusal } from './refusals.ts';
export { operate, OperationError } from './operate.ts';
export type { Elements } from './render.ts';

/** Where a root's event stream is read from: the route a compile writes (`./next/route`). */
export const EVENTS_PATH = '/api/reactive-state/events';

/**
 * Where the browser asks for a root's event stream: `EVENTS_PATH` where the site serves it, under
 * the build's base path and in its trailing-slash form — an `EventSource` is given no base path, as
 * Next.js's own links are, and a path in any other form is redirected first, or not served.
 */
function eventsUrl(): string {
  return sitePathOf(siteShape(), EVENTS_PATH);
}

export interface RenderRootOptions {
  /** The root's component id: its path in the application, without `.reactive.tsx`. */
  readonly component: string;
  /**
   * The props the page renders it with: JSON, an `undefined` prop left out. Typed as the component
   * declares them — an interface as well as a type literal, which no index signature takes — and
   * checked as JSON here.
   */
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- see above
  readonly props: Readonly<Record<string, Json>> | object;
  readonly elements: Elements;
  /** The compile's `update` Server Function, which the root's setters write through. */
  readonly update: (input: unknown) => Promise<Result<FieldReceipt>>;
  /** The compile's `view` Server Function, which renders the root again for what the page shows. */
  readonly view: (input: unknown) => Promise<Result<ViewAnswer>>;
  /**
   * The route whose page renders the root of its params, as the compile registered it: the root is
   * rendered as the route's shared view where the authority finds it one.
   */
  readonly route?: string | undefined;
  /**
   * Whether the entry renders the root inside a private cache (`'use cache: private'`), for a link's
   * prefetch to carry it: its page shows the frame it holds at once, and follows it from there
   * (`LiveRoot`).
   */
  readonly prefetchable?: boolean | undefined;
}

/**
 * A root rendered again for the view a page shows (`viewRoot`): the tree as React elements, rendered
 * here as `renderRoot` renders them, and the frame it was rendered at.
 */
export type ViewAnswer = RootAnswer<ReactNode>;

/** A JSON object: what a prop of data holds where it holds an object. */
type JsonObject = Readonly<Record<string, Json>>;

/**
 * Whether a prop typed `T` holds React's nodes: an element is assignable to it, alone or in a list,
 * where a JSON object — which a prop of data takes, typed `unknown` or `object` as well — is not.
 */
type HoldsNodes<T> = [ReactPortal] extends [T]
  ? [JsonObject] extends [T]
    ? false
    : true
  : [ReactPortal[]] extends [T]
    ? [JsonObject[]] extends [T]
      ? false
      : true
    : false;

/** The props of `P` TypeScript types as React's nodes. */
type NodePropsOf<P> = {
  [K in keyof P]-?: HoldsNodes<NonNullable<P[K]>> extends true ? K : never;
}[keyof P];

/**
 * What a page renders a root with, of a component whose parameter names the type of its props —
 * `Card({ header }: CardProps)` — rather than writing it, a type literal, which the compile reads:
 * `P` without the props TypeScript types as React's nodes, nor those the compile read (`Read`), each
 * member of a union apart. A page hands a root JSON alone, the props that hold nodes none of its own.
 */
export type RootProps<P, Read extends PropertyKey = never> = P extends unknown
  ? Omit<P, NodePropsOf<P> | Read>
  : never;

/** Why a write's outcome is unknown, as the page shows it while it sends the write again. */
const UNCONFIRMED = 'Whether the change was saved cannot be confirmed yet.';
/** Why a page is not brought up to date yet, as it asks again. */
const UNREFRESHED = 'The page could not be brought up to date yet.';
/** The bytes of a session's digest a page is told, which tell one session from another. */
const SESSION_NAME_BYTES = 12;
const HEX = 16;

/**
 * What a page is told of the session it was rendered for: a digest of its id, never the id — the
 * `HttpOnly` cookie, which a script that read it could present from anywhere — and nothing for no
 * session. It tells the page that it shows another session than before, whose pending operations
 * are not this one's.
 */
async function sessionName(session: SessionId): Promise<string> {
  if (session === null) {
    return '';
  }
  // An asserted session is named by its key and its user both, as the authority names it.
  const named = typeof session === 'string' ? session : `app.${session.id}.${session.user}`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`arkorlab.reactive-state.session:${named}`),
  );
  return Array.from(new Uint8Array(digest, 0, SESSION_NAME_BYTES), (byte) =>
    byte.toString(HEX).padStart(2, '0'),
  ).join('');
}

/**
 * A root, as the session the request names sees it: the authority renders it — and each reactive
 * component it renders — at one revision, and the tree is rendered inside a `LiveRoot` with the
 * frame it was rendered at. A root the session may not see renders nothing inside its `LiveRoot`,
 * which keeps following it, to render it once the session may. An authority that does not answer is
 * thrown for, as is a refusal to render the root at all, for the route's error boundary to show.
 */
export async function renderRoot(options: RenderRootOptions): Promise<ReactNode> {
  const { component, elements, route, update, view } = options;
  const prefetchable = options.prefetchable === true;
  const props = toJsonRecord(options.props, `The props ${component} is rendered with`);
  const live = async (result: RenderResult, session: SessionId): Promise<ReactNode> => {
    const { frame, status, tree } = result;
    return createElement(
      LiveRoot,
      {
        events: eventsUrl(),
        frame,
        ...(prefetchable && { prefetchable }),
        session: await sessionName(session),
        status,
        update,
        view,
      },
      status === 'rendered' ? renderTree(tree, elements) : null,
    );
  };
  if (route !== undefined) {
    const routed = await renderRouteRoot({
      component,
      elements,
      events: eventsUrl(),
      live,
      props,
      route,
    });
    if (routed !== undefined) {
      return routed;
    }
  }
  // The session first: while the page's shell is prerendered it never resolves, which leaves the
  // root to the request.
  const session = await requestSession(elements.session);
  const result = await authority().render(session, {
    build: elements.build,
    component,
    props,
  });
  if (!result.ok) {
    throw refusedRender(
      `The authority did not render ${component} (${String(result.status)} ${result.code}): ${result.message}`,
      result,
    );
  }
  return live(result.value, session);
}

function isRecord(value: Json): value is Readonly<Record<string, Json>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What a view request holds, and nothing else a caller sent beside it: the frame's subscription,
 * and the inputs of each site the page shows — JSON, within the limits the authority reads a view
 * by (`VIEW_LIMITS`). Anyone can post to a Server Function, so what it is sent is checked, not
 * trusted.
 */
function viewRequestOf(input: unknown): ViewRequest | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const { subscription, view } = input as Partial<Record<string, unknown>>;
  if (
    typeof subscription !== 'string' ||
    subscription === '' ||
    subscription.length > VIEW_LIMITS.subscription
  ) {
    return undefined;
  }
  let copied: Readonly<Record<string, Json>>;
  try {
    copied = toJsonRecord(view);
  } catch {
    return undefined;
  }
  const parts = Object.values(copied);
  if (
    parts.length > VIEW_LIMITS.parts ||
    new TextEncoder().encode(JSON.stringify(copied)).byteLength > VIEW_LIMITS.bytes
  ) {
    return undefined;
  }
  for (const sites of parts) {
    if (
      !isRecord(sites) ||
      Object.keys(sites).length > VIEW_LIMITS.sites ||
      Object.values(sites).some((inputs) => !isRecord(inputs))
    ) {
      return undefined;
    }
  }
  return { subscription, view: copied as View };
}

/**
 * The root a frame's subscription names, rendered again for the view a page shows, as its
 * `LiveRoot` asks for it (the compile's `view` Server Function): the tree, rendered as `renderRoot`
 * renders it, and its frame. Answered as a `Result`, a refusal too, since an error thrown across
 * the RSC boundary loses its status, which the page reads to tell a session that changed from a
 * view refused, and either from an authority that did not answer. The route is not rendered again:
 * the answer is the root's, and the page shows it in its place.
 */
export async function viewRoot(input: unknown, elements: Elements): Promise<Result<ViewAnswer>> {
  const request = viewRequestOf(input);
  if (request === undefined) {
    return refused(HTTP_BAD_REQUEST, 'INVALID_VIEW', 'The view is not valid.');
  }
  const result = await authority().view(await requestSession(elements.session), request);
  if (!result.ok) {
    return result.code === AUTHORITY_UNAVAILABLE ? { ...result, message: UNREFRESHED } : result;
  }
  const { frame, status, tree } = result.value;
  return {
    ok: true,
    value: { children: status === 'rendered' ? renderTree(tree, elements) : null, frame, status },
  };
}

function isValue(value: unknown): value is Value {
  return (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * The fields of a field operation the authority reads, and nothing else a caller sent beside them:
 * a `set` carries a value — `false`, `0` and `''` too — and an `apply` may carry what it captured,
 * never both. Anyone can post to a Server Function, so what it is sent is checked, not trusted.
 */
function fieldOperationOf(input: unknown): FieldOperation | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const { binding, captures, operationId, updaterId, value } = input as Partial<
    Record<string, unknown>
  >;
  if (
    typeof binding !== 'string' ||
    typeof operationId !== 'string' ||
    typeof updaterId !== 'string'
  ) {
    return undefined;
  }
  if (value !== undefined) {
    return captures === undefined && isValue(value)
      ? { binding, operationId, updaterId, value }
      : undefined;
  }
  if (captures === undefined) {
    return { binding, operationId, updaterId };
  }
  try {
    return { binding, captures: toJsonRecord(captures), operationId, updaterId };
  } catch {
    return undefined;
  }
}

/**
 * One write to a field, as a persistent state's setter sends it (the compile's `update` Server
 * Function): answered as a `Result`, since an error thrown across the RSC boundary loses its status,
 * which the page's store reads to tell a refused write from one whose outcome is unknown.
 */
export async function updateField(
  input: unknown,
  session?: SessionSource,
): Promise<Result<FieldReceipt>> {
  const operation = fieldOperationOf(input);
  if (operation === undefined) {
    return refused(HTTP_BAD_REQUEST, 'INVALID_OPERATION', 'The operation is not valid.');
  }
  const result = await authority().update(await requestSession(session), operation);
  return result.ok || result.code !== AUTHORITY_UNAVAILABLE
    ? result
    : { ...result, message: UNCONFIRMED };
}

/**
 * A record's public fields, as anyone may see them, for a page rendered without a session. Thrown
 * for rather than answered: what such a page renders is kept, and served to everybody.
 */
export async function publicView(table: string, id: string): Promise<PublicView> {
  const view = await authority().publicView(table, id);
  if (!view.ok) {
    throw new Error(
      `The authority answered the public view of ${table}:${id} with ${String(view.status)} ${view.code}: ${view.message}`,
    );
  }
  return view.value;
}
