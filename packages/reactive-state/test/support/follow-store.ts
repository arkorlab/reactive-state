import type { ExternalStore } from '../../src/authority/external.ts';
import { bringStores, storesBroughtBy } from '../../src/authority/followed-stores.ts';
import { type AnyDatabase, definitionOf } from '../../src/server/schema.ts';
import { internalsOf } from '../../src/sql/follow-internals.ts';

/**
 * What a test reads of a follow, and gives the authority of it, through the package's own seams,
 * which stay once the follow's `tables`, `store` and `storeName` and the host's `stores` are gone:
 * what a follow keeps of its own (`follow-internals.ts`), and the stores the follows of a database
 * bring (`followed-stores.ts`).
 */

/** What `follow` keeps of its own: a fault of a value `followDrizzle` did not answer. */
export function followInternals(follow: unknown): NonNullable<ReturnType<typeof internalsOf>> {
  const internals = internalsOf(follow);
  if (internals === undefined) {
    throw new TypeError('This is no follow `followDrizzle` answered.');
  }
  return internals;
}

/**
 * The store `follow` brings an authority, as it makes it as it starts: of the connection the
 * follow's `client` was last given. A fault of a follow given none.
 */
export function ownStore(follow: unknown): ExternalStore {
  const store = followInternals(follow).store();
  if (store === undefined) {
    throw new TypeError('The follow was given no connection: it brings no store.');
  }
  return store;
}

/**
 * The store of `follow`'s log, read through `connection`: the follow is given it (`follow.client`),
 * and brings its own store of it, as a state bound to a row of its tables is read and written
 * through it from then on. Of a follow of the same tables of the test's own, a store of
 * `connection` beside the connection another follow is given: the follows of one log — of one
 * store's name in D1, of one namespace in PostgreSQL — share what a store of theirs reads of its
 * schema (`generations.ts`).
 */
export function storeThrough(
  follow: { readonly client: (connection: never) => unknown },
  connection: unknown,
): ExternalStore {
  (follow.client as (given: unknown) => unknown)(connection);
  return ownStore(follow);
}

/**
 * `database`, whose follows' logs the authority reads through `stores`, by the stores' names, in
 * place of those the follows bring of the same names and beside the others: what a host's `stores`
 * gave, each made anew as an authority starts.
 */
export function readingThrough<D extends AnyDatabase>(
  database: D,
  stores: Readonly<Record<string, () => ExternalStore>>,
): D {
  const definition = definitionOf(database);
  const reading = new Map<string, () => ExternalStore>(storesBroughtBy(definition));
  for (const [name, store] of Object.entries(stores)) reading.set(name, store);
  bringStores(definition, reading);
  return database;
}

/** What a stand-in answers of a table's records: none, as a follow's tables are read by SQL. */
function bySql(): Promise<never> {
  return Promise.reject(new Error("A followed table is read by the application's SQL."));
}

/** A stand-in for a follow's store, whose log `changes` answers as the test writes it. */
export function logStore(changes: ExternalStore['changes']): ExternalStore {
  return { changes, count: bySql, find: bySql, get: bySql };
}
