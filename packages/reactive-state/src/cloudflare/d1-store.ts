import type {
  ExternalChanges,
  ExternalQuery,
  ExternalRecord,
  ExternalStore,
  ExternalTable,
} from '../authority/external.ts';
import type { Where } from '../authority/query.ts';
import type { Value } from '../program.ts';
import { type AnyDatabase, definitionOf, type FieldDefinition } from '../server/schema.ts';

/**
 * An application's own D1 database as a store its external tables are read through (`d1Store`), and
 * the change log its triggers keep of what any of the application's code writes there
 * (`changeCaptureSql`): each write of a table the declaration reads lands a row in `_rs_changes` in
 * the statement that made it, so that no writer of the application's has to remember to, and the
 * authority follows the log rather than mirror the data. D1 keeps no log of changes of its own.
 *
 * What the store asks D1 is what the authority asks of a record: each field `where` names equal to
 * its value — a field's default met by a NULL too, as the authority reads a NULL as the default —
 * in the order asked, text by its code points as SQLite's `BINARY` orders it, the last tie by id.
 * The application's non-NULL scalar columns must satisfy the declaration; NULL takes a field's
 * default. IDs are SQLite's text form, including INTEGER ids, compared exactly and ordered as text.
 * The executor reads the primary, or a replica at least as recent as its change-log read.
 */

/** How the store reaches D1: a statement and its parameters, answered by its rows. */
export interface D1Executor {
  readonly all: (
    sql: string,
    params: readonly unknown[],
  ) => Promise<readonly Readonly<Record<string, unknown>>[]>;
}

/** Where a declared table's records are in D1: its table, its id's column, each field's column. */
export interface D1Table {
  /** The SQL table: the declared table's own name unless given. */
  readonly name?: string | undefined;
  /** The column of the record's id: `id` unless given. */
  readonly id?: string | undefined;
  /** Each declared field's column, by the field's name: the field's own name unless given. */
  readonly columns?: Readonly<Record<string, string>> | undefined;
}

/** Where each declared table is in D1, by its declared name: as declared where none is given. */
export type D1Tables = Readonly<Record<string, D1Table>>;

/** The D1 binding's own, as much of it as is read: a statement prepared, bound, and answered. */
interface D1Like {
  readonly prepare: (sql: string) => {
    readonly bind: (...params: unknown[]) => {
      readonly all: () => Promise<{ readonly results: readonly Record<string, unknown>[] }>;
    };
  };
}

/** A D1 binding (`env.DB`) as the store's executor. */
export function d1Executor(database: D1Like): D1Executor {
  return {
    all: async (sql, params) => {
      return (
        await database
          .prepare(sql)
          .bind(...params)
          .all()
      ).results;
    },
  };
}

/** The log the triggers write, and the table its epoch is kept in. */
const LOG = '_rs_changes';
const META = '_rs_meta';
/** The longest record id the authority names (`isRecordId`). */
const RECORD_ID_LENGTH = 64;

/** D1's statement parameters and JSON function arguments, as its platform limits allow. */
const D1_LIMITS = { fieldsPerObject: 16, parameters: 100 } as const;
/** The milliseconds since the epoch, as SQLite tells them of its clock. */
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const UTF8 = new TextEncoder();
const HEX_RADIX = 16;

/** An SQL identifier, quoted: any name, its quotes doubled. */
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** UTF-8 bytes as ASCII hex, preserving case-sensitive names and every accepted text value. */
function hex(text: string): string {
  return Array.from(UTF8.encode(text), (byte) => byte.toString(HEX_RADIX).padStart(2, '0')).join(
    '',
  );
}

/** An SQL text literal: quotes doubled, and a NUL kept out of the statement's own text. */
function literal(text: string): string {
  return text.includes('\0') ? `CAST(X'${hex(text)}' AS TEXT)` : `'${text.replaceAll("'", "''")}'`;
}

/** Where `table` is in D1, with its id's column and each field's. */
function placed(table: ExternalTable, tables: D1Tables) {
  const spec = Object.hasOwn(tables, table.name) ? tables[table.name] : undefined;
  const column = (field: string): string => {
    if (field === 'id') {
      return spec?.id ?? 'id';
    }
    return spec?.columns !== undefined && Object.hasOwn(spec.columns, field)
      ? (spec.columns[field] ?? field)
      : field;
  };
  return { column, name: spec?.name ?? table.name };
}

/** An id as the store exposes it, before D1 can round an INTEGER to a JavaScript number. */
function idSql(column: (field: string) => string): string {
  return `CAST(${quoted(column('id'))} AS TEXT)`;
}

/** A value as SQL holds what the authority holds: a boolean as 0 or 1. */
function sqlValue(value: Value): Value {
  return typeof value === 'boolean' ? Number(value) : value;
}

/** What a column holds, as the field reads it: 0 and 1 of a boolean, the JSON text of a document. */
function fieldValue(definition: FieldDefinition, held: unknown): unknown {
  let value = held;
  if (definition.type === 'boolean' && (held === 0 || held === 1)) {
    value = held === 1;
  } else if (typeof held === 'string' && definition.type === 'json') {
    try {
      value = JSON.parse(held) as unknown;
    } catch {
      throw new TypeError('A D1 document is not valid JSON.');
    }
  }
  return value;
}

/** The columns a record is read by: its id, then each field's, named by the field. */
function selected(table: ExternalTable, column: (field: string) => string): string {
  return [
    `${idSql(column)} AS ${quoted('id')}`,
    ...Object.keys(table.table.fields).map((field) => {
      const alias = quoted(`f_${field}`);
      return `${quoted(column(field))} AS ${alias}`;
    }),
  ].join(', ');
}

/** A row as the record it is. */
function recordOf(
  table: ExternalTable,
  row: Readonly<Record<string, unknown>>,
): ExternalRecord | undefined {
  // The id as SQL wrote it as text; a row of none — a nullable key column's NULL — is no record,
  // where `String(null)` would name one `null`.
  const id: unknown = row['id'];
  if (typeof id !== 'string') {
    return undefined;
  }
  const values: Record<string, unknown> = {};
  for (const [field, definition] of Object.entries(table.table.fields)) {
    values[field] = fieldValue(definition, row[`f_${field}`]);
  }
  return { id, values };
}

/**
 * All predicates in balanced layers: a left-deep AND can exceed D1's expression-depth limit
 * before it reaches the supported binding count, particularly with each default's NULL branch.
 */
function allOf(terms: readonly string[]): string {
  let layer = [...terms];
  while (layer.length > 1) {
    const next: string[] = [];
    for (let at = 0; at < layer.length; at += 2) {
      next.push(`(${layer.slice(at, at + 2).join(' AND ')})`);
    }
    layer = next;
  }
  return layer[0] ?? '1';
}

/**
 * The condition of `where`, and its parameters: each field equal to its value, and a NULL taken for
 * a value that is the field's default, as the authority reads a NULL.
 */
function conditionOf(
  table: ExternalTable,
  column: (field: string) => string,
  where: Where,
): { readonly sql: string; readonly params: readonly unknown[] } {
  // A row whose key no record id can be — a nullable key column's NULL, or text the authority's
  // ids (`isRecordId`: 1 to 64 of A-Z, a-z, 0-9, `_` and `-`) never are — is no record: none is
  // counted, found, or let take a place of a query's limit before the records after it. SQLite's
  // `length` and `GLOB` read text to its first NUL alone, which `instr` does not: a key with one
  // inside is refused by that first.
  const id = idSql(column);
  const terms: string[] = [
    `${quoted(column('id'))} IS NOT NULL`,
    `instr(${id}, char(0)) = 0`,
    `length(${id}) BETWEEN 1 AND ${String(RECORD_ID_LENGTH)}`,
    `${id} NOT GLOB '*[^0-9A-Za-z_-]*'`,
  ];
  const params: unknown[] = [];
  for (const [field, value] of Object.entries(where)) {
    params.push(sqlValue(value));
    const parameter = `?${String(params.length)}`;
    if (field === 'id') {
      // The physical equality uses its primary-key index; the guard rejects aliases like 02 or a.
      terms.push(
        `(${quoted(column('id'))} = ${parameter} AND ${idSql(column)} COLLATE BINARY = ${parameter})`,
      );
      continue;
    }
    const name = `${quoted(column(field))} COLLATE BINARY`;
    const definition = table.table.fields[field];
    terms.push(
      definition?.default === value
        ? `(${name} = ${parameter} OR ${name} IS NULL)`
        : `${name} = ${parameter}`,
    );
  }
  if (params.length > D1_LIMITS.parameters) {
    throw new RangeError('A D1 query has more than 100 conditions.');
  }
  return { params, sql: allOf(terms) };
}

/** A field's scalar default in SQL, checked by the declaration before reaching the store. */
function defaultSql(definition: FieldDefinition): string {
  const value = definition.default;
  return typeof value === 'string' ? literal(value) : String(sqlValue(value ?? false));
}

/** The order of a query: each key's NULLs as its field's default, then the id, always BINARY. */
function orderOf(
  table: ExternalTable,
  column: (field: string) => string,
  query: ExternalQuery,
): string {
  const terms: string[] = [];
  for (const { descending, field } of query.orderBy) {
    const direction = descending ? 'DESC' : 'ASC';
    if (field === 'id') {
      terms.push(`${idSql(column)} COLLATE BINARY ${direction}`);
      continue;
    }
    const definition = table.table.fields[field];
    if (definition === undefined || definition.type === 'json') {
      terms.push(`${quoted(column(field))} COLLATE BINARY ${direction}`);
    } else {
      terms.push(
        `COALESCE(${quoted(column(field))}, ${defaultSql(definition)}) COLLATE BINARY ${direction}`,
      );
    }
  }
  terms.push(`${idSql(column)} COLLATE BINARY ASC`);
  return terms.join(', ');
}

/** One row of a page of the log: a change, beside the log's head, floor and epoch. */
function changesOf(rows: readonly Readonly<Record<string, unknown>>[]): ExternalChanges {
  const first = rows[0];
  const epoch = first?.['epoch'];
  if (typeof epoch !== 'string' || epoch.length === 0) {
    throw new TypeError('The D1 change log has no epoch: apply its change-capture migration.');
  }
  const floor = Number(first?.['floor'] ?? 0);
  const head = Number(first?.['head'] ?? 0);
  wholeNumber(floor, 'log floor', true);
  wholeNumber(head, 'log head', true);
  const changes = rows.flatMap((row) => {
    if (row['seq'] === null || row['seq'] === undefined) {
      return [];
    }
    const seq = Number(row['seq']);
    wholeNumber(seq, 'change sequence');
    const before = imageOf(row['before']);
    const after = imageOf(row['after']);
    // Both NULLs name a key-only change, not a record that existed neither before nor after it.
    const omitted = before === null && after === null;
    return [
      {
        after: omitted ? undefined : after,
        before: omitted ? undefined : before,
        id: String(row['id']),
        seq,
        table: String(row['tbl']),
      },
    ];
  });
  return {
    changes,
    epoch,
    floor,
    head,
  };
}

/**
 * A record's fields as a change kept them: the JSON object a trigger wrote, `null` where there was
 * no record, and nothing known where the change kept none — a trigger of the application's own that
 * names the record alone.
 */
function imageOf(held: unknown): Readonly<Record<string, unknown>> | null | undefined {
  if (held === null) {
    return null;
  }
  if (typeof held !== 'string') {
    return undefined;
  }
  try {
    const image: unknown = JSON.parse(held);
    return typeof image === 'object' && !Array.isArray(image)
      ? (image as Readonly<Record<string, unknown>> | null)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The application's own D1 database, through `executor`, as the store its external tables are read
 * through: each table where `tables` says it is in D1, else by its declared name and its fields'.
 */
export function d1Store(executor: D1Executor, tables: D1Tables = {}): ExternalStore {
  return {
    changes: async (since, limit) => {
      wholeNumber(since, 'cursor', true);
      wholeNumber(limit, 'page size');
      const rows = await executor.all(
        `WITH h AS (SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = '${LOG}'), 0) AS head), m AS (SELECT head, coalesce((SELECT min(seq) FROM ${LOG}), CASE WHEN head = 0 THEN 0 ELSE head + 1 END) AS floor, (SELECT value FROM ${META} WHERE key = 'epoch') AS epoch FROM h) SELECT c.seq, c.tbl, c.id, c.before, c.after, m.head, m.floor, m.epoch FROM m LEFT JOIN (SELECT seq, tbl, id, before, after FROM ${LOG} WHERE seq > ? ORDER BY seq LIMIT ?) AS c ON 1 ORDER BY c.seq`,
        [since, limit],
      );
      return changesOf(rows);
    },
    count: async (table, where) => {
      const { column, name } = placed(table, tables);
      const condition = conditionOf(table, column, where);
      const rows = await executor.all(
        `SELECT count(*) AS counted FROM ${quoted(name)} WHERE ${condition.sql}`,
        condition.params,
      );
      return Number(rows[0]?.['counted'] ?? 0);
    },
    find: async (table, query) => {
      const { column, name } = placed(table, tables);
      const condition = conditionOf(table, column, query.where);
      const order = orderOf(table, column, query);
      if (query.limit !== undefined) {
        wholeNumber(query.limit, 'query limit');
      }
      const limit = query.limit === undefined ? '' : ` LIMIT ${String(query.limit)}`;
      const rows = await executor.all(
        `SELECT ${selected(table, column)} FROM ${quoted(name)} WHERE ${condition.sql} ORDER BY ${order}${limit}`,
        condition.params,
      );
      return rows.flatMap((row) => {
        const record = recordOf(table, row);
        return record === undefined ? [] : [record];
      });
    },
    get: async (table, id) => {
      const { column, name } = placed(table, tables);
      const condition = conditionOf(table, column, { id });
      const rows = await executor.all(
        `SELECT ${selected(table, column)} FROM ${quoted(name)} WHERE ${condition.sql} LIMIT 1`,
        condition.params,
      );
      const row = rows[0];
      return (row === undefined ? undefined : recordOf(table, row)) ?? null;
    },
  };
}

/** A cursor or count the query may embed or bind: a safe whole number, zero where allowed. */
function wholeNumber(value: number, what: string, zero = false): void {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) {
    throw new RangeError(`A D1 ${what} is a ${zero ? 'non-negative' : 'positive'} safe integer.`);
  }
}

/**
 * What a trigger writes of a record's field into a change's image: a boolean as JSON's, each other
 * field the authority compares as SQLite holds it. A document is no query's, and is left out.
 */
function imageField(definition: FieldDefinition, row: 'NEW' | 'OLD', column: string): string {
  const held = `${row}.${quoted(column)}`;
  return definition.type === 'boolean'
    ? `CASE WHEN ${held} IS NULL THEN NULL WHEN ${held} THEN json('true') ELSE json('false') END`
    : held;
}

/** The JSON object of a record's fields a trigger writes as a change's image. */
function imageSql(
  fields: readonly (readonly [string, FieldDefinition])[],
  column: (field: string) => string,
  row: 'NEW' | 'OLD',
): string {
  const comparable = fields.filter(([, definition]) => definition.type !== 'json');
  let image = 'json_object()';
  for (let at = 0; at < comparable.length; at += D1_LIMITS.fieldsPerObject) {
    const pairs = comparable
      .slice(at, at + D1_LIMITS.fieldsPerObject)
      .flatMap(([field, definition]) => {
        const value = imageField(definition, row, column(field));
        return [literal(field), value];
      });
    const next = `json_object(${pairs.join(', ')})`;
    // Only scalar fields are captured, so its only trailing brace closes the object itself.
    image = at === 0 ? next : `(rtrim(${image}, '}') || ',' || substr(${next}, 2))`;
  }
  return image;
}

/**
 * The statements that make `database`'s change log in D1 for the tables read through the store
 * `store`, where `tables` says they are: the log and its epoch, which a database made again begins
 * anew, and a trigger of each write that lands one row in its own statement. A delete keeps its
 * record's id and before image. Inserts and updates invalidate the whole declared table: REPLACE
 * can silently delete another record under a physical UNIQUE constraint the declaration does not
 * know, including an update of a column the declaration never reads. With recursive triggers off,
 * SQLite runs no delete trigger for those records. A blank id is the follower's unknown-table
 * marker, so every dependency of this table is reread without a setting required of each writer.
 * No-op updates also signal conservatively. The log is kept and the triggers replaced, so a later
 * declaration captures its new fields. Trigger names encode the declaration's case-sensitive name;
 * the legacy unencoded names are removed too, so reinstalling never keeps two captures of a write.
 *
 * A migration that makes one of these tables again drops its triggers with it: run these after,
 * together in the migration's transaction or one D1 batch.
 */
export function changeCaptureSql(
  database: AnyDatabase,
  store: string,
  tables: D1Tables = {},
): readonly string[] {
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
    `DELETE FROM ${META} WHERE key = 'epoch' AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${LOG}')`,
    `CREATE TABLE IF NOT EXISTS ${LOG} (seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, tbl TEXT NOT NULL, id TEXT NOT NULL, before TEXT, after TEXT, at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS _rs_changes_at ON ${LOG} (at)`,
    `INSERT OR IGNORE INTO ${META} (key, value) VALUES ('epoch', lower(hex(randomblob(16))))`,
  ];
  for (const [declared, table] of definitionOf(database).tables) {
    if (table.external !== store) {
      continue;
    }
    const { column, name } = placed({ name: declared, table }, tables);
    const fields = Object.entries(table.fields);
    const id = quoted(column('id'));
    const on = quoted(name);
    const stem = `_rs2_${hex(declared)}`;
    const trigger = (event: string): string => quoted(`${stem}_${event}`);
    const legacy = (event: string): string => quoted(`_rs_${declared}_${event}`);
    const insert = (idOf: string, before: string, after: string): string =>
      `INSERT INTO ${LOG} (tbl, id, before, after, at) VALUES (${literal(declared)}, ${idOf}, ${before}, ${after}, ${NOW_MS})`;
    const oldId = `OLD.${id}`;
    const before = imageSql(fields, column, 'OLD');
    const after = imageSql(fields, column, 'NEW');
    const inserted = insert("''", 'NULL', after);
    const updated = insert("''", before, after);
    const removed = insert(oldId, before, 'NULL');
    statements.push(
      ...['insert', 'update', 'delete'].flatMap((event) => {
        return [
          `DROP TRIGGER IF EXISTS ${legacy(event)}`,
          `DROP TRIGGER IF EXISTS ${trigger(event)}`,
        ];
      }),
      `CREATE TRIGGER IF NOT EXISTS ${trigger('insert')} AFTER INSERT ON ${on} BEGIN ${inserted}; END`,
      `CREATE TRIGGER IF NOT EXISTS ${trigger('update')} AFTER UPDATE ON ${on} BEGIN ${updated}; END`,
      // A row of no id was no record: its delete logs nothing, where its NULL would refuse the
      // log's row, and with it the application's own delete.
      `CREATE TRIGGER IF NOT EXISTS ${trigger('delete')} AFTER DELETE ON ${on} WHEN ${oldId} IS NOT NULL BEGIN ${removed}; END`,
    );
  }
  return statements;
}

/**
 * Lets go of the changes of the log older than `before` (epoch milliseconds), for the application's
 * own schedule to run: those before the first change at or after it, by their order in the log —
 * every one, where none is that new. A change the database's clock stamped earlier than one before
 * it is kept with it, never let go of from between two kept ones: a follower would read past the
 * gap, its floor where it was. SQLite's sequence keeps the head even when no row remains. A
 * follower behind what was let go of renders again whatever read the store's tables.
 */
export async function pruneChanges(executor: D1Executor, before: number): Promise<void> {
  wholeNumber(before, 'pruning cutoff', true);
  await executor.all(
    `DELETE FROM ${LOG} WHERE seq < coalesce((SELECT min(seq) FROM ${LOG} WHERE at >= ?), (SELECT max(seq) FROM ${LOG}) + 1)`,
    [before],
  );
}
