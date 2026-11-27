import { AuthorityError } from '../authority/errors.ts';
import { HTTP_UNPROCESSABLE } from '../status.ts';

/**
 * An application's own refusal of a server operation: a code of its own, which a page reads of the
 * refused operation's error (`operationRefusal`), and a message. None of the authority's codes, nor
 * any under the prefixes it names new ones with (`OPERATION_`, `AUTHORITY_`): a page would read the
 * application's refusal as the authority's — a build to reload, a session to sign in again.
 */

/** A code of the application's own: a capital, then capitals, digits or `_`, 64 at most. */
const CODE = /^[A-Z][\dA-Z_]{0,63}$/u;
/** The prefixes the authority names its codes of operations and of its own reach with. */
const RESERVED_PREFIXES = ['AUTHORITY_', 'OPERATION_'] as const;
/** The codes the authority, its hosts and the package's clients answer of their own. */
export const FRAMEWORK_CODES: ReadonlySet<string> = new Set([
  'BUILD_MISMATCH',
  'FORBIDDEN',
  'GENERATION_GONE',
  'HOST_REJECTED',
  'INTERNAL_ERROR',
  'INTERNAL_ONLY',
  'INVALID_CONSUMER',
  'INVALID_GATE',
  'INVALID_GUARD',
  'INVALID_ID',
  'INVALID_JSON',
  'INVALID_OPERATION',
  'INVALID_REVISION',
  'INVALID_ROOT',
  'INVALID_ROUTE',
  'INVALID_SESSION_KEY',
  'INVALID_SITE',
  'INVALID_SUBSCRIPTION',
  'INVALID_USER',
  'INVALID_VALUE',
  'INVALID_VIEW',
  'METHOD_NOT_ALLOWED',
  'NO_ASSERTED_SESSIONS',
  'NO_DEMO_SESSIONS',
  'NOT_A_GENERATION',
  'NOT_FOUND',
  'ORIGIN_REJECTED',
  'REQUEST_DEPENDENT',
  'ROW_CHANGED',
  'TARGET_CHANGED',
  'TOO_LARGE',
  'TOO_MANY_SHARED_STREAMS',
  'TOO_MANY_STREAMS',
  'TOO_MANY_VIEWS',
  'UNAUTHENTICATED',
  'UNIQUE_VIOLATION',
  'UNKNOWN_COMPONENT',
  'UNKNOWN_OPERATION',
  'UNKNOWN_ROUTE',
  'UNKNOWN_UPDATER',
]);

/** Whether `code` is the authority's, or under a prefix it names its own with. */
function reserved(code: string): boolean {
  return FRAMEWORK_CODES.has(code) || RESERVED_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/**
 * Refuses the server operation under way with `code`, the application's own (422), and `message`
 * — one that names the code where none is given. The refusal is kept for a resend, as
 * `forbidden()`'s is. Thrown once a statement of the application's own tables may have written, it
 * is no refusal: the operation answers that it failed. Thrown wherever else the authority runs the
 * application's code — a component's render, a write's replay, a route's middleware — it refuses
 * that as the authority's other refusals do, with 422 and the code. A code that is no code of the
 * application's own is a fault of the code that names it (`TypeError`).
 */
export function refuse(code: string, message?: string): never {
  if (typeof code !== 'string' || !CODE.test(code)) {
    throw new TypeError(
      `refuse(code): a code is a capital, then capitals, digits or \`_\`, 64 at most: ${code}`,
    );
  }
  if (reserved(code)) {
    throw new TypeError(
      `refuse(code): ${code} is the authority's own code, which a page would read as the authority's refusal: name the application's refusal otherwise.`,
    );
  }
  throw new AuthorityError(message ?? `Refused: ${code}.`, {
    code,
    status: HTTP_UNPROCESSABLE,
  });
}
