/**
 * Whose a refusal's code is: the framework's own — the codes the authority, its hosts and the
 * package's clients answer (`FRAMEWORK_CODES`), and any under the prefixes the authority names new
 * ones with — or an application's, which `refuse(code)` (`./server`) refuses with. A page reads a
 * root's own refusal by it (`PageStore.revoke`): a leaf that holds no server code, which the
 * browser's runtime imports as `refuse` does.
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

/** Whether `code` is text of the shape a code of the application's own takes. */
export function isCodeShaped(code: unknown): boolean {
  return typeof code === 'string' && CODE.test(code);
}

/** Whether `code` is the authority's, or under a prefix it names its own with. */
export function isReservedCode(code: string): boolean {
  return FRAMEWORK_CODES.has(code) || RESERVED_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/**
 * Whether `code` is an application's own, as `refuse` takes one: of a code's shape, and none of the
 * framework's. No code the package answers is one (`refuse.test.ts` reads its sources for them).
 */
export function isApplicationCode(code: string | undefined): boolean {
  return code !== undefined && isCodeShaped(code) && !isReservedCode(code);
}
