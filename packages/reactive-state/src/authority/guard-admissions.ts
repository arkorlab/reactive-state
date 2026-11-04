import type { RouteParams, RouteRegistration } from '../routing.ts';
import { claimsOf, sessionTag, signed, TOKEN_VERSION } from './bindings.ts';
import { digest } from './canonical.ts';
import type { Core, Session } from './model.ts';

/** A decision passed only from delivery to that page's initial session render. */
export interface InitialGuardAdmission {
  readonly token: string;
  readonly session: Session | undefined;
}

const KIND = 'guard-admission';

/** No params, session id, dependency list or application value is copied into the decision. */
export function guardAdmission(
  core: Core,
  session: Session | undefined,
  route: RouteRegistration,
  params: RouteParams,
): string {
  const expires = core.clock() + core.timeoutMs;
  return signed(core.secret, KIND, {
    boot: core.boot,
    build: digest(core.registry.buildId),
    commits: core.metrics.commits,
    exp: Math.min(expires, session?.expires ?? expires),
    session: sessionTag(core.secret, session?.id ?? ''),
    target: digest([route.route, route.root, params]),
    user: sessionTag(core.secret, session?.userId ?? ''),
  });
}

/** A changed or expired context runs its guards normally; malformed decisions do the same. */
export function admittedGuard(
  core: Core,
  admission: InitialGuardAdmission,
  route: RouteRegistration,
  params: RouteParams,
): boolean {
  let claims: ReturnType<typeof claimsOf>;
  try {
    claims = claimsOf(core.secret, admission.token);
  } catch {
    return false;
  }
  const { session } = admission;
  return (
    claims['t'] === KIND &&
    claims['v'] === TOKEN_VERSION &&
    claims['boot'] === core.boot &&
    claims['build'] === digest(core.registry.buildId) &&
    claims['commits'] === core.metrics.commits &&
    typeof claims['exp'] === 'number' &&
    claims['exp'] > core.clock() &&
    claims['session'] === sessionTag(core.secret, session?.id ?? '') &&
    claims['user'] === sessionTag(core.secret, session?.userId ?? '') &&
    claims['target'] === digest([route.route, route.root, params])
  );
}
