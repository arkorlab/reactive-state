import { is, type SQL } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { ExternalStore } from '../../authority/external.ts';
import { d1Executor, pruneChanges } from '../../cloudflare/d1-store.ts';
import { type Table, type TableRows, table, text } from '../../server/schema.ts';
import { withInternals } from '../follow-internals.ts';
import { generationOf } from '../generations.ts';
import type { RowReferences } from '../rows.ts';
import {
  type FollowedSqliteTable,
  followedSqliteTable,
  sqliteCaptureSql,
  sqliteTriggersOf,
} from './capture.ts';
import { type D1Binding, trackedD1 } from './client.ts';
import { type SqliteKeyColumn, sqliteKeysOf } from './keys.ts';
import { sqliteRows } from './rows.ts';
import { sqliteStore } from './store.ts';

/**
 * An application whose tables are its Drizzle schema's in D1 (`drizzle-orm/sqlite-core`), read and
 * written by its own Drizzle (`drizzle-orm/d1`), and followed by the authority: a render's
 * statements note the rows they read, the tables' triggers log each row a statement changed, and
 * the authority renders again what read the rows the log names. A component's state may bind one
 * column of one row (`db.<table>.where(…)`, `rows.ts`), which its setter writes through the same
 * binding.
 *
 * ```ts
 * const follow = followDrizzle(schema);
 * const orm = drizzle(follow.client(env.DB), { schema });
 * const db = followedDb(follow);
 * // The host: follow.captureSql() run in one D1 batch; the store is the follow's, of env.DB.
 * ```
 */

/**
 * The tables of a Drizzle schema of SQLite, by the names it exports them by, and the table a change
 * of the schema is followed by: a database declares them all.
 */
type FollowedSqliteTables<S> = Readonly<Record<`reactive_state_schema_${string}`, Table>> & {
  readonly [K in keyof S as S[K] extends SQLiteTable ? K : never]: Table & {
    readonly rows: TableRows<SQL | undefined, RowReferences<S[K]>>;
  };
};

export interface DrizzleD1Follow<S> {
  /**
   * The schema's tables, as the application's database declares them: `followedDb(follow)` declares
   * them with the store, `database(follow.tables)` alone.
   */
  readonly tables: FollowedSqliteTables<S>;
  /** The store's name, which the authority's host gives `store()` by. */
  readonly storeName: string;
  /** The statements that make the log and each table's triggers: run them in one D1 batch. */
  readonly captureSql: () => readonly string[];
  /**
   * `binding`, a D1 binding, whose statements in a render note what they read: Drizzle's, and the
   * connection a state bound to a row reads and writes it through — the last one given.
   */
  readonly client: <B extends D1Binding>(binding: B) => B;
  /**
   * The store the host gives the authority, which reads the log through `binding`: of
   * `followedDb(follow)`'s database, the follow's own, of the binding `client` was last given,
   * unless the host gives one.
   */
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
  const partials = new Map<string, readonly (readonly string[])[]>();
  const rowids = new Map<string, string | undefined>();
  const triggers = new Map<string, ReadonlyMap<string, string>>();
  const followed: FollowedSqliteTable[] = [];
  const tables: Record<string, Table> = {};
  let connection: D1Binding | undefined;
  const connected = (): D1Binding => {
    if (connection === undefined) {
      throw new Error(
        'A state bound to a row is read and written through the binding `follow.client` is given, and it was given none.',
      );
    }
    return connection;
  };
  for (const [name, value] of Object.entries(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const keys = sqliteKeysOf(value);
    const entry = followedSqliteTable(name, value, keys);
    // The keys' text of each changed row, as the log keeps it: what a render's conditions name.
    const fields = keys.map((key) => [key.field, text()] as const);
    tables[name] = Object.freeze({
      ...table(Object.fromEntries(fields), { external: storeName }),
      rows: sqliteRows(value, keys, connected),
    });
    byName.set(entry.name, name);
    keysByTable.set(name, keys);
    uniques.set(name, entry.uniques);
    partials.set(name, entry.partials);
    rowids.set(name, entry.unreadUnique ? undefined : entry.rowid);
    triggers.set(name, sqliteTriggersOf(entry));
    followed.push(entry);
  }
  tables[schemaTable] = table({}, { external: storeName });
  const generation = generationOf(`d1:${storeName}`);
  const reads = { byName, keysByTable, schema: generation, schemaTable };
  const store = { byName, keysByTable, partials, rowids, schema: generation, triggers, uniques };
  const declared = Object.freeze(tables);
  /** The binding `client` was last given, as it was given: what the follow's store reads. */
  let given: D1Binding | undefined;
  const follow = Object.freeze({
    captureSql: () => sqliteCaptureSql(followed),
    client: <B extends D1Binding>(binding: B) => {
      const tracked = trackedD1(binding, reads);
      connection = tracked;
      given = binding;
      return tracked;
    },
    prune: (binding: D1Binding, before: number) =>
      pruneChanges(d1Executor(binding as Parameters<typeof d1Executor>[0]), before),
    store: (binding: D1Binding) => sqliteStore(binding, store),
    storeName,
    tables: declared as FollowedSqliteTables<S>,
  });
  // The log is read through the binding as the host gave it, as `follow.store(binding)` reads it:
  // not through the one Drizzle is given, which follows a render's and an operation's statements.
  return withInternals(follow, {
    store: () => (given === undefined ? undefined : sqliteStore(given, store)),
    storeName,
    tables: declared,
  });
}
