import type { KeyKind } from './keys.ts';

/**
 * A key's value as the change log keeps it — the text PostgreSQL writes of the value the column
 * holds (`capture.ts`) — of a value a statement ran with, or a constant its plan names: so that a
 * condition of the plan and a row of the log compare as PostgreSQL compares them. A value whose
 * text could be another — one PostgreSQL reads otherwise than it is written here (`0x1F`, `1_000`,
 * ` 5`), a lone surrogate it writes as U+FFFD, `null` — has none, and the condition is left out:
 * the read is followed by more changes, never fewer.
 */

/** A whole number, as PostgreSQL writes one: decimal digits, a sign before a negative one. */
const WHOLE = /^-?\d+$/u;
/** A UUID as PostgreSQL reads one and writes it back alike, in lower case. */
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** Text PostgreSQL holds as it is: well formed, with no NUL, which it refuses. */
function textOf(value: string): string | undefined {
  return value.isWellFormed() && !value.includes('\0') ? value : undefined;
}

/** A whole number written in decimal, of a safe integer, a `bigint`, or text of decimal digits. */
function wholeOf(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return typeof value === 'string' && WHOLE.test(value) ? BigInt(value).toString() : undefined;
}

/**
 * The text of a value a statement ran with, for a key of `kind`: a string of text, a whole number,
 * a boolean of JavaScript's, a UUID — in lower case — or none.
 */
export function valueText(kind: KeyKind, value: unknown): string | undefined {
  switch (kind) {
    case 'boolean': {
      return typeof value === 'boolean' ? String(value) : undefined;
    }
    case 'integer': {
      return wholeOf(value);
    }
    case 'text': {
      return typeof value === 'string' ? textOf(value) : undefined;
    }
    case 'uuid': {
      return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;
    }
  }
}

/**
 * The text of a constant a plan names, as PostgreSQL wrote it, for a key of `kind`: a boolean's
 * `true` or `false`, a whole number's digits, a UUID, text as it is.
 */
export function constantText(kind: KeyKind, written: string): string | undefined {
  switch (kind) {
    case 'boolean': {
      return written === 'true' || written === 'false' ? written : undefined;
    }
    case 'integer': {
      return wholeOf(written);
    }
    case 'text': {
      return textOf(written);
    }
    case 'uuid': {
      return UUID.test(written) ? written.toLowerCase() : undefined;
    }
  }
}
