import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { ExternalStore } from '../../authority/external.ts';
import { d1Executor, pruneChanges } from '../../cloudflare/d1-store.ts';
import { type Table, table, text } from '../../server/schema.ts';
import { generationOf } from '../generations.ts';
import {
  type FollowedSqliteTable,
  followedSqliteTable,
  sqliteCaptureSql,
  sqliteTriggersOf,
} from './capture.ts';
import { type D1Binding, trackedD1 } from './client.ts';
import { type SqliteKeyColumn, sqliteKeysOf } from './keys.ts';
import { sqliteStore } from './store.ts';

/**
 * An application whose tables are its Drizzle schema's in D1 (`drizzle-orm/sqlite-core`), read and
 * written by its own Drizzle (`drizzle-orm/d1`), and followed by the authority: a render's
 * statements note the rows they read, the tables' triggers log each row a statement changed, and
 * the authority renders again what read the rows the log names.
 *
 * ```ts
 * const follow = followDrizzle(schema);
 * const orm = drizzle(follow.client(env.DB), { schema });
 * const db = database(follow.tables);
 * // The host: stores: { sql: follow.store(env.DB) }; follow.captureSql() run in one D1 batch.
 * ```
 */

/**
 * The tables of a Drizzle schema of SQLite, by the names it exports them by, and the table a change
 * of the schema is followed by: a database declares them all.
 */
type FollowedSqliteTables<S> = Readonly<Record<`reactive_state_schema_${string}`, Table>> & {
  readonly [K in keyof S as S[K] extends SQLiteTable ? K : never]: Table;
};

export interface DrizzleD1Follow<S> {
  /** The schema's tables, as the application's database declares them: `database(follow.tables)`. */
  readonly tables: FollowedSqliteTables<S>;
  /** The store's name, which the authority's host gives `store()` by. */
  readonly storeName: string;
  /** The statements that make the log and each table's triggers: run them in one D1 batch. */
  readonly captureSql: () => readonly string[];
  /** `binding`, a D1 binding, whose statements in a render note what they read: Drizzle's. */
  readonly client: <B extends D1Binding>(binding: B) => B;
  /** The store the host gives the authority, which reads the log through `binding`. */
  readonly store: (binding: D1Binding) => ExternalStore;
  /** Discards the log's entries written before `before`, a time in milliseconds. */
  readonly prune: (binding: D1Binding, before: number) => Promise<void>;
}

/** The tables of `schema`, of SQLite, an authority follows, of the store `storeName`. */
export function followSqlite<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  storeName: string,
  schemaTable: string,
): DrizzleD1Follow<S> {
  const byName = new Map<string, string>();
  const keysByTable = new Map<string, readonly SqliteKeyColumn[]>();
  const uniques = new Map<string, readonly (readonly string[])[]>();
  const rowids = new Map<string, string | undefined>();
  const triggers = new Map<string, ReadonlyMap<string, string>>();
  const followed: FollowedSqliteTable[] = [];
  const tables: Record<string, Table> = {};
  for (const [name, value] of Object.entries(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const keys = sqliteKeysOf(value);
    const entry = followedSqliteTable(name, value, keys);
    // The keys' text of each changed row, as the log keeps it: what a render's conditions name.
    tables[name] = table(Object.fromEntries(keys.map((key) => [key.field, text()])), {
      external: storeName,
    });
    byName.set(entry.name, name);
    keysByTable.set(name, keys);
    uniques.set(name, entry.uniques);
    rowids.set(name, entry.unreadUnique ? undefined : entry.rowid);
    triggers.set(name, sqliteTriggersOf(entry));
    followed.push(entry);
  }
  tables[schemaTable] = table({}, { external: storeName });
  const generation = generationOf(`d1:${storeName}`);
  const reads = { byName, keysByTable, schema: generation, schemaTable };
  const store = { byName, keysByTable, rowids, schema: generation, triggers, uniques };
  return Object.freeze({
    captureSql: () => sqliteCaptureSql(followed),
    client: <B extends D1Binding>(binding: B) => trackedD1(binding, reads),
    prune: (binding: D1Binding, before: number) =>
      pruneChanges(d1Executor(binding as Parameters<typeof d1Executor>[0]), before),
    store: (binding: D1Binding) => sqliteStore(binding, store),
    storeName,
    tables: Object.freeze(tables) as FollowedSqliteTables<S>,
  });
}
