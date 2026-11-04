import type { Json } from '../program.ts';
import type { GateRequest, SharedRenderRequest, SiteShape } from '../routing.ts';
import { HTTP_BAD_REQUEST } from '../status.ts';
import { canonicalJson, carried } from './canonical.ts';
import { refusal } from './errors.ts';
import { isRootProps } from './requests.ts';

/**
 * What the authority reads of a shared render and of a gate's question before either joins its
 * queue: each field it names, of its kind and within its bounds, and nothing else of what crossed.
 */

/** The longest a route's name, a URL or a header the gate reads may be. */
const MAX_ROUTE = 512;
const MAX_URL = 8192;
const MAX_HEADER = 8192;
/** The most headers a gate is told. */
const MAX_HEADERS = 64;
/**
 * The most a shared render's props take, as JSON's text: as much as 32 params of 1024 characters
 * each, far past what a page's params, search params and constants come to. A page whose props take
 * more renders its root as any root is rendered (`render`).
 */
export const MAX_PROPS_LENGTH = 32_768;
/** The longest token a generation's render carries. */
const MAX_TOKEN = 4096;
/** The longest a deployment's id may be, as a gate's question names it. */
const MAX_DEPLOYMENT = 256;

function invalid(code: string, message: string): Error {
  return refusal(HTTP_BAD_REQUEST, code, message);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The props a page renders a route's root with, read as any root's are (`isRootProps`): a JSON
 * object — the route's params, by the props they are given as, and whatever else the page gives the
 * root, text or not — within `MAX_PROPS_LENGTH`, copied as JSON carries it (`carried`), an
 * `undefined` among them left out. Whether they are a view's params is the view's to read
 * (`viewParamsOf`).
 */
function propsOf(value: unknown): Readonly<Record<string, Json>> {
  if (!isRootProps(value) || canonicalJson(value).length > MAX_PROPS_LENGTH) {
    throw invalid('INVALID_ROUTE', 'The props are no JSON object a shared render takes.');
  }
  return carried(value) as Readonly<Record<string, Json>>;
}

/**
 * Where the page's site serves its routes, where the render says: a base path of its own, or none
 * (`''`) — a path that is no root's, and ends with no slash, as Next.js keeps one — whether its
 * paths end with a slash, and whether it serves each at either form (`skipTrailingSlashRedirect`,
 * kept where it does).
 */
function siteOf(value: unknown): SiteShape | undefined {
  if (value === undefined) {
    return undefined;
  }
  const {
    basePath,
    skipTrailingSlashRedirect: skipped,
    trailingSlash,
  } = isObject(value) ? value : {};
  if (
    typeof basePath !== 'string' ||
    typeof trailingSlash !== 'boolean' ||
    (skipped !== undefined && typeof skipped !== 'boolean') ||
    basePath.length > MAX_ROUTE ||
    (basePath !== '' && (!basePath.startsWith('/') || basePath.endsWith('/')))
  ) {
    throw invalid('INVALID_SITE', 'A site is a base path, and whether its paths end with a slash.');
  }
  return { basePath, trailingSlash, ...(skipped === true && { skipTrailingSlashRedirect: true }) };
}

/** A shared render, as the page's server asks for one. */
export function sharedRequestOf(value: unknown): SharedRenderRequest {
  if (!isObject(value)) {
    throw invalid(
      'INVALID_ROUTE',
      'A shared render names a route, its root’s props and the build.',
    );
  }
  const { admission, build, generation, route } = value;
  const tokenGiven = generation === undefined || typeof generation === 'string';
  if (
    typeof route !== 'string' ||
    typeof build !== 'string' ||
    !tokenGiven ||
    (admission !== undefined && typeof admission !== 'string') ||
    (typeof admission === 'string' && admission.length > MAX_TOKEN) ||
    route.length > MAX_ROUTE ||
    (typeof generation === 'string' && generation.length > MAX_TOKEN)
  ) {
    throw invalid(
      'INVALID_ROUTE',
      'A shared render names a route, its root’s props and the build.',
    );
  }
  const props = propsOf(value['props']);
  const site = siteOf(value['site']);
  return {
    build,
    props,
    route,
    ...(admission !== undefined && { admission }),
    ...(generation !== undefined && { generation }),
    ...(site !== undefined && { site }),
  };
}

function headersOf(value: unknown): Readonly<Record<string, string>> {
  if (!isObject(value) || Object.keys(value).length > MAX_HEADERS) {
    throw invalid('INVALID_GATE', 'A gate is asked with the request’s headers.');
  }
  // Each the map's own, whatever the name it was sent under: `__proto__` too.
  const headers: [string, string][] = [];
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== 'string' || header.length > MAX_HEADER) {
      throw invalid('INVALID_GATE', 'A gate is asked with the request’s headers.');
    }
    headers.push([name.toLowerCase(), header]);
  }
  return Object.fromEntries(headers);
}

/** A gate's question: the route, what the visitor asked for, and how. */
export function gateRequestOf(value: unknown): GateRequest {
  if (!isObject(value)) {
    throw invalid('INVALID_GATE', 'A gate is asked of a route, a URL, a method and headers.');
  }
  const { method, route, url } = value;
  if (
    typeof route !== 'string' ||
    typeof url !== 'string' ||
    (method !== 'GET' && method !== 'HEAD') ||
    route.length > MAX_ROUTE ||
    url.length > MAX_URL ||
    !url.startsWith('/')
  ) {
    throw invalid('INVALID_GATE', 'A gate is asked of a route, a URL, a method and headers.');
  }
  const site = siteOf(value['site']);
  const deployment = deploymentOf(value['deployment']);
  return {
    headers: headersOf(value['headers']),
    method,
    route,
    url,
    ...(site !== undefined && { site }),
    ...(deployment !== undefined && { deployment }),
  };
}

/**
 * The deployment a gate's question says its request is of; none where it says none, or says it
 * empty: a site of no deployments.
 */
function deploymentOf(value: unknown): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > MAX_DEPLOYMENT) {
    throw invalid('INVALID_GATE', 'A gate is asked of the deployment a request is of by its id.');
  }
  return value;
}
