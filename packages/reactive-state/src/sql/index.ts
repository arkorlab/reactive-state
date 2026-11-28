import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { ExternalStore } from '../authority/external.ts';
import { type Table, table, text } from '../server/schema.ts';
import {
  changeCaptureSql,
  channelOf,
  DEFAULT_NAMESPACE,
  type FollowedRelation,
  relationKey,
} from './capture.ts';
import { type Connection, trackedClient } from './client.ts';
import { generationOf } from './generations.ts';
import { type KeyColumn, keysOf } from './keys.ts';
import { type DrizzleD1Follow, followSqlite } from './sqlite/follow.ts';
import { pruneSqlChanges, type Queryable, sqlStore } from './store.ts';

export type { DrizzleD1Follow } from './sqlite/follow.ts';

/**
 * An application whose tables are its Drizzle schema's, in PostgreSQL — PGlite as it develops —
 * read and written by its own Drizzle, and followed by the authority: a render's queries note the
 * tables their plans read, the tables' triggers log each statement that changed them, and the
 * authority renders again what read a table the log names. The application's database declares
 * them as external tables of one store, whose host follows that log.
 *
 * ```ts
 * // @/db
 * export const follow = followDrizzle(schema);
 * export const pg = await PGlite.create('.data/pglite');
 * export const orm = drizzle({ client: follow.client(pg), schema });
 * export const db = database(follow.tables);
 * ```
 */

/**
 * The table of each store that every render's statement reads, by which a change of the schema
 * renders it again (`Followed.schemaTable`): `reactive_state_schema_<store>`, so that the stores of
 * two databases one authority follows are each of their own.
 */
const SCHEMA_TABLE = 'reactive_state_schema_';
/**
 * A store's name a table's name holds as it is: a letter, then up to 39 letters, digits or `_`.
 * Another's is its digest's (`schemaTableOf`), which begins with `_`, as none of these does.
 */
const STORE = /^[A-Za-z]\w{0,39}$/u;
/** A digest of 64 bits of a store's name a table's name cannot hold: a polynomial of its bytes. */
const DIGEST = {
  base: 131n,
  modulus: 18_446_744_073_709_551_616n,
  radix: 16,
  width: 16,
} as const;

/**
 * The table of the schema of the store `storeName`: of its name where a table's may hold it, else
 * of a digest of it (`_` and 16 hexadecimal digits), whatever the host names its store; no two
 * stores' names alike but in their digests make one table.
 */
function schemaTableOf(storeName: string): string {
  if (STORE.test(storeName)) {
    return `${SCHEMA_TABLE}${storeName}`;
  }
  const bytes = new TextEncoder().encode(storeName);
  let digest = 0n;
  for (const byte of bytes) {
    digest = (digest * DIGEST.base + BigInt(byte)) % DIGEST.modulus;
  }
  return `${SCHEMA_TABLE}_${digest.toString(DIGEST.radix).padStart(DIGEST.width, '0')}`;
}

/**
 * The tables of a Drizzle schema, by the names it exports them by, and the table a change of the
 * schema is followed by (`reactive_state_schema_<store>`): a database declares them all, which
 * every render's statement reads.
 */
type FollowedTables<S> = Readonly<Record<`${typeof SCHEMA_TABLE}${string}`, Table>> & {
  readonly [K in keyof S as S[K] extends PgTable ? K : never]: Table;
};

export interface FollowDrizzleOptions {
  /** The store the tables are read through, as the authority's host gives it: `sql` unless given. */
  readonly store?: string;
  /**
   * The schema the change log is kept in, of PostgreSQL alone: `reactive_state` unless given — none
   * PostgreSQL keeps for itself (`pg_…`, `information_schema`), nor the application's own
   * (`public`, a followed table's schema).
   */
  readonly namespace?: string;
}

/** Whether a schema holds a table of SQLite's, which D1 keeps: by its dialect, which Drizzle types. */
type OfSqlite<S> = true extends {
  [K in keyof S]: S[K] extends { readonly _: { readonly config: { readonly dialect: 'sqlite' } } }
    ? true
    : false;
}[keyof S]
  ? true
  : false;

export interface DrizzleFollow<S> {
  /** The schema's tables, as the application's database declares them: `database(follow.tables)`. */
  readonly tables: FollowedTables<S>;
  /** The store's name, which the authority's host gives `store()` by. */
  readonly storeName: string;
  /**
   * What a host notifies its authority on, as the log commits — `LISTEN`, then `poke()`:
   * `<namespace>_changes`, `reactive_state_changes` unless the namespace is given.
   */
  readonly channel: string;
  /** The statements that make the log and each table's triggers, each run by itself, in order. */
  readonly captureSql: () => readonly string[];
  /**
   * `client`, a PGlite, whose queries in a render note the tables they read: Drizzle's client. A
   * serializer the application gave it (`PGlite.create({ serializers })`) answers the same text of
   * the same value each time it is called, and changes nothing as it is: a render's condition is
   * followed by the text it answers, which is asked before the value is bound.
   */
  readonly client: <C extends Connection>(client: C) => C;
  /** The store the host gives the authority, which reads the log through `client`. */
  readonly store: (client: Queryable) => ExternalStore;
  /** Discards the log's entries written before `before`, a time in milliseconds. */
  readonly prune: (client: Queryable, before: number) => Promise<void>;
}

/**
 * The tables of `schema` an authority follows, and what its host follows them with: of PostgreSQL's
 * tables (`drizzle-orm/pg-core`), or of SQLite's in D1 (`drizzle-orm/sqlite-core`), not of both.
 */
export function followDrizzle<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  options: FollowDrizzleOptions = {},
): OfSqlite<S> extends true ? DrizzleD1Follow<S> : DrizzleFollow<S> {
  const values = Object.values(schema);
  const sqlite = values.some((value) => is(value, SQLiteTable));
  if (!sqlite) return followPostgres(schema, options) as never;
  if (values.some((value) => is(value, PgTable))) {
    throw new TypeError(
      "followDrizzle(): a schema is of PostgreSQL's tables or of SQLite's, not of both: follow each of its own.",
    );
  }
  if (options.namespace !== undefined) {
    throw new TypeError(
      "followDrizzle(): a namespace is of PostgreSQL's log alone: D1's log is `_rs_changes`.",
    );
  }
  const storeName = options.store ?? 'sql';
  const schemaTable = schemaTableOf(storeName);
  if (Object.hasOwn(schema, schemaTable)) {
    throw new TypeError(
      `followDrizzle(): \`${schemaTable}\` is the name of the table a change of the schema is followed by, not a table of the schema's.`,
    );
  }
  return followSqlite(schema, storeName, schemaTable) as never;
}

/** The tables of `schema`, of PostgreSQL, an authority follows. */
function followPostgres<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  options: FollowDrizzleOptions,
): DrizzleFollow<S> {
  const storeName = options.store ?? 'sql';
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  // Of a namespace it refuses, nothing is made: no generation of it is kept.
  const channel = channelOf(namespace);
  const byRelation = new Map<string, string>();
  const keysByTable = new Map<string, readonly KeyColumn[]>();
  const relations: FollowedRelation[] = [];
  const tables: Record<string, Table> = {};
  for (const [name, value] of Object.entries(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const keys = keysOf(value);
    const relation = {
      keys: keys.map((key) => key.column),
      name: config.name,
      schema: config.schema ?? 'public',
    };
    // The keys' values of each changed row, as the log keeps them: what a render's conditions name.
    tables[name] = table(Object.fromEntries(keys.map((key) => [key.field, text()])), {
      external: storeName,
    });
    byRelation.set(relationKey(relation), name);
    keysByTable.set(name, keys);
    relations.push(relation);
  }
  // The schema's count takes the objects of the log's schema for the log's own: a followed table's
  // schema is the application's.
  const held = relations.find((relation) => relation.schema === namespace);
  if (held !== undefined) {
    throw new TypeError(
      `followDrizzle(): \`${namespace}\` is not a namespace: the followed table \`${relationKey(held)}\` is in it, and it is the application's own.`,
    );
  }
  const schemaTable = schemaTableOf(storeName);
  if (Object.hasOwn(tables, schemaTable)) {
    throw new TypeError(
      `followDrizzle(): \`${schemaTable}\` is the name of the table a change of the schema is followed by, not a table of the schema's.`,
    );
  }
  tables[schemaTable] = table({}, { external: storeName });
  const followed = {
    byRelation,
    keysByTable,
    namespace,
    relations,
    schema: generationOf(namespace),
    schemaTable,
  };
  return Object.freeze({
    captureSql: () => changeCaptureSql(relations, namespace),
    channel,
    client: <C extends Connection>(client: C) => trackedClient(client, followed),
    prune: (client: Queryable, before: number) => pruneSqlChanges(client, before, namespace),
    store: (client: Queryable) => sqlStore(client, followed),
    storeName,
    tables: Object.freeze(tables) as FollowedTables<S>,
  });
}
