/**
 * What the host throws for the authority's refusal of a root's render, and how an application
 * tells one apart from any other fault: by the error's `digest`, which Next.js carries across a
 * `'use cache'` boundary — a root a link's prefetch carries renders inside `'use cache: private'` —
 * where in production it carries nothing else of the error: its message is replaced, and its
 * `cause` let go of. In development the message and the `cause` come through as well.
 */

/** The authority's refusal of a root's render: its HTTP status and its code. */
export interface AuthorityRefusal {
  readonly status: number;
  readonly code: string;
}

/** What starts the digest of an error thrown for the authority's refusal. */
const REFUSED = 'REACTIVE_STATE_REFUSED';
/** The fields of such a digest: the mark, the status, the code, and the error's own nonce. */
const DIGEST_FIELDS = 4;
/** A status of HTTP's, as a digest writes it. */
const STATUS = /^[1-5]\d\d$/u;
/** A code, as the authority writes one: `AUTHORITY_UNAVAILABLE`, `BUILD_MISMATCH`, …. */
const CODE = /^[A-Z][\dA-Z_]*$/u;

/**
 * An error for the authority's refusal of a root's render: its `cause` the refusal, and its
 * `digest` — which Next.js keeps, rather than make one of its own — the refusal too, and a nonce
 * of the error's own, so that two refusals of one request are two errors in Next.js's reports.
 */
export function refusedRender(message: string, refusal: AuthorityRefusal): Error {
  const { code, status } = refusal;
  const error = new Error(message, { cause: { code, status } });
  return Object.assign(error, {
    digest: `${REFUSED};${String(status)};${code};${crypto.randomUUID()}`,
  });
}

/**
 * The authority's refusal an error says, as a root's render threw it — read of its `digest`,
 * where a `'use cache'` boundary left nothing else of it — or nothing for any other error: one of
 * the application's own, one of Next.js's (`notFound()`, a redirect).
 */
export function authorityRefusal(error: unknown): AuthorityRefusal | undefined {
  const digest: unknown =
    typeof error === 'object' && error !== null
      ? (error as { digest?: unknown }).digest
      : undefined;
  if (typeof digest !== 'string') {
    return undefined;
  }
  const [mark, status = '', code = '', nonce] = digest.split(';', DIGEST_FIELDS);
  return mark === REFUSED && nonce !== undefined && STATUS.test(status) && CODE.test(code)
    ? { code, status: Number(status) }
    : undefined;
}
