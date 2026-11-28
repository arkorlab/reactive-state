import { LOG, logTrigger, runsAfter } from './installed.ts';
import { folded, namesPragmaFunction } from './where.ts';

/**
 * What the schemas say of whether a statement wrote no row. Both are read, `main` and `temp`
 * (temporary objects live in the latter), in one statement, and held to two rules.
 *
 * Counts: SQLite counts the rows a statement and its triggers write, but a `pragma_` function
 * (`pragma_optimize`) writes uncounted, from a trigger body or a view that calls it, or from a
 * virtual table that reads it (`fts5(…, content='pragma_optimize')`), which no statement text
 * shows. So zero counts mean nothing where any trigger, view or virtual table names one, or is
 * unreadable. Virtual tables are not refused as such: FTS5 of plain content is common. They are
 * picked by the head of their text (`CREATE VIRTUAL TABLE`), not by `LIKE`, which
 * `PRAGMA case_sensitive_like` changes.
 *
 * Empty `RETURNING`: a table's own conflict clause (`PRIMARY KEY … ON CONFLICT IGNORE`), and a
 * trigger that runs before the write (`BEFORE`, or of no time given, which is one), can drop a row
 * after the trigger wrote, with nothing returned; and so can a trigger of the application's on the
 * log, which the log's own triggers write. A trigger that runs after cannot hide a returned row. So
 * an empty answer proves it only of a table of no conflict clause, whose every trigger is the log's
 * own or runs after, and of no uncounted writer. A check that raises (`raise` in the text of the
 * table, the log or an index on either) can end the statement after the log's trigger wrote, so
 * none may hold the word. A row of the `temp` schema blocks the proof: a
 * trigger, a view or a virtual table of any name, or a table of the written table's name or the
 * log's, which may shadow the main one or add to it. A temporary table of another name is not read.
 */

/** The rows of the objects whose text can write uncounted: triggers, views, virtual tables. */
const OBJECT =
  "(type IN ('trigger', 'view') OR (type = 'table' AND instr(upper(sql), 'VIRTUAL') > 0))";
/** The rows of every such object of both schemas. */
const OBJECTS = `SELECT 'main' AS home, type, name, tbl_name, sql FROM main.sqlite_schema WHERE ${OBJECT}
UNION ALL SELECT 'temp' AS home, type, name, tbl_name, sql FROM temp.sqlite_schema WHERE ${OBJECT}`;
/**
 * The rows of both schemas that belong to the written table (`?1`) and to the log (`?2`), by their
 * names in any case, and of every such object, each marked with the schema it came from.
 */
const SCHEMA = `SELECT 'main' AS home, type, name, tbl_name, sql FROM main.sqlite_schema WHERE ${OBJECT} OR tbl_name COLLATE NOCASE IN (?1, ?2)
UNION ALL SELECT 'temp' AS home, type, name, tbl_name, sql FROM temp.sqlite_schema WHERE ${OBJECT} OR tbl_name COLLATE NOCASE IN (?1, ?2)`;
/** A text that creates a table of the database's own, not a virtual one. */
const CREATES_TABLE = /^\s*create\s+table\b/iu;
/** A word of a conflict clause, in any case, wherever it stands. */
const CONFLICT = /conflict/iu;

/** Whether `row` is a row of `sqlite_schema`. */
function isRow(row: unknown): row is Readonly<Record<string, unknown>> {
  return typeof row === 'object' && row !== null;
}

/** Whether `row` of a schema belongs to the table `name`, by its name in any case. */
function on(row: Readonly<Record<string, unknown>>, name: string): boolean {
  return folded(String(row['tbl_name'])) === folded(name);
}

/**
 * A text that makes a virtual table: its head, `CREATE VIRTUAL TABLE`, in any spacing. Not `LIKE`,
 * which `PRAGMA case_sensitive_like` changes, nor the word anywhere, which a generated column
 * (`AS (…) VIRTUAL`) holds.
 */
const VIRTUAL = ['create', 'virtual', 'table'];

/** Whether `text` begins as `CREATE VIRTUAL TABLE` does, past its spaces: as SQLite keeps it. */
function makesVirtual(text: string): boolean {
  const words = text.trim().toLowerCase().split(/\s+/u, VIRTUAL.length);
  return VIRTUAL.every((word, at) => words[at] === word);
}

/** Whether `text` makes a virtual table that names a `pragma_` function. */
function virtualNaming(text: string): boolean {
  return makesVirtual(text) && namesPragmaFunction(text);
}

/**
 * Whether the database may write uncounted, by `rows` of the schemas: a trigger, a view or a
 * virtual table, whoever made it, whose text is no string or names a `pragma_` function (in any
 * case, quoted, in a string or a comment), or is a row not read. A trigger shaped like the log's
 * own may still join another source, so none is exempt; the log's real triggers never name one.
 */
export function writesUncounted(rows: readonly unknown[]): boolean {
  return rows.some((row) => {
    if (!isRow(row)) return true;
    const text = row['sql'];
    if (row['type'] === 'table') return typeof text === 'string' && virtualNaming(text);
    if (row['type'] !== 'trigger' && row['type'] !== 'view') return false;
    return typeof text !== 'string' || namesPragmaFunction(text);
  });
}

/** A word `RAISE`, in any case, anywhere in a text. */
const RAISE = /raise/iu;

/** Whether `row` is the log's table, made with a conflict clause, which may replace a row. */
function replacesIn(row: Readonly<Record<string, unknown>>): boolean {
  const text = row['sql'];
  return row['type'] === 'table' && on(row, LOG) && typeof text === 'string' && CONFLICT.test(text);
}

/** Whether `row`, of the table `table` or the log but not a trigger, holds `raise` in its text. */
function raisesIn(row: Readonly<Record<string, unknown>>, table: string): boolean {
  const text = row['sql'];
  const own = on(row, table) || on(row, LOG);
  return own && row['type'] !== 'trigger' && typeof text === 'string' && RAISE.test(text);
}

/**
 * Whether `rows` of the schemas prove that the table `table` hides no row from a `RETURNING`: no
 * row of a `temp` schema (a trigger, a view, a virtual table, or a table of the written table's or
 * the log's name), which shadows or adds to the main one; no trigger on the log, which
 * a trigger of the log's own writes to, and which may delete the row; no `raise` in the text of
 * the written table or the log, or of an index on either, as a check that raises ends the
 * statement after the log's trigger wrote; no conflict clause in the log's table, which a log
 * insert may then replace a row by; and the one table of its name, created plainly with no
 * conflict clause, each trigger on which is the log's own or runs after.
 */
export function hidesNoRow(rows: readonly unknown[], table: string): boolean {
  const checked = rows.filter((row) => isRow(row));
  if (checked.length !== rows.length) return false;
  if (checked.some((row) => row['home'] === 'temp') || writesUncounted(checked)) return false;
  if (checked.some((row) => row['type'] === 'trigger' && on(row, LOG))) return false;
  if (checked.some((row) => raisesIn(row, table) || replacesIn(row))) return false;
  const tables = checked.filter((row) => row['type'] === 'table' && on(row, table));
  const sql = tables[0]?.['sql'];
  if (typeof sql !== 'string' || tables.length !== 1) return false;
  if (!CREATES_TABLE.test(sql) || CONFLICT.test(sql)) return false;
  return checked
    .filter((row) => row['type'] === 'trigger' && on(row, table))
    .every((row) => {
      const text = row['sql'];
      return logTrigger(row) || (typeof text === 'string' && runsAfter(text));
    });
}

/** The rows `query` answers on `binding`, bound to `values`; none if it fails or answers none. */
async function rowsOf(
  binding: unknown,
  query: string,
  values: readonly unknown[],
): Promise<readonly unknown[] | undefined> {
  try {
    const prepare: unknown = Reflect.get(new Object(binding), 'prepare');
    if (typeof prepare !== 'function') return undefined;
    const statement = Reflect.apply(prepare, binding, [query]) as {
      readonly bind: (...values: unknown[]) => { readonly all: () => Promise<unknown> };
    };
    const answer = await statement.bind(...values).all();
    const rows: unknown = isRow(answer) ? answer['results'] : undefined;
    return Array.isArray(rows) ? (rows as readonly unknown[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `binding` proves by the schemas that zero counts of a statement mean no row written: no
 * trigger or view may write uncounted. A read that fails, or answers anything unexpected, proves
 * nothing; it is a read, told to no operation.
 */
export async function provenCounts(binding: unknown): Promise<boolean> {
  const rows = await rowsOf(binding, OBJECTS, []);
  return rows !== undefined && !writesUncounted(rows);
}

/**
 * Whether `binding` proves by the schemas of `table` that an empty `RETURNING` of a write of it
 * wrote nothing, on the same terms.
 */
export async function provenEmpty(binding: unknown, table: string): Promise<boolean> {
  const rows = await rowsOf(binding, SCHEMA, [table, LOG]);
  return rows !== undefined && hidesNoRow(rows, table);
}
