import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { createElement, type ReactNode } from 'react';

import type { SessionId } from '../client/contract.ts';
import type { Json, RenderResult } from '../program.ts';
import { SharedRoot } from '../react/shared-root.tsx';
import { ADMISSION_HEADER, DIRECT_HEADER, GENERATION_HEADER } from '../routing.ts';
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND } from '../status.ts';
import { authority, requestSession } from './authority.ts';
import { refusedRender } from './refusals.ts';
import { type Elements, renderTree } from './render.ts';
import { siteShape } from './site.ts';

/**
 * A root a route registered, rendered as the route's page renders it: the shared view every visitor
 * is answered with, inside a `SharedRoot` that follows the view — the generation the authority asked
 * the page for, where the request carries its token (`x-reactive-generation`), which the page renders
 * for the authority to keep as the generation's artifact — or, for a route the authority found to be
 * the request's, and for props of no view of the route's (another page's render of the root, of
 * props of its own), the session's render of it, as any root is rendered, in the same round trip.
 * The session is read all the same, for that render, and goes no further: a shared view takes
 * nothing of it. A request that names a generation the authority does not make is answered that the
 * page is not there.
 */

export interface RouteRootOptions {
  readonly route: string;
  readonly component: string;
  readonly props: Readonly<Record<string, Json>>;
  readonly elements: Elements;
  readonly events: string;
  /** A session's render of the root, as `renderRoot` shows one. */
  readonly live: (result: RenderResult, session: SessionId) => Promise<ReactNode>;
  /** The session the root's entry read, where it read it: no cookie of the request's is read then. */
  readonly session?: SessionId | undefined;
}

/** The refusal of a request that names a generation the authority is not making. */
const NOT_A_GENERATION = 'NOT_A_GENERATION';
/** Refusals that say the route renders this root no shared way: the route is rendered as any root. */
const NOT_SHARED: ReadonlySet<number> = new Set([HTTP_BAD_REQUEST, HTTP_NOT_FOUND]);

/** A visitor header is accepted only with the private delivery key, never for a generation. */
function admissionOf(requested: Headers, generation: string | undefined): string | undefined {
  const key = process.env['REACTIVE_STATE_DELIVERY_KEY'];
  if (
    generation !== undefined ||
    key === undefined ||
    key === '' ||
    requested.get(DIRECT_HEADER) !== key
  ) {
    return undefined;
  }
  return requested.get(ADMISSION_HEADER) ?? undefined;
}

/** The root, as its route's page renders it; nothing where the route renders it no shared way. */
export async function renderRouteRoot(options: RouteRootOptions): Promise<ReactNode> {
  const { component, elements, events, props, route } = options;
  const [session, requested] = await Promise.all([
    options.session === undefined ? requestSession(elements.session) : options.session,
    headers(),
  ]);
  const generation = requested.get(GENERATION_HEADER) ?? undefined;
  const admission = admissionOf(requested, generation);
  const answer = await authority().renderShared(session, {
    build: elements.build,
    props,
    route,
    site: siteShape(),
    ...(admission !== undefined && { admission }),
    ...(generation !== undefined && { generation }),
  });
  if (!answer.ok) {
    if (answer.code === NOT_A_GENERATION) {
      notFound();
    }
    if (NOT_SHARED.has(answer.status)) {
      return undefined;
    }
    throw refusedRender(
      `The authority did not render ${component} for ${route} (${String(answer.status)} ${answer.code}): ${answer.message}`,
      answer,
    );
  }
  if (answer.value.kind === 'session') {
    return options.live(answer.value.result, session);
  }
  const { frame, status, tree } = answer.value.result;
  return createElement(
    SharedRoot,
    { events, frame, status, view: answer.value.view },
    status === 'rendered' ? renderTree(tree, elements) : null,
  );
}
