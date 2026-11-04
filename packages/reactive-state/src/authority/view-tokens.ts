import { isRouteParams, type RouteParams } from '../routing.ts';
import { BUILD_MISMATCH, HTTP_CONFLICT } from '../status.ts';
import { claimsOf, signed, TOKEN_VERSION } from './bindings.ts';
import { AuthorityError, denied } from './errors.ts';

/**
 * The tokens of a shared view, which the authority signs as it signs a binding: a view token, which
 * a page every visitor shares carries for its event stream — the route, its params and the build,
 * the generation it shows and the access epoch it was published in — and a generation token, which
 * the authority's own request for a generation's artifact carries, for the page's render to render
 * the generation the authority prepares rather than the one it serves.
 */

/** What each kind of token says it is. */
const VIEW = 'view';
const GENERATION = 'generation';

/** The artifacts of a generation: the document, and the router's payload of it. */
export type Profile = 'document' | 'rsc';

export interface ViewClaims {
  readonly route: string;
  readonly params: RouteParams;
  readonly build: string;
  readonly generation: number;
  readonly epoch: number;
}

export interface GenerationClaims {
  /** The view's key (`viewKeyOf`). */
  readonly view: string;
  readonly generation: number;
  readonly profile: Profile;
  readonly exp: number;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function signView(secret: string, claims: ViewClaims): string {
  return signed(secret, VIEW, { ...claims });
}

/**
 * The claims of a view token this authority signed, for the build it runs; a refusal otherwise —
 * 403, or 409 for another build's page, which a reload brings up to this one.
 */
export function verifyView(secret: string, token: unknown, build: string): ViewClaims {
  const claims = claimsOf(secret, token);
  const { epoch, generation, params, route } = claims;
  if (
    typeof route !== 'string' ||
    claims['t'] !== VIEW ||
    claims['v'] !== TOKEN_VERSION ||
    !isRouteParams(params) ||
    !isCount(generation) ||
    !isCount(epoch)
  ) {
    throw denied();
  }
  if (claims['build'] !== build) {
    throw new AuthorityError('The application was updated. Reload the page.', {
      code: BUILD_MISMATCH,
      status: HTTP_CONFLICT,
    });
  }
  return { build, epoch, generation, params, route };
}

export function signGeneration(secret: string, claims: GenerationClaims): string {
  return signed(secret, GENERATION, { ...claims });
}

/**
 * The claims of a generation token this authority signed, before it expired; nothing for any other
 * token — a request that carries one is a visitor's like any other, and is served as one.
 */
export function generationOf(
  secret: string,
  token: unknown,
  now: number,
): GenerationClaims | undefined {
  let claims: Readonly<Partial<Record<string, unknown>>>;
  try {
    claims = claimsOf(secret, token);
  } catch {
    return undefined;
  }
  const { exp, generation, profile, view } = claims;
  if (
    typeof view !== 'string' ||
    (profile !== 'document' && profile !== 'rsc') ||
    claims['t'] !== GENERATION ||
    claims['v'] !== TOKEN_VERSION ||
    !isCount(generation) ||
    !isCount(exp) ||
    exp <= now
  ) {
    return undefined;
  }
  return { exp, generation, profile, view };
}
