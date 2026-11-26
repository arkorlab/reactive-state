import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';

/**
 * The columns of a followed table of SQLite — D1's — a render's conditions are followed by: each
 * column of a primary key, a unique constraint, a foreign key or an index, and each boolean column,
 * of a type whose text SQLite writes one way for one value. The change log keeps their text of each
 * changed row, and a render's statement names the rows it read by them; a condition on any other
 * column is left out, which renders the read again for more changes, never fewer.
 */

/**
 * How a key's value is written as text, as SQLite's `CAST(… AS TEXT)` writes what its column holds:
 * a whole number in decimal, a boolean as `1` or `0`, text as it is.
 */
export type SqliteKeyKind = 'boolean' | 'integer' | 'text';

/** A key column: its name in the table, the field it is declared by, and how its value is written. */
export interface SqliteKeyColumn {
  readonly column: string;
  readonly field: string;
  readonly kind: SqliteKeyKind;
}

/**
 * Each Drizzle column type of SQLite a key may be, by the kind of its value: an integer of numbers
 * or of booleans, and text of strings — not a timestamp, whose value is a `Date`, nor JSON.
 */
const KINDS: Readonly<Record<string, SqliteKeyKind>> = {
  SQLiteBoolean: 'boolean',
  SQLiteInteger: 'integer',
  SQLiteText: 'text',
};

/**
 * A column's name a key may have: one a field's name holds after `k_`, which the declaration takes
 * (`[A-Za-z]\w{0,63}`) and which is never the record's `id`.
 */
const COLUMN = /^\w{1,62}$/u;

/** The field a key column is declared by: `k_<column>`. */
function keyField(column: string): string {
  return `k_${column}`;
}

/** The names of the columns a constraint or an index of `table` holds, of plain columns alone. */
function indexedOf(table: SQLiteTable): ReadonlySet<string> {
  const config = getTableConfig(table);
  const named = new Set<string>();
  const add = (columns: readonly unknown[]): void => {
    for (const column of columns) {
      const name: unknown =
        typeof column === 'object' && column !== null ? Reflect.get(column, 'name') : undefined;
      if (typeof name === 'string') named.add(name);
    }
  };
  for (const key of config.primaryKeys) add(key.columns);
  for (const unique of config.uniqueConstraints) add(unique.columns);
  for (const foreign of config.foreignKeys) add(foreign.reference().columns);
  for (const index of config.indexes) add(index.config.columns);
  return named;
}

/** What a column says of itself: its name, its type, whether it is a primary or a unique key. */
interface ColumnOwn {
  readonly name: string;
  readonly columnType: string;
  readonly primary: boolean;
  readonly isUnique: boolean;
}

/** Whether `column` of a table whose constraints and indexes hold `indexed` is one of its keys. */
function isKey(column: ColumnOwn, indexed: ReadonlySet<string>): boolean {
  return (
    column.primary ||
    column.isUnique ||
    indexed.has(column.name) ||
    column.columnType === 'SQLiteBoolean'
  );
}

/** The key columns of `table`, in the order it declares its columns. */
export function sqliteKeysOf(table: SQLiteTable): readonly SqliteKeyColumn[] {
  const indexed = indexedOf(table);
  const keys: SqliteKeyColumn[] = [];
  const columns: readonly ColumnOwn[] = getTableConfig(table).columns;
  for (const column of columns) {
    const kind = Object.hasOwn(KINDS, column.columnType) ? KINDS[column.columnType] : undefined;
    if (kind !== undefined && COLUMN.test(column.name) && isKey(column, indexed)) {
      keys.push({ column: column.name, field: keyField(column.name), kind });
    }
  }
  return keys;
}
