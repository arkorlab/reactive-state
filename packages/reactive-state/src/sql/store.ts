import {
  type ExternalChange,
  type ExternalChanges,
  type ExternalStore,
  TAIL,
} from '../authority/external.ts';
import { logOf, relationKey } from './capture.ts';
import { queryCapture } from './compat.ts';
import { type Queryable, SchemaDigest } from './digest.ts';
import { type Followed, type KeyColumn } from './keys.ts';

/**
 * The store an authority follows the application's PostgreSQL tables by: the log its triggers
 * write (`capture.ts`), read a page at a time. An entry of a row holds the values of its table's
 * key columns, before the change or after it, as the table's key fields (`keys.ts`): what read rows
 * of those values is rendered again. An entry of no row — or of a row whose image lacks a key the
 * table declares now, which triggers made before it wrote — names the table alone: what read the
 * table is rendered again. Its records are read by the application's own SQL, whose plan says what
 * a render read (`client.ts`); `db.<table>` reads none of them.
 */

export type { Queryable } from './digest.ts';

/**
 * The id of every change of a row: none of the log's tables is read by its records' ids — a
 * render's conditions name the key columns' fields — so a commit of the log's rows names one
 * record of each table changed, not one of each entry (`Committer.commit`).
 */
const ROW = 'row';

/** A log number PostgreSQL answered — a `bigint` read as a number, a `BigInt` or text — as a number. */
function logNumber(value: unknown, what: string): number {
  const number = typeof value === 'string' || typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`The change log's ${what} is not a whole number.`);
  }
  return number;
}

/** The one row a page's statement answers. */
function rowOf(rows: readonly unknown[]): Readonly<Record<string, unknown>> {
  const [row] = rows;
  if (typeof row !== 'object' || row === null) {
    throw new Error(
      'The change log has no head: run the statements of `changeCaptureSql()` before following it.',
    );
  }
  return row as Readonly<Record<string, unknown>>;
}

/**
 * The key fields' values of a row an entry keeps, `image`, of a table whose keys are `keys`: each
 * key's text, or `null` where the row held none; nothing where the image is no object, or lacks a
 * key — a trigger made before the key was one.
 */
function valuesOf(
  image: unknown,
  keys: readonly KeyColumn[],
): Readonly<Record<string, string | null>> | undefined {
  if (typeof image !== 'object' || image === null || Array.isArray(image)) {
    return undefined;
  }
  const values: Record<string, string | null> = {};
  for (const key of keys) {
    const value: unknown = Object.hasOwn(image, key.column)
      ? Reflect.get(image, key.column)
      : undefined;
    if (value !== null && typeof value !== 'string') {
      return undefined;
    }
    values[key.field] = value;
  }
  return values;
}

/** One entry of the log as a change: of the row it keeps, before or after, or of the table alone. */
function changeOf(entry: unknown, followed: Followed): ExternalChange {
  const [seq, schema, name, side, image] = Array.isArray(entry) ? (entry as unknown[]) : [];
  if (typeof schema !== 'string' || typeof name !== 'string') {
    throw new TypeError('An entry of the change log names no table.');
  }
  const number = logNumber(seq, 'entry');
  const relation = relationKey({ name, schema });
  // A table no longer followed keeps its key, which names no table the authority follows.
  const table = followed.byRelation.get(relation) ?? relation;
  const keys = followed.keysByTable.get(table);
  const values = keys === undefined ? undefined : valuesOf(image, keys);
  if (values === undefined || (side !== 'before' && side !== 'after')) {
    return { id: '', seq: number, table };
  }
  return side === 'before'
    ? { after: null, before: values, id: ROW, seq: number, table }
    : { after: values, before: null, id: ROW, seq: number, table };
}

/** The entries of a page, as its statement aggregated them: `[seq, schema, table, side, image]`. */
function entriesOf(page: unknown, followed: Followed): readonly ExternalChange[] {
  const parsed: unknown = typeof page === 'string' ? JSON.parse(page) : page;
  if (!Array.isArray(parsed)) {
    throw new TypeError("The change log's page is not a list.");
  }
  return (parsed as unknown[]).map((entry) => changeOf(entry, followed));
}

/**
 * How many turns of the authority's reads a read of the log takes the tables of at most: past them,
 * reading their entries would hold the connection a render's queries wait on, on PGlite's one.
 */
const FOLD = { turns: 10 } as const;

/**
 * The page of the log after `$1`, `$2` entries at most, with its head, floor and epoch. Where the
 * head is more than `$3` entries past `$1` — more than a turn of the authority's reads reaches, a
 * row an entry — the page is of the tables those entries changed instead, an entry of no row of
 * each at its last, so that one turn reaches the head: what read the tables is rendered again, as
 * of a table's change. Of more than `$4` entries, or more tables than a page holds, the floor is
 * past the head: whatever read the store's tables is rendered again, as for changes let go of.
 */
function pageSql(namespace: string): string {
  const { changes, head, schema } = logOf(namespace);
  const far = `(SELECT "seq" FROM ${head}) - $1 > $3`;
  const farther = `(SELECT "seq" FROM ${head}) - $1 > $4`;
  const page = `SELECT "seq", "schema_name", "table_name", "side", "image" FROM ${changes} WHERE "seq" > $1 AND NOT ${far} ORDER BY "seq" LIMIT $2`;
  const folded = `SELECT max("seq") AS "seq", "schema_name", "table_name" FROM ${changes} WHERE "seq" > $1 AND ${far} AND NOT ${farther} GROUP BY "schema_name", "table_name"`;
  const overflows = `(${farther} OR (SELECT count(*) FROM "folded") > $2)`;
  const floor = `CASE WHEN ${overflows} THEN h."seq" + 1 ELSE coalesce((SELECT min("seq") FROM ${changes}), CASE WHEN h."seq" = 0 THEN 0 ELSE h."seq" + 1 END) END`;
  const rows = `(SELECT json_agg(json_build_array(p."seq", p."schema_name", p."table_name", p."side", p."image") ORDER BY p."seq") FROM "page" AS p)`;
  const tables = `(SELECT json_agg(json_build_array(f."seq", f."schema_name", f."table_name") ORDER BY f."seq") FROM "folded" AS f WHERE NOT ${overflows})`;
  return `WITH "page" AS (${page}), "folded" AS (${folded}) SELECT h."epoch", ${schema}."ddl_count"() AS "ddl", h."seq" AS "head", ${floor} AS "floor", coalesce(${rows}, ${tables}, '[]'::json) AS "page" FROM ${head} AS h`;
}

/** What `db.<table>` is answered for a table read by SQL: a fault, which names the way to read it. */
function readBySql(table: string): Promise<never> {
  return Promise.reject(
    new Error(
      `${table} is read by SQL: query it with the application's Drizzle, whose plan says what a render read, not through \`db.${table}\`.`,
    ),
  );
}

/**
 * The store of the tables `followed` names, whose log `client` reads in its namespace. Its epoch is
 * the log's and the schema's digest (`digest.ts`): a log read under another schema is another one,
 * which renders again whatever read its tables, and a plan asked before is asked again.
 */
export function sqlStore(client: Queryable, followed: Followed): ExternalStore {
  const statement = pageSql(followed.namespace);
  const schema = new SchemaDigest(client, followed.relations);
  let counted: string | undefined;
  return {
    changes: async (since, limit): Promise<ExternalChanges> => {
      const far = limit * TAIL.pagesAtOnce;
      const row = rowOf(
        (
          await queryCapture(
            client,
            statement,
            [since, limit, far, far * FOLD.turns],
            followed.namespace,
          )
        ).rows,
      );
      const epoch = row['epoch'];
      if (typeof epoch !== 'string') {
        throw new TypeError("The change log's epoch is not text.");
      }
      // How many changes of the schema the event trigger counted that have committed (`capture.ts`):
      // one made and made back between two reads of the digest too. Once it moved, the digest is
      // read anew, of what the counted change made: a temporary object `DISCARD` takes away
      // uncounted is then another digest's.
      const ddl = String(row['ddl']);
      const moved = counted !== undefined && counted !== ddl;
      const { changed, digest } = await schema.read(moved);
      if (changed || moved) {
        followed.schema.generation += 1;
      }
      counted = ddl;
      return {
        changes: entriesOf(row['page'], followed),
        epoch: `${epoch}:${ddl}:${digest}`,
        floor: logNumber(row['floor'], 'floor'),
        head: logNumber(row['head'], 'head'),
      };
    },
    count: (table) => readBySql(table.name),
    find: (table) => readBySql(table.name),
    get: (table) => readBySql(table.name),
  };
}

/**
 * Discards the log's entries written before `before`, a time in milliseconds: every entry up to the
 * last of those, so that what is kept follows on from the head. A follower behind them renders
 * again whatever read the tables, as it does for a log begun anew. The schema's changes counted
 * before it are folded into one row of their sum, so the count the store reads goes on as it was.
 */
export async function pruneSqlChanges(
  client: Queryable,
  before: number,
  namespace: string,
): Promise<void> {
  const { changes, schema } = logOf(namespace);
  await client.query(
    `DELETE FROM ${changes} WHERE "seq" <= (SELECT max("seq") FROM ${changes} WHERE "at" < to_timestamp($1::double precision / 1000))`,
    [before],
  );
  await queryCapture(
    client,
    `SELECT ${schema}."fold_ddl"($1::double precision)`,
    [before],
    namespace,
  );
}
