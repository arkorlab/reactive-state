import type { SqliteKeyKind } from './keys.ts';

/**
 * A value a statement's parameter binds, as the text SQLite's `CAST(… AS TEXT)` writes of what the
 * key column holds once the value is compared with it — what the change log keeps of the row: of an
 * integer column, a whole number of SQLite's 64 bits in decimal, of a number, a `bigint` or text of
 * its canonical form (`05` is compared as `5`); of a boolean column, `1` or `0`, as Drizzle binds
 * it; of a text column, text alone, as it is. Any other value is no key's text: its condition is
 * left out.
 */

/**
 * SQLite's integers: of 64 bits — but the least, which a column of integers holds of a real as a
 * real (`sqlite3VdbeIntegerAffinity` leaves it), equal to the integer, written `-9.2233720368547758e+18`.
 */
const INT64 = { max: 9_223_372_036_854_775_807n, min: -9_223_372_036_854_775_807n } as const;
/** An integer's canonical text: no sign of `+`, no leading zero, no `-0`. */
const CANONICAL = /^(?:0|-?[1-9]\d*)$/u;

/** The text of an integer `value` binds, where it is a whole number SQLite holds as one. */
function integerText(value: unknown): string | undefined {
  let integer: bigint | undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value)) integer = BigInt(value);
  if (typeof value === 'bigint') integer = value;
  if (typeof value === 'string' && CANONICAL.test(value)) integer = BigInt(value);
  return integer === undefined || integer > INT64.max || integer < INT64.min
    ? undefined
    : integer.toString();
}

/** The text of a boolean `value` binds: Drizzle's `1` or `0`, or a boolean D1 binds as one. */
function booleanText(value: unknown): string | undefined {
  if (value === true || value === 1) return '1';
  if (value === false || value === 0) return '0';
  return undefined;
}

/** The text a `text` key's `value` binds: well-formed text of no NUL. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\0')
    ? value
    : undefined;
}

/** The text the log keeps of a row a key of `kind` equal to `value` is of; `undefined` for none. */
export function sqliteKeyText(kind: SqliteKeyKind, value: unknown): string | undefined {
  if (kind === 'integer') return integerText(value);
  if (kind === 'boolean') return booleanText(value);
  return textOf(value);
}

/**
 * Whether a column of the declared type `declared` has the affinity of `kind`, as SQLite reads a
 * declared type: of `INT`, an integer's; of `CHAR`, `CLOB` or `TEXT`, text's. A value of another
 * is compared otherwise than its text: its condition is left out.
 */
export function holdsKind(kind: SqliteKeyKind, declared: string): boolean {
  const type = declared.toUpperCase();
  if (type.includes('INT')) return kind !== 'text';
  return kind === 'text' && ['CHAR', 'CLOB', 'TEXT'].some((word) => type.includes(word));
}
