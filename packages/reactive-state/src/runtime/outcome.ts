/**
 * What a server operation's failure says of itself where a page reads it: its error's `digest`,
 * which Next.js keeps across the RSC boundary when it hides the message, as it does in production.
 * An operation the authority refused (`refused`) did not run, and would be refused again; one whose
 * outcome is `unknown` may have run, which the page, shown again, says.
 */

const PREFIX = 'REACTIVE_STATE_OPERATION';

export type OperationOutcome = 'refused' | 'unknown';

/** What a page reads of a server operation the authority refused: the code it was refused with. */
export interface OperationRefusal {
  readonly code: string;
}

/** The digest of a failed operation's error: its outcome, and the authority's code for it. */
export function operationDigest(outcome: OperationOutcome, code: string): string {
  return `${PREFIX};${outcome};${code}`;
}

/**
 * What `error` says of a server operation that failed, as an error boundary is handed it: refused,
 * or its outcome unknown. Nothing for any other error — a render's, or a Server Function's whose
 * answer never reached the page, which may have run all the same.
 */
export function operationOutcome(error: unknown): OperationOutcome | undefined {
  const digest = digestOf(error);
  if (digest === undefined) {
    return undefined;
  }
  const [prefix, outcome] = digest.split(';', 2);
  return prefix === PREFIX && (outcome === 'refused' || outcome === 'unknown')
    ? outcome
    : undefined;
}

/**
 * What `error` says of a server operation the authority refused, as a caller or an error boundary
 * is handed it: the code it was refused with — the application's own (`refuse`), or the authority's
 * (`FORBIDDEN`, `UNAUTHENTICATED` of a session that ended). Nothing of one whose outcome is unknown,
 * nor of any other error.
 */
export function operationRefusal(error: unknown): OperationRefusal | undefined {
  const digest = digestOf(error);
  if (digest === undefined) {
    return undefined;
  }
  // The code is the rest of the digest whole, whatever it holds: a refusal of the authority's
  // class may be named by any text, `;` too.
  const refused = `${PREFIX};refused;`;
  const code = digest.startsWith(refused) ? digest.slice(refused.length) : '';
  return code === '' ? undefined : { code };
}

/** The `digest` an error carries, where it is text. */
function digestOf(error: unknown): string | undefined {
  const digest: unknown =
    typeof error === 'object' && error !== null
      ? (error as { readonly digest?: unknown }).digest
      : undefined;
  return typeof digest === 'string' ? digest : undefined;
}
