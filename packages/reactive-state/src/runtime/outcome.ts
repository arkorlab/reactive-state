/**
 * What a server operation's failure says of itself where a page reads it: its error's `digest`,
 * which Next.js keeps across the RSC boundary when it hides the message, as it does in production.
 * An operation the authority refused (`refused`) did not run, and would be refused again; one whose
 * outcome is `unknown` may have run, which the page, shown again, says.
 */

const PREFIX = 'REACTIVE_STATE_OPERATION';

export type OperationOutcome = 'refused' | 'unknown';

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
  const digest =
    typeof error === 'object' && error !== null
      ? (error as { readonly digest?: unknown }).digest
      : undefined;
  if (typeof digest !== 'string') {
    return undefined;
  }
  const [prefix, outcome] = digest.split(';', 2);
  return prefix === PREFIX && (outcome === 'refused' || outcome === 'unknown')
    ? outcome
    : undefined;
}
