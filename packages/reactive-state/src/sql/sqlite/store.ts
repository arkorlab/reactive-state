import {
  type ExternalChange,
  type ExternalChanges,
  type ExternalStore,
  TAIL,
} from '../../authority/external.ts';
import type { D1Binding } from './client.ts';
import { type FollowedInstall, type Installed, installedOf } from './installed.ts';
import type { SqliteKeyColumn } from './keys.ts';

/**
 * The store an authority follows a Drizzle schema's tables in D1 by: the log their triggers write
 * (`capture.ts`), read a page at a time. An entry of a row holds the text of its table's keys,
 * before the change or after it, as the table's key fields: what read rows of those values is
 * rendered again. An entry of no row — or of a row whose image lacks a key the table declares now,
 * which triggers made before it wrote, or of an insert or an update of a table of a unique index
 * whose rows the triggers do not log as met, which a `REPLACE` may delete other rows by, unlogged —
 * names the table alone (`installed.ts`). Its epoch is the log's and a digest of the schema
 * (`sqlite_schema`), read once in ten seconds at most: a log read under another schema is another
 * one, which renders again whatever read its tables, and a plan asked before is asked again. While a
 * table's triggers are not those `captureSql()` makes, the schema is read once a second, and each
 * read of it is of another epoch: whatever read the store's tables renders again each time. Its
 * records are read by the application's own SQL, whose plan says what a render read (`client.ts`);
 * `db.<table>` reads none of them.
 */

/**
 * What the store reads the log of: each followed table's keys, what the database is held to, and
 * the schema's generation, shared with the client's plans, and the digest it is of.
 */
export interface FollowedSqliteStore extends FollowedInstall {
  readonly keysByTable: ReadonlyMap<string, readonly SqliteKeyColumn[]>;
  readonly schema: { generation: number; digest?: string | undefined };
}

const LOG = '_rs_changes';
const META = '_rs_meta';
/** The id of an entry of a row: none of the log's tables is read by its records' ids. */
const ROW = 'row';
/**
 * How often the schema is read at most: while each followed table's triggers are those
 * `captureSql()` makes, and while one's are others, of which each read is another epoch; and after
 * how long a `PRAGMA` D1 answered not is asked again. D1 counts a read of the schema as rows read of
 * each row it holds, however few it answers.
 */
const SCHEMA = { settledMs: 10_000, unsettledMs: 1000, retryMs: 60_000 } as const;
/** Of how many turns' entries a read folds. */
const FOLD = { turns: 10 } as const;
const HEX_RADIX = 16;

/**
 * The page of the log after `?1`, `?2` entries at most, with its head, floor and epoch. Where the
 * head is more than `?3` entries past `?1` — more than a turn of the authority's reads reaches —
 * the page is of the tables those entries changed instead, an entry of no row of each at its last;
 * of more than `?4` entries, or more tables than a page holds, the floor is past the head.
 */
const PAGE_SQL = `WITH h AS (SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = '${LOG}'), 0) AS head), f AS (SELECT (SELECT head FROM h) - ?1 > ?3 AS far, (SELECT head FROM h) - ?1 > ?4 AS farther), r AS (SELECT seq, tbl, id, before, after FROM ${LOG} WHERE seq > ?1 AND NOT (SELECT far FROM f) ORDER BY seq LIMIT ?2), d AS (SELECT max(seq) AS seq, tbl, '' AS id, NULL AS before, NULL AS after FROM ${LOG} WHERE seq > ?1 AND (SELECT far FROM f) AND NOT (SELECT farther FROM f) GROUP BY tbl), o AS (SELECT (SELECT farther FROM f) OR (SELECT count(*) FROM d) > ?2 AS over), m AS (SELECT head, CASE WHEN (SELECT over FROM o) THEN head + 1 ELSE coalesce((SELECT min(seq) FROM ${LOG}), CASE WHEN head = 0 THEN 0 ELSE head + 1 END) END AS floor, (SELECT value FROM ${META} WHERE key = 'epoch') AS epoch FROM h), c AS (SELECT * FROM r UNION ALL SELECT * FROM d WHERE NOT (SELECT over FROM o)) SELECT c.seq, c.tbl, c.id, c.before, c.after, m.head, m.floor, m.epoch FROM m LEFT JOIN c ON 1 ORDER BY c.seq`;
/**
 * The schema, whose digest the epoch holds, and whose indexes say which tables are unique: the whole
 * of it, as a plan of the followed tables may stand on a table nothing follows — SQLite leaves out
 * a left join of a table its unique key matches one row of, whose columns nothing else reads.
 */
const SCHEMA_SQL = 'SELECT rowid, type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name';

/** A log number SQLite answered, as a safe whole number. */
function logNumber(value: unknown, what: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`The D1 change log's ${what} is not a whole number.`);
  }
  return number;
}

/** The rows of a batch's result. */
function rowsOf(result: unknown): readonly Readonly<Record<string, unknown>>[] {
  const rows: unknown =
    typeof result === 'object' && result !== null ? Reflect.get(result, 'results') : undefined;
  return Array.isArray(rows) ? (rows as Readonly<Record<string, unknown>>[]) : [];
}

/**
 * The key fields' text of a row an entry keeps, `held`: `null` where there was no row; nothing
 * where it is no object of every key's text or `null` — a trigger made before a key was one.
 */
function imageOf(
  held: unknown,
  keys: readonly SqliteKeyColumn[],
): Readonly<Record<string, string | null>> | null | undefined {
  if (held === null) return null;
  if (typeof held !== 'string') return undefined;
  let image: unknown;
  try {
    image = JSON.parse(held);
  } catch {
    return undefined;
  }
  if (typeof image !== 'object' || image === null || Array.isArray(image)) return undefined;
  const values: Record<string, string | null> = {};
  for (const key of keys) {
    const value: unknown = Object.hasOwn(image, key.field)
      ? Reflect.get(image, key.field)
      : undefined;
    if (value !== null && typeof value !== 'string') return undefined;
    values[key.field] = value;
  }
  return values;
}

/** One entry of the log as a change: of the row it keeps, before or after, or of the table alone. */
function changeOf(
  row: Readonly<Record<string, unknown>>,
  followed: FollowedSqliteStore,
  installed: Installed,
): ExternalChange {
  const seq = logNumber(row['seq'], 'entry');
  const table = String(row['tbl']);
  const keys = followed.keysByTable.get(table);
  const whole = { id: '', seq, table };
  if (keys === undefined || row['id'] !== ROW) return whole;
  // An insert or an update of a table a `REPLACE` may delete other rows of, by a unique index the
  // triggers read not, or an update of one SQLite reads again after an application's trigger
  // before it: of the table alone.
  const update = row['before'] !== null && row['after'] !== null;
  if (installed.replacing.has(table) && row['after'] !== null) return whole;
  if (update && installed.reloaded.has(table)) return whole;
  const before = imageOf(row['before'], keys);
  const after = imageOf(row['after'], keys);
  return before === undefined || after === undefined
    ? whole
    : { after, before, id: ROW, seq, table };
}

/** The SHA-256 of `text`, in hex. */
async function digestOf(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(HEX_RADIX).padStart(2, '0'),
  ).join('');
}

/** What `db.<table>` is answered for a table read by SQL: a fault, which names the way to read it. */
function readBySql(table: string): Promise<never> {
  return Promise.reject(
    new Error(
      `${table} is read by SQL: query it with the application's Drizzle, whose plan says what a render read, not through \`db.${table}\`.`,
    ),
  );
}

/** The warning of tables whose triggers are not those `captureSql()` makes, where there are any. */
function warnUntriggered(untriggered: ReadonlySet<string>): void {
  if (untriggered.size === 0) return;
  // eslint-disable-next-line no-console
  console.warn(
    `reactive-state: the triggers of ${[...untriggered].join(', ')} are not those \`captureSql()\` makes: run it after each migration. Until then, whatever read the store's tables renders again at each read of the log.`,
  );
}

/** The store of the tables `followed` names, whose log `binding` reads. */
export function sqliteStore(binding: D1Binding, followed: FollowedSqliteStore): ExternalStore {
  let schema: { readonly digest: string; readonly at: number } | undefined;
  let installed: Installed = {
    reloaded: new Set(),
    replacing: new Set(),
    unanswered: false,
    untriggered: new Set(),
  };
  let installedAt = 0;
  // How many reads of the log were of a table whose triggers are not `captureSql()`'s.
  let untriggeredReads = 0;
  const prepare = (sql: string) =>
    binding.prepare(sql) as { bind: (...values: unknown[]) => unknown };
  // The schema's rows as a page of the log read them: its digest, and what the database holds of
  // the tables, read again once the digest changes, or a while after D1 answered none of it.
  const schemaRead = async (read: readonly Readonly<Record<string, unknown>>[]): Promise<void> => {
    const digest = await digestOf(JSON.stringify(read));
    const retried = installed.unanswered && Date.now() - installedAt >= SCHEMA.retryMs;
    const changed = digest !== schema?.digest;
    if (retried || changed) {
      // The plans the client keeps are of the schema another store of the follow read last.
      if (digest !== followed.schema.digest) {
        followed.schema.generation += 1;
        followed.schema.digest = digest;
      }
      installed = await installedOf(binding, followed, read);
      installedAt = Date.now();
      if (changed) warnUntriggered(installed.untriggered);
    }
    schema = { at: Date.now(), digest };
  };
  return {
    changes: async (since, limit): Promise<ExternalChanges> => {
      const far = limit * TAIL.pagesAtOnce;
      const page = prepare(PAGE_SQL).bind(since, limit, far, far * FOLD.turns);
      const every = installed.untriggered.size > 0 ? SCHEMA.unsettledMs : SCHEMA.settledMs;
      const stale = schema === undefined || Date.now() - schema.at >= every;
      const answers = await binding.batch(stale ? [page, prepare(SCHEMA_SQL)] : [page]);
      if (stale) await schemaRead(rowsOf(answers[1]));
      const rows = rowsOf(answers[0]);
      const first = rows[0];
      const epoch = first?.['epoch'];
      if (typeof epoch !== 'string' || epoch.length === 0) {
        throw new TypeError(
          'The D1 change log has no epoch: run the statements of `captureSql()`.',
        );
      }
      // Another epoch once a read of the schema finds triggers other than `captureSql()`'s: once a
      // second at most, as the schema is read then, not at each read of the log.
      if (stale && installed.untriggered.size > 0) untriggeredReads += 1;
      const untriggered = installed.untriggered.size > 0 ? `:u${String(untriggeredReads)}` : '';
      const changes = rows.flatMap((row) => {
        return row['seq'] === null || row['seq'] === undefined
          ? []
          : [changeOf(row, followed, installed)];
      });
      return {
        changes,
        epoch: `${epoch}:${schema?.digest ?? ''}${untriggered}`,
        floor: logNumber(first?.['floor'] ?? 0, 'floor'),
        head: logNumber(first?.['head'] ?? 0, 'head'),
      };
    },
    count: (table) => readBySql(table.name),
    find: (table) => readBySql(table.name),
    get: (table) => readBySql(table.name),
  };
}
