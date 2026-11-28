/**
 * What a plan of a D1 statement reads of the database's schema (`sqlite_schema`), beside its
 * `EXPLAIN` (`client.ts`): every table and index by its root page, which the bytecode's reads are
 * named by, and the statements of the tables its statement names alone, which their collation and
 * their kind are read of. A module of no imports.
 */

/** An SQL text literal, its quotes doubled. */
function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * The rows of `sqlite_schema` a plan of a statement reads: every table and index, by its root page,
 * and the statement of each table of `named` — the tables the statement names, in ASCII's case alone
 * as SQLite compares names — and of no other.
 */
export function planSchemaSql(named: readonly string[]): string {
  const text =
    named.length === 0
      ? 'NULL'
      : `CASE WHEN type = 'table' AND name COLLATE NOCASE IN (${named.map((name) => literal(name)).join(', ')}) THEN sql END`;
  return `SELECT type, name, tbl_name, rootpage, ${text} AS sql FROM sqlite_schema WHERE type IN ('table', 'index')`;
}
