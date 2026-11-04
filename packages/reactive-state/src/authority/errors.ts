import { HTTP_BAD_REQUEST, HTTP_FORBIDDEN } from '../status.ts';

export interface AuthorityErrorOptions extends ErrorOptions {
  readonly status: number;
  readonly code: string;
}

/**
 * What marks an `AuthorityError` wherever its class was loaded from: an application's modules and
 * the authority's engine may each load their own copy of this module, and a refusal one throws is a
 * refusal to the other.
 */
const AUTHORITY_ERROR = Symbol.for('arkorlab.reactive-state.authority-error');

/**
 * A refusal the authority answers with an HTTP status: the client may show its message, and a
 * write refused with one is not retried (`definitive`), where a write whose outcome is unknown is.
 */
export class AuthorityError extends Error {
  readonly status: number;
  readonly code: string;
  readonly definitive = true;
  readonly [AUTHORITY_ERROR] = true;

  constructor(message: string, options: AuthorityErrorOptions) {
    super(message, options);
    this.name = 'AuthorityError';
    this.status = options.status;
    this.code = options.code;
  }
}

/** Whether `error` is an `AuthorityError` of any copy of this module. */
export function isAuthorityError(error: unknown): error is AuthorityError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Partial<Record<symbol, unknown>>)[AUTHORITY_ERROR] === true
  );
}

/**
 * What the application's code threw, as the engine answers it: a refusal of any copy of this
 * module — `forbidden()`'s, or the session's own that `requireUser` throws — as one of this copy's,
 * whose status and code whatever answers the engine reads (`instanceof`); anything else as it is.
 */
export function asRefusal(error: unknown): unknown {
  if (!isAuthorityError(error) || error instanceof AuthorityError) {
    return error;
  }
  const { code, message, status } = error as Partial<
    Record<'code' | 'message' | 'status', unknown>
  >;
  return typeof code === 'string' && typeof message === 'string' && typeof status === 'number'
    ? new AuthorityError(message, { cause: error, code, status })
    : error;
}

export function refusal(status: number, code: string, message: string): AuthorityError {
  return new AuthorityError(message, { code, status });
}

export function denied(): AuthorityError {
  return new AuthorityError('Your current access does not allow this.', {
    code: 'FORBIDDEN',
    status: HTTP_FORBIDDEN,
  });
}

const ID = /^[\w-]{1,64}$/u;

export function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ID.test(id)) {
    throw new AuthorityError('The id is not valid.', {
      code: 'INVALID_ID',
      status: HTTP_BAD_REQUEST,
    });
  }
}

/**
 * What a thrown value says, for a refusal that quotes it: an error's message, or the value as text,
 * at most `length` characters; it never throws, whatever was thrown.
 */
export function messageOf(thrown: unknown, length: number): string {
  try {
    return (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, length);
  } catch {
    return 'a value that does not say what it is';
  }
}

/** What a thrown value says, for a log; it never throws, whatever was thrown. */
export function describeThrown(thrown: unknown): string {
  try {
    // An error's `stack` and `message` hold whatever was set on them: made text here, inside the
    // `try`, a conversion that throws is answered as well.
    const said: unknown = thrown instanceof Error ? (thrown.stack ?? thrown.message) : thrown;
    return String(said);
  } catch {
    return 'a value that does not say what it is';
  }
}
