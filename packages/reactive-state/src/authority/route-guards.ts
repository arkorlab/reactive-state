import type { GuardAnswer, GuardRequest, RegisteredRoute, RouteParams } from '../routing.ts';
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND } from '../status.ts';
import { Dependencies } from './dependencies.ts';
import { refusal } from './errors.ts';
import { Call } from './evaluation.ts';
import { respondedAnswer } from './gate-answers.ts';
import { guardAdmission } from './guard-admissions.ts';
import { guardsOf, runGuards } from './guards.ts';
import type { Core, Session } from './model.ts';
import { paramsOfPath } from './route-registry.ts';
import { rendererOf } from './views.ts';

/**
 * A route's guards, asked of for one request by the host that delivers the route, before it asks for
 * the page (`guardRoute`): run for the request's session — or for none — as a render of the route's
 * root runs them, of the params the authority reads of the URL by the route, as the gate reads them,
 * and never of params a caller names. Delivery may carry a successful decision to the initial
 * session render, within its context and handoff window. Direct renders, later views and writes
 * run their guards normally; this answer also carries a response a guard answered itself.
 */

/** The longest a route's name, and a URL, a guard request may name, as a gate's question may. */
const MAX_ROUTE = 512;
const MAX_URL = 8192;
/** What a URL a guard request names is read against: nothing but its pathname is read. */
const URL_BASE = 'https://guard.invalid';

const PASSED: GuardAnswer = Object.freeze({ kind: 'pass' });
const REFUSED: GuardAnswer = Object.freeze({ kind: 'refused' });

/** A route a guard request named — of a reactive root or of none — and the params its URL gives it. */
export interface GuardedRoute {
  readonly admit?: true;
  readonly route: Pick<RegisteredRoute, 'middleware' | 'route'>;
  readonly params: RouteParams;
}

function invalid(): Error {
  return refusal(
    HTTP_BAD_REQUEST,
    'INVALID_GUARD',
    'A route’s guards are asked of a route and a URL.',
  );
}

/** A guard request: the route, and the URL asked for — nothing else of what crossed. */
export function guardRequestOf(value: unknown): GuardRequest {
  if (typeof value !== 'object' || value === null) {
    throw invalid();
  }
  const { admit, route, url } = value as Partial<Record<string, unknown>>;
  if (
    typeof route !== 'string' ||
    typeof url !== 'string' ||
    (admit !== undefined && admit !== true) ||
    route.length > MAX_ROUTE ||
    url.length > MAX_URL ||
    !url.startsWith('/')
  ) {
    throw invalid();
  }
  return { route, url, ...(admit === true && { admit }) };
}

/**
 * The route a guard request names — a reactive route, or one of no root under middleware — and its
 * params, of the request's URL: a route the authority does not know is not found (404), and a URL
 * not of the route refused (400), as a shared render's props that are not of its route's params are.
 */
export function guardedRouteOf(core: Core, request: GuardRequest): GuardedRoute {
  const route = core.routes.routes.get(request.route) ?? core.routes.plain.get(request.route);
  if (route === undefined) {
    throw refusal(HTTP_NOT_FOUND, 'UNKNOWN_ROUTE', 'There is no such route.');
  }
  const params = paramsOfPath(route.route, new URL(request.url, URL_BASE).pathname);
  if (params === undefined) {
    throw refusal(HTTP_BAD_REQUEST, 'INVALID_ROUTE', 'The URL is not of the route.');
  }
  return { params, route, ...(request.admit === true && { admit: true }) };
}

/**
 * In the queue: the guards of `routed`'s route, run for `session` in one call, outermost first, as a
 * render of its root runs them — a shared route's as well as one of the request's: `pass`, `refused`
 * where one refuses, or the response one answered itself, its body whole. The session's refusal
 * (401) and a fault are the call's, as a render's are.
 */
export async function routeGuards(
  core: Core,
  session: Session | undefined,
  routed: GuardedRoute,
): Promise<GuardAnswer> {
  const call = new Call(`The guards of ${routed.route.route}`, core.timeoutMs);
  try {
    const outcome = await runGuards(
      core,
      rendererOf(core, call, session),
      guardsOf(core, routed.route.middleware),
      { dependencies: new Dependencies(), params: routed.params },
    );
    if (outcome.kind === 'respond') {
      return { ...respondedAnswer(outcome.response, { method: 'GET' }), by: outcome.id };
    }
    if (outcome.kind !== 'pass') {
      return REFUSED;
    }
    const route = core.routes.routes.get(routed.route.route);
    return route !== undefined && routed.admit === true
      ? { admission: guardAdmission(core, session, route, routed.params), kind: 'pass' }
      : PASSED;
  } catch (error) {
    // A fault is the call's outcome, whatever came after it.
    throw call.fault === undefined ? error : call.fault.error;
  } finally {
    call.close();
  }
}
