import type { Column } from 'drizzle-orm';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { RowWrite } from '../../program.ts';
import {
  boolean,
  type FieldDefinition,
  integer,
  type TableRows,
  text,
} from '../../server/schema.ts';
import { type Named, rowsOf, type RowUpdate } from '../rows.ts';
import { quoted } from './capture.ts';
import type { D1Binding } from './client.ts';
import type { SqliteKeyColumn } from './keys.ts';
import { sqliteKeyText } from './values.ts';

/**
 * A row of a table in D1, as its statements read and write it (`rows.ts`): by `?`s, as Drizzle
 * writes them, so that a read's condition is one the client follows (`where.ts`); its keys as the
 * log keeps their text. Each column is named by its table, as SQLite takes a quoted name of no
 * column for a string, and read by its place, as SQLite answers it by the name the database spells.
 * D1 answers no SQLSTATE: what it refuses is told by the text of its error —
 * `D1_ERROR: UNIQUE constraint failed: t.c: SQLITE_CONSTRAINT (extended: …)` — and an error of any
 * other text, or an error D1 keeps to itself (`internal error; reference = …`, of a deferred foreign
 * key), is a fault.
 */

/** A key's value another row holds, of a primary key or a unique column set. */
const TAKEN = /\bUNIQUE constraint failed\b|\bSQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)\b/u;
/** What SQLite refuses of a value: a constraint, a trigger's `RAISE`, a type a column holds not. */
const REFUSED = /\bSQLITE_CONSTRAINT\b|\bSQLITE_MISMATCH\b/u;

/** A statement of D1's, as much of it as a row's are run by. */
interface D1Statement {
  readonly bind: (...values: unknown[]) => { readonly raw: () => Promise<unknown> };
}

/** What a write may put in `column`, of a type a state may hold; nothing of any other. */
function definitionOf(column: Column): FieldDefinition | undefined {
  switch (column.columnType) {
    case 'SQLiteBoolean': {
      return boolean();
    }
    case 'SQLiteInteger': {
      return integer();
    }
    case 'SQLiteText': {
      return text();
    }
    default: {
      return undefined;
    }
  }
}

/** The log's image of the row `named` holds: each key among them, as the log keeps it. */
function imageOf(named: Named, keys: readonly SqliteKeyColumn[]): Readonly<Record<string, string>> {
  const image: Record<string, string> = {};
  for (const key of keys) {
    const held = named.has(key.column) ? sqliteKeyText(key.kind, named.get(key.column)) : undefined;
    if (held !== undefined) image[key.field] = held;
  }
  return Object.freeze(image);
}

/** The text of `error`, and of what caused it, where D1 keeps the database's own. */
function saidBy(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return `${String(error)} ${String(cause)}`;
}

/**
 * What a write that failed with `error` became, where sending it again would answer the same; a
 * fault of anything else, which the page sends again.
 */
function writeRefusedBy(error: unknown): RowWrite {
  const said = saidBy(error);
  if (TAKEN.test(said)) return 'taken';
  if (REFUSED.test(said)) return 'invalid';
  throw error;
}

/** The rows of `table`, of the keys `keys`, a state may bind, through what `connected` answers. */
export function sqliteRows(
  table: SQLiteTable,
  keys: readonly SqliteKeyColumn[],
  connected: () => D1Binding,
): TableRows<unknown> {
  const config = getTableConfig(table);
  const relation = quoted(config.name);
  const matching = (named: Named): string =>
    [...named.keys()].map((column) => `${relation}.${quoted(column)} = ?`).join(' and ');
  /** The rows D1 answers of `statement`, run with `values`: each by its columns' places. */
  const answered = async (statement: string, values: readonly unknown[]) => {
    const prepared = connected().prepare(statement) as D1Statement;
    const rows: unknown = await prepared.bind(...values).raw();
    return rows as readonly (readonly unknown[])[];
  };
  const read = async (named: Named, columns: readonly string[]) => {
    const list = columns.map((column) => `${relation}.${quoted(column)}`).join(', ');
    const statement = `select ${list} from ${relation} where ${matching(named)}`;
    const [row] = await answered(statement, [...named.values()]);
    return row && Object.fromEntries(columns.map((column, at) => [column, row[at]]));
  };
  /** Of a value it was to hold, of no collation of the column's, which may find another equal. */
  const write = async (named: Named, { column, held, value }: RowUpdate): Promise<RowWrite> => {
    const name = quoted(column);
    const guard = held === undefined ? '' : ` and ${relation}.${name} collate binary = ?`;
    const values = [value, ...named.values(), ...(held === undefined ? [] : [held])];
    const statement = `update ${relation} set ${name} = ? where ${matching(named)}${guard} returning 1`;
    try {
      return (await answered(statement, values)).length > 0 ? 'written' : 'absent';
    } catch (error) {
      return writeRefusedBy(error);
    }
  };
  return rowsOf(table, {
    definitionOf,
    imageOf: (named) => imageOf(named, keys),
    keys: config,
    read,
    write,
  });
}
