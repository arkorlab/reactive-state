import { logOf } from './capture.ts';
import type { Queryable } from './digest.ts';

/** The first PostgreSQL that plans a statement of parameters, as each render's reads are read by. */
const PLANS_SINCE = 160_000;
/** What `server_version_num` holds of each major version. */
const A_MAJOR_VERSION = 10_000;

/** The log's functions the store calls by name, which a log of before may lack. */
const CAPTURE_FUNCTIONS = ['catch_up', 'ddl_count', 'fold_ddl', 'next_number', 'prune'] as const;

/**
 * A log made by an earlier capture version, identified by PostgreSQL's error code and position in
 * the store's own statement: the row-image columns, the head's prune, or a helper of the store's
 * are missing. An error inside a function, or anywhere else, keeps its original meaning.
 */
function missingCapture(error: unknown, sql: string, namespace: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (Reflect.get(error, 'internalQuery') !== undefined) return false;
  const position = Number(Reflect.get(error, 'position'));
  if (!Number.isSafeInteger(position) || position < 1 || position > sql.length) return false;
  const at = sql.slice(position - 1);
  const code: unknown = Reflect.get(error, 'code');
  if (code === '42703') {
    return at.startsWith('"side"') || at.startsWith('"image"') || at.startsWith('h."pruned"');
  }
  if (code === '42883') {
    const { schema } = logOf(namespace);
    return CAPTURE_FUNCTIONS.some((name) => at.startsWith(`${schema}."${name}"(`));
  }
  return false;
}

/** A store's own log statement, with an actionable diagnostic for an older capture schema alone. */
export async function queryCapture(
  client: Queryable,
  sql: string,
  values: unknown[],
  namespace: string,
): ReturnType<Queryable['query']> {
  try {
    return await client.query(sql, values);
  } catch (error) {
    if (!missingCapture(error, sql, namespace)) throw error;
    throw new Error(
      `The reactive-state change log in \`${namespace}\` needs its capture statements again: run every statement returned by \`follow.captureSql()\` after upgrading, before starting the store or pruning the log.`,
      { cause: error },
    );
  }
}

/**
 * Refuses a server no render could run on, as `EXPLAIN (GENERIC_PLAN)` is of 16: PostgreSQL's answer
 * reaches a render as a refusal of the application's own query, which says nothing of the server.
 */
export async function checkServer(client: Queryable): Promise<void> {
  const { rows } = await client.query(
    `SELECT current_setting('server_version_num')::pg_catalog.int4 AS "version"`,
    [],
  );
  const { version } = rows[0] as { readonly version: number };
  if (version < PLANS_SINCE) {
    throw new Error(
      `This server is PostgreSQL ${String(Math.floor(version / A_MAJOR_VERSION))}: use PostgreSQL ${String(PLANS_SINCE / A_MAJOR_VERSION)} or later, whose plans a render's reads are read of.`,
    );
  }
}
