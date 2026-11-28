import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';

import { changeLogSql } from '../../cloudflare/d1-log.ts';
import type { SqliteKeyColumn } from './keys.ts';

/**
 * The change log of a Drizzle schema's tables in SQLite — D1's — as their triggers write it: the
 * log of `changeLogSql`, `_rs_changes`, a row of each row a statement changed, of the table as the
 * schema declares it, holding the text of the row's keys before the change and after it, which
 * renders again what read rows of those values (`store.ts`'s reading of the log). A table of no keys
 * logs each change of the table alone. A statement of `REPLACE` deletes the rows its new row would
 * take the place of, with no trigger of the delete — SQLite's own, where `recursive_triggers` is
 * off — so before an insert or an update, each row its new values meet on a unique column set, or
 * on its `rowid`, is logged as deleted. The triggers read no index's condition, so a unique index
 * of part of the rows is met on its columns alone, whatever the condition says of the rows, and by
 * each update, whatever it changes: one of the condition's columns alone may bring the row into the
 * index. A table of a unique index on an expression, of one of part of the rows none of whose
 * columns an index of all of them begins with — whose rows met would be found by reading the whole
 * table — or whose `rowid` no name reads, logs its inserts and updates of the table alone. A table
 * the database makes `WITHOUT ROWID`, which Drizzle declares none of, has no `rowid` the triggers
 * read: its writes fail.
 */

/** The log the triggers write, as `changeLogSql` makes it. */
const LOG = '_rs_changes';
/** The milliseconds since the epoch, as SQLite tells them of its clock. */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
/** How many of a row's keys one `json_object` takes, as D1 limits a function's arguments. */
const KEYS_A_CALL = 16;
/** The id of every change of a row: none of the log's tables is read by its records' ids. */
const ROW = 'row';
const UTF8 = new TextEncoder();
const HEX_RADIX = 16;
/** The names SQLite reads a table's `rowid` by, where no column of the table has the name in any case. */
const ROWID_NAMES = ['rowid', '_rowid_', 'oid'];

/** A followed table of SQLite: as the schema declares it, its name, its keys, its unique columns. */
export interface FollowedSqliteTable {
  readonly declared: string;
  readonly name: string;
  readonly keys: readonly SqliteKeyColumn[];
  /** The column sets a row's new values may meet another's on: its primary and unique keys. */
  readonly uniques: readonly (readonly string[])[];
  /**
   * The column sets of its unique indexes of part of its rows, which an update may meet another
   * row on whatever it changes: of a column of the condition alone too.
   */
  readonly partials: readonly (readonly string[])[];
  /**
   * Whether a unique index of the table is of an expression, or of part of its rows and of columns
   * no index of all of them begins with.
   */
  readonly unreadUnique: boolean;
  /** The name the table's `rowid` is read by: one no column has; none where each is a column's. */
  readonly rowid: string | undefined;
}

/** An SQL identifier, quoted: any name, its quotes doubled. */
export function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** An SQL text literal, its quotes doubled. */
function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** UTF-8 bytes as ASCII hex: a trigger's name of any declared name. */
function hex(text: string): string {
  return Array.from(UTF8.encode(text), (byte) => byte.toString(HEX_RADIX).padStart(2, '0')).join(
    '',
  );
}

/** The name of a column of a table's config, where it is a plain column. */
function columnName(column: unknown): string | undefined {
  const name: unknown =
    typeof column === 'object' && column !== null ? Reflect.get(column, 'name') : undefined;
  return typeof name === 'string' ? name : undefined;
}

/**
 * The first column of each index of all of the rows `config` declares, its primary key's and its
 * unique columns' too: a statement of a value of one of them reads the rows of that value alone.
 */
function leadingOf(config: ReturnType<typeof getTableConfig>): ReadonlySet<string> {
  const leading = new Set<string>();
  const first = (columns: readonly unknown[]): void => {
    const name = columnName(columns[0]);
    if (name !== undefined) leading.add(name);
  };
  for (const column of config.columns) {
    if (column.primary || column.isUnique) leading.add(column.name);
  }
  for (const key of config.primaryKeys) first(key.columns);
  for (const unique of config.uniqueConstraints) first(unique.columns);
  for (const index of config.indexes) {
    if (index.config.where === undefined) first(index.config.columns);
  }
  return leading;
}

/**
 * The column sets of `table` a row's new values may meet another's on, and whether one is unread:
 * of an expression, or of a unique index of part of the rows none of whose columns an index of all
 * of them begins with. The trigger's statement of such a set, of no condition of the index's, is
 * served by no index of part of the rows: it would read the whole table at each insert and update.
 */
function uniquesOf(
  table: SQLiteTable,
): Pick<FollowedSqliteTable, 'partials' | 'uniques' | 'unreadUnique'> {
  const config = getTableConfig(table);
  const leading = leadingOf(config);
  const uniques: (readonly string[])[] = [];
  const partials: (readonly string[])[] = [];
  let unreadUnique = false;
  const add = (columns: readonly unknown[], partial = false): void => {
    const names = columns.map((column) => columnName(column));
    if (names.every((name) => name !== undefined)) {
      if (!partial) {
        uniques.push(names);
        return;
      }
      if (names.some((name) => leading.has(name))) {
        partials.push(names);
        return;
      }
    }
    unreadUnique = true;
  };
  for (const column of config.columns) {
    if (column.primary || column.isUnique) uniques.push([column.name]);
  }
  for (const key of config.primaryKeys) add(key.columns);
  for (const unique of config.uniqueConstraints) add(unique.columns);
  for (const index of config.indexes) {
    if (index.config.unique) add(index.config.columns, index.config.where !== undefined);
  }
  return { partials, uniques, unreadUnique };
}

/** A followed table of `table`, declared as `declared`, of its keys `keys`. */
export function followedSqliteTable(
  declared: string,
  table: SQLiteTable,
  keys: readonly SqliteKeyColumn[],
): FollowedSqliteTable {
  const config = getTableConfig(table);
  // SQLite's names are of any case: a column `ROWID` is the one `rowid` reads.
  const columns = new Set(config.columns.map((column) => column.name.toLowerCase()));
  const rowid = ROWID_NAMES.find((name) => !columns.has(name));
  return { declared, keys, name: config.name, rowid, ...uniquesOf(table) };
}

/** The JSON object of a row's keys, `row`'s, as each one's text: what the log keeps of it. */
function imageOf(keys: readonly SqliteKeyColumn[], row: string): string {
  let image = 'json_object()';
  for (let at = 0; at < keys.length; at += KEYS_A_CALL) {
    const pairs = keys
      .slice(at, at + KEYS_A_CALL)
      .flatMap((key) => [literal(key.field), `CAST(${row}.${quoted(key.column)} AS TEXT)`]);
    const next = `json_object(${pairs.join(', ')})`;
    // Text alone is captured, so the object's one trailing brace closes it.
    image = at === 0 ? next : `(rtrim(${image}, '}') || ',' || substr(${next}, 2))`;
  }
  return image;
}

/** The statement that logs the rows `values` gives. */
function logged(values: string): string {
  return `INSERT INTO ${LOG} (tbl, id, before, after, at) ${values}`;
}

/** The events a table's triggers are of, by the last part of each one's name. */
const EVENTS = ['insert', 'update', 'delete', 'replaced_insert', 'replaced_update'] as const;

/** The name of the trigger of `event` of the table declared as `declared`. */
function triggerName(declared: string, event: (typeof EVENTS)[number]): string {
  return `_rsd_${hex(declared)}_${event}`;
}

/**
 * The triggers of `table`, which log each row a statement changes of it, by their names: each
 * one's statement, as `sqlite_schema` keeps it, which the store holds the database's to.
 */
export function sqliteTriggersOf(table: FollowedSqliteTable): ReadonlyMap<string, string> {
  const on = quoted(table.name);
  const named = (event: (typeof EVENTS)[number]): string =>
    quoted(triggerName(table.declared, event));
  const of = (id: string, before: string, after: string): string =>
    logged(`VALUES (${literal(table.declared)}, ${literal(id)}, ${before}, ${after}, ${NOW_MS})`);
  const keyed = table.keys.length > 0;
  const whole = of('', 'NULL', 'NULL');
  const inserted = keyed ? of(ROW, 'NULL', imageOf(table.keys, 'NEW')) : whole;
  const updated = keyed ? of(ROW, imageOf(table.keys, 'OLD'), imageOf(table.keys, 'NEW')) : whole;
  const deleted = keyed ? of(ROW, imageOf(table.keys, 'OLD'), 'NULL') : whole;
  // The rows a new row's values meet on a unique column set, which `REPLACE` deletes unlogged: of a
  // table of no keys, its change of the table alone stands for them; of a unique index the
  // triggers cannot read, the table alone.
  // An update meets another row only where it changes the set's values: else the row is its own.
  // On the set of an index of part of the rows, whatever it changes — the condition's columns alone
  // may bring the row into the index — any row but itself, told apart by the `rowid` (`apart`).
  const meeting = (columns: readonly string[], onUpdate: boolean, apart?: string): string => {
    // Exactly, of the type and the bytes: a column's collation (`NOCASE`) may find `'A'` and `'a'`
    // one where the unique index finds them two.
    const kept = columns.map((column) => {
      const [now, before] = [`NEW.${quoted(column)}`, `OLD.${quoted(column)}`];
      return `(${now} IS ${before} COLLATE BINARY AND typeof(${now}) = typeof(${before}))`;
    });
    // By the set's values, as an index of it reads them: an update of a table of a trigger of the
    // application's before it, whose values SQLite reads again after it, is of the table alone
    // (`installed.ts`).
    const same = columns
      .map((column) => `c.${quoted(column)} = NEW.${quoted(column)}`)
      .join(' AND ');
    const others =
      apart === undefined
        ? ` AND NOT (${kept.join(' AND ')})`
        : ` AND c.${quoted(apart)} IS NOT OLD.${quoted(apart)}`;
    return logged(
      `SELECT ${literal(table.declared)}, ${literal(ROW)}, ${imageOf(table.keys, 'c')}, NULL, ${NOW_MS} FROM ${on} AS c WHERE ${same}${onUpdate ? others : ''}`,
    );
  };
  // Every rowid table's rows are unique by their `rowid`, which a `REPLACE` may name.
  const met = (onUpdate: boolean): string => {
    if (!keyed) return '';
    const { rowid } = table;
    const statements =
      rowid === undefined || table.unreadUnique
        ? [whole]
        : [
            ...[...table.uniques, [rowid]].map((columns) => meeting(columns, onUpdate)),
            ...table.partials.map((columns) => meeting(columns, onUpdate, rowid)),
          ];
    return `${statements.join('; ')};`;
  };
  const made = (event: (typeof EVENTS)[number], text: string): readonly [string, string] => {
    const name = triggerName(table.declared, event);
    return [name, `CREATE TRIGGER ${named(event)} ${text}`];
  };
  return new Map([
    made('delete', `AFTER DELETE ON ${on} BEGIN ${deleted}; END`),
    made('insert', `AFTER INSERT ON ${on} BEGIN ${inserted}; END`),
    made('update', `AFTER UPDATE ON ${on} BEGIN ${updated}; END`),
    ...(keyed
      ? [
          made('replaced_insert', `BEFORE INSERT ON ${on} BEGIN ${met(false)} END`),
          made('replaced_update', `BEFORE UPDATE ON ${on} BEGIN ${met(true)} END`),
        ]
      : []),
  ]);
}

/** The statements that make the triggers of `table` anew: each dropped, then made. */
function triggersOf(table: FollowedSqliteTable): readonly string[] {
  return [
    ...EVENTS.map(
      (event) => `DROP TRIGGER IF EXISTS ${quoted(triggerName(table.declared, event))}`,
    ),
    ...sqliteTriggersOf(table).values(),
  ];
}

/**
 * The statements that make the change log of `tables` in SQLite: the log and its epoch, then each
 * table's triggers, made anew, then an entry of each table alone. A migration that makes one of the
 * tables again drops its triggers with it, and its rows with no entry of them — of a schema whose
 * text may be as it was, which the store's digest tells not: run these after it, in one D1 batch,
 * and whatever read the tables renders again.
 */
export function sqliteCaptureSql(tables: readonly FollowedSqliteTable[]): readonly string[] {
  return [
    ...changeLogSql(),
    ...tables.flatMap((table) => triggersOf(table)),
    ...tables.map((table) =>
      logged(`VALUES (${literal(table.declared)}, '', NULL, NULL, ${NOW_MS})`),
    ),
  ];
}
