/**
 * What an application's own sessions are as the authority reads them: a session its server vouches
 * for, of the application's sign-in, rather than one the demo's sign-in opened. Shared by the
 * clients that carry one, the authority that admits one, and the host that resolves one.
 */

/**
 * A session the application's server vouches for, of its own sign-in: a stable key it derives from
 * that sign-in's session (`sessionKey`), never the sign-in's own bearer, the user it signed in, and
 * when it expires, by the authority's clock (epoch milliseconds). Only the application's server
 * presents one — over the binding, or to the Node authority with its internal token — so the
 * browser never chooses a user; an authority that opens no such sessions reads one as none.
 */
export interface AssertedSession {
  readonly id: string;
  readonly user: string;
  readonly expires: number;
}

/**
 * The header an asserted session crosses to the Node authority in, as base64url JSON: read on its
 * `/api/` routes alone, beside the internal token, never on the edge's `/internal/gate`, whose
 * request is the visitor's own.
 */
export const ASSERTED_SESSION_HEADER = 'x-reactive-session';

/** What an asserted session's key and user may be: what a record's id may be. */
const ASSERTED_NAME = /^[\w-]{1,64}$/u;

/**
 * `value` as an asserted session — its three own fields, copied — or `undefined` where it is none:
 * a key or a user of another shape than a record's id, or an expiry that is no safe integer.
 */
export function assertedSessionOf(value: unknown): AssertedSession | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { expires, id, user } = value as Partial<Record<string, unknown>>;
  if (
    typeof id !== 'string' ||
    typeof user !== 'string' ||
    typeof expires !== 'number' ||
    !Number.isSafeInteger(expires) ||
    !ASSERTED_NAME.test(id) ||
    !ASSERTED_NAME.test(user)
  ) {
    return undefined;
  }
  return { expires, id, user };
}

/** An asserted session as its header carries it: base64url of its JSON. */
export function assertedHeader(session: AssertedSession): string {
  return Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
}

/** The asserted session a header carries, or `undefined` for a value that holds none. */
export function assertedOfHeader(value: string | undefined): AssertedSession | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  try {
    return assertedSessionOf(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    return undefined;
  }
}
