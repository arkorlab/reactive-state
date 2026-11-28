import type { D1Binding } from './client.ts';
import { bareOf } from './where.ts';

/**
 * What the database holds of the followed tables that the triggers of `captureSql()` do not answer
 * for, as the store reads it once the schema's digest changes, off a render's path: the tables a
 * `REPLACE` may delete rows of that the triggers log not — by a unique index of an expression, of
 * another collation than `BINARY`, of columns that hold none of the column sets the triggers log
 * the rows met on (of an index of part of the rows, none of those they log by every update, as its
 * condition's columns alone may bring a row into it), or of a column `NOT NULL` of a default, which
 * `REPLACE` writes in place of a `NULL` after the triggers before it read the `NULL`; or by the
 * `rowid`, where a column of the database has the name the triggers read it by — and the tables
 * whose triggers are not those `captureSql()` makes: missing, of before (an index made unique
 * since), or rewritten by SQLite (a column renamed), which log what they should not, or nothing.
 */

/** What the database is held to of each followed table, by its declared name. */
export interface FollowedInstall {
  /** The table each followed table of the database is declared as, by its name in the database. */
  readonly byName: ReadonlyMap<string, string>;
  /** The column sets the triggers log the rows met on, by an update of the set's values. */
  readonly uniques: ReadonlyMap<string, readonly (readonly string[])[]>;
  /**
   * The column sets the triggers log the rows met on by every update, whatever it changes: of the
   * unique indexes of part of the rows.
   */
  readonly partials: ReadonlyMap<string, readonly (readonly string[])[]>;
  /** The name the triggers read the `rowid` by, where they read it. */
  readonly rowids: ReadonlyMap<string, string | undefined>;
  /** The triggers `captureSql()` makes, by their names: each one's statement. */
  readonly triggers: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** What the database holds that the triggers do not answer for, by the tables' declared names. */
export interface Installed {
  /** The tables of which an insert or an update is an entry of the table alone. */
  readonly replacing: ReadonlySet<string>;
  /**
   * The tables of which an update is an entry of the table alone: of a trigger of the
   * application's that may run before it, after which SQLite reads the columns the update's `SET`
   * names not again, which the log's trigger before it read otherwise.
   */
  readonly reloaded: ReadonlySet<string>;
  /** The tables whose triggers are not those `captureSql()` makes. */
  readonly untriggered: ReadonlySet<string>;
  /** Whether D1 answered no `PRAGMA` of the tables, which is asked again a while after. */
  readonly unanswered: boolean;
}

/** The rows of a batch's result. */
function rowsOf(result: unknown): readonly Readonly<Record<string, unknown>>[] {
  const rows: unknown =
    typeof result === 'object' && result !== null ? Reflect.get(result, 'results') : undefined;
  return Array.isArray(rows) ? (rows as Readonly<Record<string, unknown>>[]) : [];
}

/** The log the triggers write. */
export const LOG = '_rs_changes';
/** An ASCII capital: SQLite's names and keywords are compared in ASCII's case alone. */
const CAPITAL = /[A-Z]/gu;

/** `text` in ASCII's lower case: `Ä` and `ä` are two names to SQLite. */
function lower(text: string): string {
  return text.replaceAll(CAPITAL, (capital) => capital.toLowerCase());
}

/** An SQL identifier, quoted. */
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The columns of a unique index, in lower case, as `PRAGMA index_xinfo` answers them; none where
 * one is an expression's, or is compared by another collation than `BINARY`.
 */
function indexColumnsOf(result: unknown): readonly string[] | undefined {
  const columns: string[] = [];
  for (const row of rowsOf(result)) {
    if (Number(row['key']) !== 1) continue;
    const name = row['name'];
    if (typeof name !== 'string' || Number(row['cid']) < 0 || row['coll'] !== 'BINARY') {
      return undefined;
    }
    columns.push(lower(name));
  }
  return columns.length === 0 ? undefined : columns;
}

/**
 * Whether `columns` are one of `sets`, in any order: a set of more columns would be met on where
 * one of them alone changes, which the trigger before an update reads not of the set it holds.
 */
function metOn(sets: readonly (readonly string[])[], columns: readonly string[]): boolean {
  return sets.some(
    (set) =>
      set.length === columns.length && set.every((column) => columns.includes(lower(column))),
  );
}

/**
 * A table's columns as `PRAGMA table_xinfo` answers them, in lower case — a generated one too,
 * which `table_info` leaves out — each, and the defaulted.
 */
interface Columns {
  readonly all: ReadonlySet<string>;
  /** The columns `NOT NULL` of a default, which `REPLACE` writes in place of a `NULL`. */
  readonly defaulted: ReadonlySet<string>;
  /** The generated columns, which may be of a defaulted one's value. */
  readonly generated: ReadonlySet<string>;
}

/** `table_xinfo`'s `hidden` of a generated column, virtual or stored. */
const HIDDEN = { stored: 3, virtual: 2 } as const;
const GENERATED = new Set<number>([HIDDEN.stored, HIDDEN.virtual]);

/** The columns of `result`, an answer of `PRAGMA table_xinfo`. */
function columnsOf(result: unknown): Columns {
  const all = new Set<string>();
  const defaulted = new Set<string>();
  const generated = new Set<string>();
  for (const row of rowsOf(result)) {
    const name = lower(String(row['name']));
    all.add(name);
    if (Number(row['notnull']) !== 0 && row['dflt_value'] !== null) defaulted.add(name);
    if (GENERATED.has(Number(row['hidden']))) generated.add(name);
  }
  return { all, defaulted, generated };
}

/**
 * Whether a `REPLACE` may write `indexed`'s values after the trigger before it read them: of a
 * column `NOT NULL` of a default, which it writes in place of a `NULL`, or of a generated column,
 * which may be of such a column's value, or of the rowid SQLite assigns after it (`-1` before).
 */
function defaultedOf(indexed: readonly string[], columns: Columns): boolean {
  return indexed.some((column) => columns.defaulted.has(column) || columns.generated.has(column));
}

/** A unique index of a followed table, by the table's declared name, and the table's columns. */
interface UniqueIndex {
  readonly table: string;
  readonly index: string;
  readonly columns: Columns;
  /** Whether it is of part of the rows: of a condition. */
  readonly partial: boolean;
}

/**
 * The unique indexes of each table of `names`, which are asked of, as the answers `asked` say —
 * `PRAGMA index_list` and `table_xinfo` of each, in turn; the tables `replacing` takes whose
 * rowid's name is a column's.
 */
function uniqueIndexesOf(
  asked: readonly unknown[],
  names: readonly (readonly [string, string])[],
  followed: FollowedInstall,
  replacing: Set<string>,
): readonly UniqueIndex[] {
  const indexes: UniqueIndex[] = [];
  for (const [at, [, table]] of names.entries()) {
    const columns = columnsOf(asked[at * 2 + 1]);
    const rowid = followed.rowids.get(table);
    if (rowid !== undefined && columns.all.has(rowid)) replacing.add(table);
    const rows = rowsOf(asked[at * 2]);
    for (const row of rows) {
      if (Number(row['unique']) !== 1) continue;
      indexes.push({
        columns,
        index: String(row['name']),
        partial: Number(row['partial']) !== 0,
        table,
      });
    }
  }
  return indexes;
}

/** The followed tables, by their declared names, a `REPLACE` may delete rows of that the triggers log not. */
async function replacingOf(
  binding: D1Binding,
  followed: FollowedInstall,
): Promise<ReadonlySet<string>> {
  const prepare = (sql: string): unknown => binding.prepare(sql);
  const names = [...followed.byName];
  const replacing = new Set<string>();
  const asked = await binding.batch(
    names.flatMap(([name]) => {
      return [
        prepare(`PRAGMA index_list(${quoted(name)})`),
        prepare(`PRAGMA table_xinfo(${quoted(name)})`),
      ];
    }),
  );
  const indexes = uniqueIndexesOf(asked, names, followed, replacing);
  if (indexes.length === 0) return replacing;
  const infos = await binding.batch(
    indexes.map(({ index }) => prepare(`PRAGMA index_xinfo(${quoted(index)})`)),
  );
  for (const [at, { columns, partial, table }] of indexes.entries()) {
    const indexed = indexColumnsOf(infos[at]);
    // An index of part of the rows, of a set the triggers log the rows met on by every update: its
    // condition's columns alone may bring a row into it.
    const partials = followed.partials.get(table) ?? [];
    const sets = partial ? partials : [...(followed.uniques.get(table) ?? []), ...partials];
    if (indexed === undefined || defaultedOf(indexed, columns) || !metOn(sets, indexed)) {
      replacing.add(table);
    }
  }
  return replacing;
}

/** A log's trigger, of any follow's: `_rsd_<hex of a declared name>_<event>`. */
const LOG_TRIGGER = /^_rsd_[\da-f]+_(?<event>[a-z_]+)$/u;
/** The time and the event of a log's trigger, by the last part of its name, as `capture.ts` makes it. */
const LOG_EVENTS = new Map([
  ['delete', 'AFTER DELETE'],
  ['insert', 'AFTER INSERT'],
  ['replaced_insert', 'BEFORE INSERT'],
  ['replaced_update', 'BEFORE UPDATE'],
  ['update', 'AFTER UPDATE'],
]);
/** The log's own words: a statement that appends to it, and the end of a trigger's statements. */
const LOG_BODY = { end: ' END', log: 'INSERT INTO _rs_changes ' } as const;
/** Keywords outside a trigger's strings and names: `CONFLICT`, `FROM`, `IN`, `JOIN`, `RAISE`. */
const WORDS = {
  conflict: /\bconflict\b/iu,
  from: /\bfrom\b/giu,
  in: /\bin\b/iu,
  join: /\bjoin\b/iu,
  raise: /\braise\b/iu,
} as const;

/**
 * Whether `row` of `sqlite_schema` is a log's trigger — of another follow's of the table too, of
 * another declared name — and not the application's: of a log's name, of the head `capture.ts`
 * gives it (`CREATE TRIGGER "<name>" <time> ON "<table>" BEGIN`, of no `WHEN`), and of statements
 * that append to the log alone, reading the trigger's own table alone (`FROM "<table>" AS c`), of
 * no `RAISE`, `JOIN`, `IN` or `CONFLICT` outside its strings and names (an upsert may update a log
 * row, and a foreign key cascade change the row written), each of whose `FROM`s is the table's
 * own: another source it reads, by a join, a comma or `IN`, may raise. Of any other text, it is
 * the application's.
 */
export function logTrigger(row: Readonly<Record<string, unknown>>): boolean {
  const [name, table, sql] = [String(row['name']), String(row['tbl_name']), row['sql']];
  const event = LOG_TRIGGER.exec(name)?.groups?.['event'];
  const time = event === undefined ? undefined : LOG_EVENTS.get(event);
  const head = `CREATE TRIGGER ${quoted(name)} ${time ?? ''} ON ${quoted(table)} BEGIN `;
  if (time === undefined || typeof sql !== 'string' || !sql.startsWith(head)) return false;
  if (!sql.endsWith(LOG_BODY.end)) return false;
  const body = sql.slice(head.length, -LOG_BODY.end.length);
  const bare = bareOf(body);
  // Every `FROM` is of the table itself, `capture.ts`'s `FROM "<table>" AS c WHERE`: counted in the
  // text, and in the bare text where strings and comments hold none and a name is blanked.
  const own = `FROM ${quoted(table)} AS c WHERE `;
  const froms = [...bare.matchAll(WORDS.from)].length;
  return (
    !WORDS.raise.test(bare) &&
    !WORDS.join.test(bare) &&
    !WORDS.in.test(bare) &&
    !WORDS.conflict.test(bare) &&
    froms === body.split(own).length - 1 &&
    froms === bare.split(bareOf(own)).length - 1 &&
    bare.split(';').every((statement) => {
      const trimmed = statement.trim();
      return trimmed === '' || trimmed.startsWith(LOG_BODY.log);
    })
  );
}

/**
 * Whether a trigger of the table `name` but `made` was made after the first of `made` (of the row
 * `first` of `sqlite_schema`): SQLite fires a table's triggers newest first, and a `RAISE(IGNORE)`
 * an application's runs — of its text, or of a view it reads, which no text of its tells — skips
 * the row's triggers due after it, the log's.
 */
function firedBefore(
  schema: readonly Readonly<Record<string, unknown>>[],
  name: string,
  made: ReadonlyMap<string, string>,
  first: number,
): boolean {
  return schema.some((row) => {
    return (
      row['type'] === 'trigger' &&
      !made.has(String(row['name'])) &&
      lower(String(row['tbl_name'])) === lower(name) &&
      Number(row['rowid']) > first &&
      !logTrigger(row)
    );
  });
}

/**
 * Whether a trigger of the log's own table is in `schema`, which may drop its entries
 * (`RAISE(IGNORE)`): of one, no table is logged as the triggers write it.
 */
function logTriggered(schema: readonly Readonly<Record<string, unknown>>[]): boolean {
  return schema.some((row) => row['type'] === 'trigger' && lower(String(row['tbl_name'])) === LOG);
}

/**
 * The followed tables, by their declared names, whose triggers in `schema` — the rows of
 * `sqlite_schema` — are not each of those `captureSql()` makes, of the table, as it makes them, or
 * fire after a trigger of the application's.
 */
function untriggeredOf(
  schema: readonly Readonly<Record<string, unknown>>[],
  followed: FollowedInstall,
): ReadonlySet<string> {
  const held = new Map<string, Readonly<Record<string, unknown>>>();
  for (const row of schema) {
    if (row['type'] === 'trigger') held.set(String(row['name']), row);
  }
  if (logTriggered(schema)) return new Set(followed.byName.values());
  const untriggered = new Set<string>();
  for (const [name, table] of followed.byName) {
    const made = followed.triggers.get(table);
    if (made !== undefined && !triggered(schema, held, name, made)) untriggered.add(table);
  }
  return untriggered;
}

/**
 * Whether the table `name` holds in `schema` — of its triggers `held`, by their names — each of
 * the triggers `made` as `captureSql()` makes them, and fires none after a trigger of the
 * application's.
 */
function triggered(
  schema: readonly Readonly<Record<string, unknown>>[],
  held: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  name: string,
  made: ReadonlyMap<string, string>,
): boolean {
  let first = Infinity;
  for (const [trigger, sql] of made) {
    const row = held.get(trigger);
    if (row?.['sql'] !== sql || lower(String(row['tbl_name'])) !== lower(name)) return false;
    first = Math.min(first, Number(row['rowid']));
  }
  return !firedBefore(schema, name, made, first);
}

/** The parts of a trigger's statement before its time: `CREATE TRIGGER [IF NOT EXISTS]`, a name. */
const TRIGGER = {
  after: /^[\t\n\f\r ]+after[\t\n\f\r ]/u,
  dot: /^[\t\n\f\r ]*\.[\t\n\f\r ]*/u,
  head: /^[\t\n\f\r ]*create[\t\n\f\r ]+trigger[\t\n\f\r ]+(?:if[\t\n\f\r ]+not[\t\n\f\r ]+exists[\t\n\f\r ]+)?/u,
  plain: /^[a-z_\u{80}-\u{10FFFF}][\w$\u{80}-\u{10FFFF}]*/u,
  quoted: /^"(?:[^"]|"")*"/u,
} as const;

/** The length of the name `text` begins with, plain or quoted; none of no name. */
function nameLength(text: string): number | undefined {
  const [found] = TRIGGER.quoted.exec(text) ?? TRIGGER.plain.exec(text) ?? [];
  return found?.length;
}

/**
 * Whether a trigger's statement runs after its event: `CREATE TRIGGER [IF NOT EXISTS] <name> AFTER`,
 * of a name plain or quoted, of its schema's or not, as SQLite reads them — its spaces of ASCII, a
 * name's characters past ASCII too (`app after` of U+00A0 is one name), its keywords in ASCII's
 * case. Of any other text, a byte order mark's too, it may run before one.
 */
export function runsAfter(text: string): boolean {
  if (text.includes('\u{FEFF}')) return false;
  const sql = lower(text);
  const [head] = TRIGGER.head.exec(sql) ?? [];
  const first = head === undefined ? undefined : nameLength(sql.slice(head.length));
  if (head === undefined || first === undefined) return false;
  let rest = sql.slice(head.length + first);
  const [dot] = TRIGGER.dot.exec(rest) ?? [];
  if (dot !== undefined) {
    const second = nameLength(rest.slice(dot.length));
    if (second === undefined) return false;
    rest = rest.slice(dot.length + second);
  }
  return TRIGGER.after.test(rest);
}

/**
 * The followed tables, by their declared names, of a trigger of the application's in `schema` —
 * the rows of `sqlite_schema` — that may run before an update: any but one that runs after.
 */
function reloadedOf(
  schema: readonly Readonly<Record<string, unknown>>[],
  followed: FollowedInstall,
): ReadonlySet<string> {
  const ours = new Set<string>();
  for (const made of followed.triggers.values()) {
    for (const name of made.keys()) ours.add(name);
  }
  // SQLite keeps a trigger's table as its statement spells it: of any case.
  const byName = new Map(
    [...followed.byName].map(([name, table]) => [lower(name), table] as const),
  );
  const reloaded = new Set<string>();
  for (const row of schema) {
    const table = byName.get(lower(String(row['tbl_name'])));
    if (table === undefined || row['type'] !== 'trigger' || ours.has(String(row['name']))) continue;
    if (logTrigger(row)) continue;
    if (typeof row['sql'] !== 'string' || !runsAfter(row['sql'])) reloaded.add(table);
  }
  return reloaded;
}

/**
 * What the database holds of the followed tables that the triggers do not answer for, `schema`
 * being the rows of `sqlite_schema`: of every table, where D1 answers no `PRAGMA` of them.
 */
export async function installedOf(
  binding: D1Binding,
  followed: FollowedInstall,
  schema: readonly Readonly<Record<string, unknown>>[],
): Promise<Installed> {
  const untriggered = untriggeredOf(schema, followed);
  const reloaded = reloadedOf(schema, followed);
  try {
    const replacing = await replacingOf(binding, followed);
    return { reloaded, replacing, unanswered: false, untriggered };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `reactive-state: D1 answered no unique index of the followed tables, so each insert and update is of its table for a while: ${String(error)}`,
    );
    const replacing = new Set(followed.byName.values());
    return { reloaded, replacing, unanswered: true, untriggered };
  }
}
