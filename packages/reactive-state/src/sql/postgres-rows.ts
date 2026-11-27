import type { Column } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

import type { RowWrite } from '../program.ts';
import { boolean, type FieldDefinition, integer, type TableRows, text } from '../server/schema.ts';
import { qualified, quoted } from './capture.ts';
import { codeOf } from './client.ts';
import type { Queryable } from './digest.ts';
import type { KeyColumn } from './keys.ts';
import { keyDigest } from './reads.ts';
import { type Named, rowsOf, type RowUpdate } from './rows.ts';
import { valueText } from './values.ts';

/**
 * A row of a table in PostgreSQL or PGlite, as its statements read and write it (`rows.ts`): by
 * parameters of PostgreSQL's numbers, its values as the log keeps their digests, and what the
 * database refuses as its SQLSTATE says.
 */

/** The columns' types a state may hold, as a value of JSON a page sends back the same. */
const INTEGERS = {
  PgInteger: { max: 2_147_483_647, min: -2_147_483_648 },
  PgSmallInt: { max: 32_767, min: -32_768 },
} as const;
/**
 * What the database says of a write, by SQLSTATE: of a unique key held twice, of a right or a policy
 * that refuses it, and of what the application's trigger raised; and the classes of what it refuses
 * of a value — its data, a constraint, a limit of what it can hold.
 */
const SQLSTATE = {
  classes: ['22', '23', '54'],
  data: '22',
  privilege: '42501',
  raised: 'P0001',
  unique: '23505',
} as const;

/** What a write may put in `column`, of a type a state may hold; nothing of any other. */
function definitionOf(column: Column): FieldDefinition | undefined {
  switch (column.columnType) {
    case 'PgBoolean': {
      return boolean();
    }
    case 'PgInteger':
    case 'PgSmallInt': {
      return integer(INTEGERS[column.columnType]);
    }
    case 'PgEnumColumn':
    case 'PgEnumObjectColumn':
    case 'PgText':
    case 'PgUUID':
    case 'PgVarchar': {
      return text();
    }
    default: {
      return undefined;
    }
  }
}

/** The log's image of the row `named` holds: each key among them, as the log keeps it. */
function imageOf(named: Named, keys: readonly KeyColumn[]): Readonly<Record<string, string>> {
  const image: Record<string, string> = {};
  for (const key of keys) {
    const written = named.has(key.column) ? valueText(key.kind, named.get(key.column)) : undefined;
    if (written !== undefined) image[key.field] = keyDigest(written);
  }
  return Object.freeze(image);
}

/** Whether `error` is the database's refusal of data, which no row of it could hold. */
function isOfData(error: unknown): boolean {
  return String(codeOf(error)).startsWith(SQLSTATE.data);
}

/**
 * What a write that failed with `error` became, where sending it again would answer the same; a
 * fault of anything else, which the page sends again.
 */
function writeRefusedBy(error: unknown): RowWrite {
  const code = String(codeOf(error));
  if (code === SQLSTATE.unique) return 'taken';
  if (code === SQLSTATE.privilege) return 'denied';
  if (code === SQLSTATE.raised || SQLSTATE.classes.some((kind) => code.startsWith(kind))) {
    return 'invalid';
  }
  throw error;
}

/** The condition `named` as a statement writes it, of the parameters from `$first` on. */
function matching(named: Named, first: number): string {
  const columns = [...named.keys()];
  return columns.map((column, at) => `${quoted(column)} = $${String(first + at)}`).join(' AND ');
}

/** The rows of `table`, of the keys `keys`, a state may bind, through what `connected` answers. */
export function postgresRows(
  table: PgTable,
  keys: readonly KeyColumn[],
  connected: () => Queryable,
): TableRows<unknown> {
  const config = getTableConfig(table);
  const relation = qualified({ name: config.name, schema: config.schema ?? 'public' });
  const read = async (named: Named, columns: readonly string[]) => {
    const list = columns.map((column) => quoted(column)).join(', ');
    const statement = `SELECT ${list} FROM ${relation} WHERE ${matching(named, 1)}`;
    try {
      const { rows } = await connected().query(statement, [...named.values()]);
      return (rows as readonly (Readonly<Record<string, unknown>> | undefined)[])[0];
    } catch (error) {
      if (isOfData(error)) return;
      throw error;
    }
  };
  /**
   * Of a value it was to hold, as its text, of no collation, which may find what another writer
   * left equal to it.
   */
  const write = async (named: Named, { column, held, value }: RowUpdate): Promise<RowWrite> => {
    const name = quoted(column);
    const values = [value, ...named.values()];
    const guard =
      held === undefined
        ? ''
        : ` AND ${name}::pg_catalog.text COLLATE pg_catalog."C" = $${String(values.length + 1)}`;
    const statement = `UPDATE ${relation} SET ${name} = $1 WHERE ${matching(named, 2)}${guard} RETURNING 1`;
    try {
      const { rows } = await connected().query(
        statement,
        held === undefined ? values : [...values, String(held)],
      );
      return rows.length > 0 ? 'written' : 'absent';
    } catch (error) {
      // A condition's own value may be what the database refuses, of which there is no row.
      if (isOfData(error) && (await read(named, [column])) === undefined) return 'absent';
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
