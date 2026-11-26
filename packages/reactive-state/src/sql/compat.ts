import { logOf } from './capture.ts';
import type { Queryable } from './digest.ts';

/**
 * A log made by an earlier capture version, identified by PostgreSQL's error code and position in
 * the store's own statement: the row-image columns, or a schema-count helper, are missing. An
 * error inside a function, or anywhere else, keeps its original meaning.
 */
function missingCapture(error: unknown, sql: string, namespace: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (Reflect.get(error, 'internalQuery') !== undefined) return false;
  const position = Number(Reflect.get(error, 'position'));
  if (!Number.isSafeInteger(position) || position < 1 || position > sql.length) return false;
  const at = sql.slice(position - 1);
  const code: unknown = Reflect.get(error, 'code');
  if (code === '42703') {
    return at.startsWith('"side"') || at.startsWith('"image"');
  }
  if (code === '42883') {
    const { schema } = logOf(namespace);
    return at.startsWith(`${schema}."ddl_count"(`) || at.startsWith(`${schema}."fold_ddl"(`);
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
