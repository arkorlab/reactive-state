import { is, SQL } from 'drizzle-orm';
import { getTableConfig, SQLiteSyncDialect, type SQLiteTable } from 'drizzle-orm/sqlite-core';

/**
 * The statements that make tables of a Drizzle schema of SQLite's, as an application's migration
 * would, read of the schema alone (`getTableConfig`): each column of its type, `NOT NULL`, default
 * and primary key, each CHECK of the schema's own SQL, and each index — so that what the database
 * enforces is what the follow reads of the schema, and nothing is written twice. It makes what the
 * test application's schema declares, and refuses what it does not: a key of several columns, a
 * foreign key, a constraint of `unique()`, an index of an expression or a condition, a value bound.
 */

const dialect = new SQLiteSyncDialect();

/** A column of a table, as the table's configuration holds it. */
type Column = ReturnType<typeof getTableConfig>['columns'][number];

function fail(message: string): never {
  throw new TypeError(`ddlOf(): ${message}`);
}

/** A name as SQLite quotes one. */
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The text of `fragment`, its columns unqualified, as a table's own constraint names them. */
function textOf(fragment: SQL): string {
  const { params, sql } = dialect.sqlToQuery(fragment, 'indexes');
  if (params.length > 0) fail(`a table's statement binds no value: ${sql}`);
  return sql;
}

/** The default of `column` as SQL's literal: of the value its driver writes. */
function literalOf(column: Column): string {
  const written: unknown = column.mapToDriverValue(column.default);
  if (typeof written === 'number' && Number.isSafeInteger(written)) return String(written);
  if (typeof written === 'string') return `'${written.replaceAll("'", "''")}'`;
  return fail(`the default of ${column.name} is no integer or text`);
}

function columnOf(column: Column): string {
  const parts = [quoted(column.name), column.getSQLType().toUpperCase()];
  if (column.primary) parts.push('PRIMARY KEY');
  if (column.notNull) parts.push('NOT NULL');
  if (column.default !== undefined) parts.push(`DEFAULT ${literalOf(column)}`);
  return parts.join(' ');
}

/** The statements that make `table` and its indexes. */
function statementsOf(table: SQLiteTable): readonly string[] {
  const config = getTableConfig(table);
  const { checks, foreignKeys, indexes, name, primaryKeys, uniqueConstraints } = config;
  if (primaryKeys.length + foreignKeys.length + uniqueConstraints.length > 0) {
    fail(`${name} holds a key of several columns, a foreign key or a unique constraint`);
  }
  const constraints = checks.map(
    (each) => `CONSTRAINT ${quoted(each.name)} CHECK (${textOf(each.value)})`,
  );
  const defined = [...config.columns.map((column) => columnOf(column)), ...constraints];
  const made = indexes.map((index) => {
    const { columns, unique, where } = index.config;
    if (where !== undefined) fail(`the index ${index.config.name} is of a condition`);
    const named = columns.map((column) =>
      is(column, SQL) ? fail(`the index ${index.config.name} is of an expression`) : column,
    );
    const on = named.map((column) => quoted(column.name)).join(', ');
    const kind = unique ? 'UNIQUE INDEX' : 'INDEX';
    return `CREATE ${kind} ${quoted(index.config.name)} ON ${quoted(name)} (${on})`;
  });
  return [`CREATE TABLE ${quoted(name)} (${defined.join(', ')})`, ...made];
}

/** The statements that make `tables`, in their order, each table's indexes after it. */
export function ddlOf(tables: readonly SQLiteTable[]): readonly string[] {
  return tables.flatMap((table) => statementsOf(table));
}
