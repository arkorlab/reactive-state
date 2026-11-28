import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';

import type { Relation } from './capture.ts';

/**
 * The columns of a followed table a render's conditions are followed by — its keys: each column
 * of a primary key, a unique constraint, a foreign key or an index, and each boolean or enum column,
 * of a type whose text PostgreSQL writes one way for one value. The change log keeps their values
 * of each changed row, and a render's plan names the records it read by them; a condition on any
 * other column is left out, which renders the read again for more changes, never fewer.
 */

/**
 * How a key's value is written as text, as PostgreSQL writes it: text as it is, a whole number in
 * decimal, a boolean as `true` or `false`, a UUID in lower case.
 */
export type KeyKind = 'boolean' | 'integer' | 'text' | 'uuid';

/** A key column: its name in the table, the field it is declared by, and how its value is written. */
export interface KeyColumn {
  readonly column: string;
  readonly field: string;
  readonly kind: KeyKind;
}

/**
 * The tables an authority follows of a Drizzle schema: by the relations a plan names, the table each
 * is declared as; of each table, its key columns; and the schema the log is kept in.
 */
export interface Followed {
  readonly byRelation: ReadonlyMap<string, string>;
  /** The followed tables, by their schemas and names, as the schema declares them. */
  readonly relations: readonly Relation[];
  readonly keysByTable: ReadonlyMap<string, readonly KeyColumn[]>;
  readonly namespace: string;
  /**
   * The table every statement of a render reads beside what its plan names: no rows are of it, and
   * no entry of the log names it, but a change of the schema renders again whatever read any table
   * of the store — a statement whose plan PostgreSQL folded to no table at all too.
   */
  readonly schemaTable: string;
  /**
   * How many times a store of the namespace has read that the database's schema changed: a plan
   * asked before is kept no more, nor what the catalog said (`client.ts`). One of the namespace's,
   * whatever `followDrizzle` a client or a store is of.
   */
  readonly schema: { generation: number; context?: number };
}

/** Each Drizzle column type a key may be, by the kind of its value. */
const KINDS: Readonly<Record<string, KeyKind>> = {
  PgBigInt53: 'integer',
  PgBigInt64: 'integer',
  PgBigSerial53: 'integer',
  PgBigSerial64: 'integer',
  PgBoolean: 'boolean',
  PgEnumColumn: 'text',
  PgEnumObjectColumn: 'text',
  PgInteger: 'integer',
  PgSerial: 'integer',
  PgSmallInt: 'integer',
  PgSmallSerial: 'integer',
  PgText: 'text',
  PgUUID: 'uuid',
  PgVarchar: 'text',
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
function indexedOf(table: PgTable): ReadonlySet<string> {
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

/** Whether `column` of a table whose constraints and indexes hold `indexed` is one of its keys. */
function isKey(column: PgColumn, indexed: ReadonlySet<string>): boolean {
  return (
    column.primary ||
    column.isUnique ||
    indexed.has(column.name) ||
    column.columnType === 'PgBoolean' ||
    column.columnType === 'PgEnumColumn' ||
    column.columnType === 'PgEnumObjectColumn'
  );
}

/** The key columns of `table`, in the order it declares its columns. */
export function keysOf(table: PgTable): readonly KeyColumn[] {
  const indexed = indexedOf(table);
  const keys: KeyColumn[] = [];
  for (const column of getTableConfig(table).columns) {
    const kind = Object.hasOwn(KINDS, column.columnType) ? KINDS[column.columnType] : undefined;
    if (kind !== undefined && COLUMN.test(column.name) && isKey(column, indexed)) {
      keys.push({ column: column.name, field: keyField(column.name), kind });
    }
  }
  return keys;
}
