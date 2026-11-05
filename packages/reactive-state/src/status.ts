/** The HTTP statuses the authority answers with, and that the browser's store reads back. */
export const HTTP_OK = 200;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const HTTP_PAYLOAD_TOO_LARGE = 413;
export const HTTP_UNPROCESSABLE = 422;
export const HTTP_INTERNAL_ERROR = 500;

/** Statuses that refuse this session the binding altogether: signed out, or access revoked. */
export const REVOKING_STATUSES: ReadonlySet<number> = new Set([HTTP_FORBIDDEN, HTTP_UNAUTHORIZED]);

/**
 * The code of a refusal of another build's page — its render, a write under its binding, its
 * operation: the page's code no longer matches the authority's, which a reload brings it up to.
 */
export const BUILD_MISMATCH = 'BUILD_MISMATCH';
/**
 * The code of a refusal to render a component the authority does not run: a page of one a newer
 * build let go of, which no render will answer again — a reload, as for another build.
 */
export const UNKNOWN_COMPONENT = 'UNKNOWN_COMPONENT';
/**
 * The code of a write refused because what its binding names is no longer there: the component
 * whose state it is no longer renders where it did, or binds the state to another field. The
 * page's next frame shows what there is now.
 */
export const TARGET_CHANGED = 'TARGET_CHANGED';
