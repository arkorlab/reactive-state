import type { FieldReceipt } from '../program.ts';
import { HTTP_FORBIDDEN, HTTP_NOT_FOUND, TARGET_CHANGED } from '../status.ts';

/**
 * What the answer to one of the page's writes says, as its store reads it (`PageStore`): a receipt
 * of the write's commit, or a refusal — one a resend would only repeat, or not; of the one operation,
 * or of every operation of its binding. Whether a resend would only repeat a refusal, a root's view
 * controller reads alike (`ViewController`).
 */

const CLIENT_ERRORS = { first: 400, last: 499 } as const;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
/** Statuses of the 4xx class that say nothing of the operation: it may be sent again. */
const TRANSIENT: ReadonlySet<number> = new Set([HTTP_REQUEST_TIMEOUT, HTTP_TOO_MANY_REQUESTS]);
/**
 * Whether a refusal is of the binding rather than of one operation: the session may no longer write
 * through it (403), the target is gone (404) or is no longer what the binding names (409
 * `TARGET_CHANGED`). Every operation of the binding would be refused alike; any other conflict — a
 * `unique` group another record holds — is the one operation's.
 */
export function refusesBinding(failure: {
  readonly status: number;
  readonly code: string;
}): boolean {
  return (
    failure.status === HTTP_FORBIDDEN ||
    failure.status === HTTP_NOT_FOUND ||
    failure.code === TARGET_CHANGED
  );
}

/**
 * Whether a failed answer is the authority's refusal, which a resend would only repeat: a 4xx, but a
 * timeout's or a throttle's — of a write, or of a view.
 */
export function isDefinitive(status: number): boolean {
  return status >= CLIENT_ERRORS.first && status <= CLIENT_ERRORS.last && !TRANSIENT.has(status);
}

export function isReceipt(value: unknown): value is FieldReceipt {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isSafeInteger((value as Partial<Record<string, unknown>>)['committedRevision'])
  );
}
