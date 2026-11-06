/**
 * A value as SQLite hands one back: one of its storage classes. A Durable Object's storage answers
 * a BLOB as an `ArrayBuffer`, Node's driver as a `Uint8Array`.
 */
type Cell = ArrayBuffer | bigint | number | string | Uint8Array | null;

/** A row, by column. */
export type Row = Readonly<Record<string, Cell>>;

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new TypeError(`column ${column} is not text`);
  }
  return value;
}

/**
 * The integer `column` holds, which a number holds exactly. A driver that reads integers as `bigint`
 * hands each back as one: one no number holds exactly is refused, as such a number is, rather than
 * rounded to another.
 */
export function integer(row: Row, column: string): number {
  const value = row[column];
  const read = typeof value === 'bigint' ? Number(value) : value;
  if (typeof read === 'number' && Number.isSafeInteger(read)) {
    return read;
  }
  throw new TypeError(`column ${column} is not an integer`);
}
