import { is, type SQL } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';

import { d1Executor, pruneChanges } from '../../cloudflare/d1-store.ts';
import { followedTable } from '../../server/followed-table.ts';
import { type Table, type TableRows, text } from '../../server/schema.ts';
import { type Declaring, withInternals } from '../follow-internals.ts';
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
import {
  type BindingOfNow,
  type ForwardedD1,
  isBindingOfNow,
  lateD1,
  ownStoreOf,
} from './late-binding.ts';
import { sqliteRows } from './rows.ts';
import { sqliteStore } from './store.ts';

/**
 * An application whose tables are its Drizzle schema's in D1 (`drizzle-orm/sqlite-core`), read and
 * written by its own Drizzle (`drizzle-orm/d1`), and followed by the authority: a render's
 * statements note the rows they read, the tables' triggers log each row a statement changed, and
 * the authority renders again what read the rows the log names. A component's state may bind one
 * column of one row (`db.<table>.where(…)`, `rows.ts`), which its setter writes through the same
 * binding. A binding that arrives as the host starts — a Durable Object's, of its environment — is
 * given as a function that answers it, or none before it arrives (`late-binding.ts`).
 *
 * ```ts
 * const follow = followDrizzle(schema);
 * const orm = drizzle(follow.client(env.DB), { schema });
 * const db = followedDb(follow);
 * // The host: follow.captureSql() run in one D1 batch; the follow's store reads env.DB's log.
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

/** What follows the tables of a schema of SQLite's in D1, which its database declares. */
export interface DrizzleD1Follow<S> extends Declaring<FollowedSqliteTables<S>> {
  /** The statements that make the log and each table's triggers: run them in one D1 batch. */
  readonly captureSql: () => readonly string[];
  /**
   * `binding`, a D1 binding, whose statements in a render note what they read: Drizzle's, and the
   * connection a state bound to a row reads and writes it through — the last one given. Of a
   * function that answers the binding of now, or none — a Durable Object's, which its constructor
   * connects of its environment — a binding that asks it at each call, and the follow's own store
   * asks it at each read of the log: of none, a call throws, naming the store, and the log tells of
   * no change. That binding holds D1's methods of the binding's type alone (`ForwardedD1`): of a
   * Worker's `D1Database`, all of it.
   */
  readonly client: {
    <B extends D1Binding>(binding: B): B;
    <B extends D1Binding>(binding: BindingOfNow<B>): ForwardedD1<B>;
  };
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
    tables[name] = followedTable(
      Object.fromEntries(fields),
      storeName,
      sqliteRows(value, keys, connected),
    );
    byName.set(entry.name, name);
    keysByTable.set(name, keys);
    uniques.set(name, entry.uniques);
    partials.set(name, entry.partials);
    rowids.set(name, entry.unreadUnique ? undefined : entry.rowid);
    triggers.set(name, sqliteTriggersOf(entry));
    followed.push(entry);
  }
  tables[schemaTable] = followedTable({}, storeName);
  const generation = generationOf(`d1:${storeName}`);
  const reads = { byName, keysByTable, schema: generation, schemaTable };
  const store = { byName, keysByTable, partials, rowids, schema: generation, triggers, uniques };
  /**
   * The binding `client` was last given, as it was given — or the function that answers it: what
   * the follow's store reads.
   */
  let given: D1Binding | BindingOfNow | undefined;
  const follow = Object.freeze({
    captureSql: () => sqliteCaptureSql(followed),
    client: (binding: D1Binding | BindingOfNow) => {
      // Of a function, a binding that asks it for the binding of now at each call.
      const opened: D1Binding = isBindingOfNow(binding) ? lateD1(binding, storeName) : binding;
      const tracked = trackedD1(opened, reads);
      connection = tracked;
      given = binding;
      return tracked;
    },
    prune: (binding: D1Binding, before: number) =>
      pruneChanges(d1Executor(binding as Parameters<typeof d1Executor>[0]), before),
  });
  // The log is read through the binding as the host gave it: not through the one Drizzle is given,
  // which follows a render's and an operation's statements.
  return withInternals(follow, {
    store: () => ownStoreOf(given, store),
    storeName,
    storeOf: (binding) => sqliteStore(binding as D1Binding, store),
    tables: Object.freeze(tables),
  });
}
