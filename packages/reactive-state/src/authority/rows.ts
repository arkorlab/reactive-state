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

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new TypeError(`column ${column} is not an integer`);
}
