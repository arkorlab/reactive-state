import type { Result } from '../program.ts';

/** What every client shares about its answers: the failures it makes of its own, and its wait. */

/** A failed answer: a refusal the authority made, or a failure to hear from it at all. */
export type Failure = Extract<Result<never>, { readonly ok: false }>;

/**
 * What a client answers with when it cannot say what the authority did: it could not be reached,
 * or did not answer in time. Not a refusal, so the store sends a write so answered again.
 */
export const HTTP_SERVICE_UNAVAILABLE = 503;

/** The code of that answer, which the application can tell from the authority's own refusals. */
export const AUTHORITY_UNAVAILABLE = 'AUTHORITY_UNAVAILABLE';

/**
 * How long a call may wait for the authority. One that never answered would hold a Server
 * Function, and the store behind it would never learn that the write's outcome was unknown.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

export function refused(status: number, code: string, message: string): Failure {
  return { code, message, ok: false, status };
}

/** A call whose outcome is unknown, for the reason `message` gives. */
export function unavailable(message: string): Failure {
  return refused(HTTP_SERVICE_UNAVAILABLE, AUTHORITY_UNAVAILABLE, message);
}

export const UNREACHABLE = 'The authority could not be reached.';
export const TOO_SLOW = 'The authority did not answer in time.';
