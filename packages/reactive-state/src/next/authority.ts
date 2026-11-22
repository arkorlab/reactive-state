import { cookies } from 'next/headers';

import { type AssertedSession, assertedSessionOf } from '../asserted.ts';
import {
  type AuthorityClient,
  type AuthorityNamespace,
  bindingClient,
  type Failure,
  HTTP_SERVICE_UNAVAILABLE,
  httpClient,
  type SessionId,
} from '../client/index.ts';
import { SESSION_COOKIE } from '../program.ts';

/**
 * The application's server speaking to the authority. Only server code imports this module: what
 * it reaches the authority with — the internal token, or the binding — never reaches a browser, and
 * the browser's own requests reach the authority only through the route and the Server Functions
 * built on it.
 *
 * Which authority it is, is decided when a call is made rather than when the module loads.
 * Deployed on the platform, it is the Durable Object the deployment's binding names, which the
 * platform publishes to the Function alone. Otherwise — while `next build` renders, and on a local
 * stack — it is the Node authority whose address and token the application's scripts put in the
 * environment, which a build does not carry into a deployment.
 */

/** The deployment's resource bindings, as the platform's runtime publishes them (version 1). */
interface PublishedResources {
  readonly version: number;
  readonly resources: Readonly<
    Record<string, { readonly type: string; readonly binding: unknown } | undefined>
  >;
}

const RESOURCES = Symbol.for('upwind.resources');
const RESOURCES_VERSION = 1;

/** The binding a deployment registers for the authority's Durable Object class. */
const AUTHORITY_BINDING = 'REACTIVE_AUTHORITY';

export function refused(status: number, code: string, message: string): Failure {
  return { code, message, ok: false, status };
}

const NOT_CONFIGURED = refused(
  HTTP_SERVICE_UNAVAILABLE,
  'AUTHORITY_NOT_CONFIGURED',
  'No authority is bound (REACTIVE_AUTHORITY), and REACTIVE_ENGINE_URL and REACTIVE_ENGINE_TOKEN are not set: start the application with its scripts.',
);

/** The authority's namespace, where the platform bound one to this deployment. */
function boundNamespace(): AuthorityNamespace | undefined {
  const published = (globalThis as Partial<Record<symbol, unknown>>)[RESOURCES] as
    | PublishedResources
    | undefined;
  // A shape this module does not know is read as no binding, rather than read wrongly.
  if (
    published?.version !== RESOURCES_VERSION ||
    !Object.hasOwn(published.resources, AUTHORITY_BINDING)
  ) {
    return undefined;
  }
  const resource = published.resources[AUTHORITY_BINDING];
  return resource?.type === 'durable_object_namespace'
    ? (resource.binding as AuthorityNamespace)
    : undefined;
}

/** An authority that is not there: every call is answered with `failure`. */
function absent(failure: Failure): AuthorityClient {
  const answer = (): Promise<Failure> => Promise.resolve(failure);
  return {
    events: answer,
    gate: answer,
    endSession: answer,
    guardRoute: answer,
    login: answer,
    logout: answer,
    operate: answer,
    publicView: answer,
    render: answer,
    renderShared: answer,
    sharedEvents: answer,
    update: answer,
    view: answer,
  };
}

/**
 * This deployment of the site (`NEXT_DEPLOYMENT_ID`), as Next.js compiles it into the build: `false`
 * where the build has none, which is no deployment's id.
 */
function deploymentId(): string | undefined {
  const id: unknown = process.env['NEXT_DEPLOYMENT_ID'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Where the authority's object is placed when it is first made (`REACTIVE_AUTHORITY_LOCATION`):
 * near the data an application's components read, where that is elsewhere than its visitors.
 */
function locationHint(): string | undefined {
  const hint: unknown = process.env['REACTIVE_AUTHORITY_LOCATION'];
  return typeof hint === 'string' && hint !== '' ? hint : undefined;
}

/** The authority this deployment has: its Durable Object, the local one, or none. */
export function authority(): AuthorityClient {
  const namespace = boundNamespace();
  if (namespace !== undefined) {
    // Every render names the deployment, for the authority to catch that deployment's pages up; and
    // each gate's question, as the one its request is of.
    return bindingClient(namespace, { deployment: deploymentId(), locationHint: locationHint() });
  }
  const url = process.env['REACTIVE_ENGINE_URL'];
  const token = process.env['REACTIVE_ENGINE_TOKEN'];
  if (url === undefined || url === '' || token === undefined || token === '') {
    return absent(NOT_CONFIGURED);
  }
  // Each gate's question names the deployment its request is of: an artifact of another answers none.
  return httpClient({ deployment: deploymentId(), token, url });
}

/**
 * How an application reads its own signed-in session, where it signs its users in itself: the
 * session its server vouches for (`AssertedSession`), or `null` for a request of none. It runs on
 * the application's server, in a page's render as in a route's handler, and reads the request's
 * cookies as the application's sign-in does; never `connection()`, which a root a link's prefetch
 * carries may not wait for. The compile writes the application's into what calls it (`--session`).
 */
export type SessionSource = () => AssertedSession | null | Promise<AssertedSession | null>;

/** What `source` answers, as an asserted session or none: whatever else it answers is none. */
async function asserted(source: SessionSource): Promise<AssertedSession | null> {
  return assertedSessionOf(await source()) ?? null;
}

/**
 * The session a page's request is of, as the authority reads it: the application's own, where it
 * has a session source, else the one the demo's cookie names. The cookies are read first either
 * way: while a page's shell is prerendered they never resolve, which is what leaves a session's
 * part of a page to the request.
 */
export async function requestSession(source?: SessionSource): Promise<SessionId> {
  const jar = await cookies();
  return source === undefined ? (jar.get(SESSION_COOKIE)?.value ?? null) : asserted(source);
}

/**
 * The session a route's request is of: the application's own, where it has a session source, else
 * the one its `Cookie` header names.
 */
export async function routeSession(request: Request, source?: SessionSource): Promise<SessionId> {
  return source === undefined ? sessionOf(request) : asserted(source);
}

/** The session a route's request names in its `Cookie` header. */
export function sessionOf(request: Request): SessionId {
  const pairs = (request.headers.get('cookie') ?? '').split(';');
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator !== -1 && pair.slice(0, separator).trim() === SESSION_COOKIE) {
      const value = pair.slice(separator + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}
