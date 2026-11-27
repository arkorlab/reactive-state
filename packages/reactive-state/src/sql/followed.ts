import type { ExternalStore } from '../authority/external.ts';
import { bringStores } from '../authority/followed-stores.ts';
import {
  type AnyDatabase,
  database,
  definitionOf,
  type Table,
  type TableRows,
} from '../server/schema.ts';
import { internalsOf } from './follow-internals.ts';
import type { DrizzleFollow } from './index.ts';
import type { DrizzleD1Follow } from './sqlite/follow.ts';

/**
 * The database of a host that opens its own connections, of the follows `followDrizzle` answered —
 * of PostgreSQL's tables or of D1's, one or more: what the compile's `--database` names, declared
 * by `database()`, so that the authority reads it as it reads any. Each follow brings its own
 * store, which the authority makes as it starts of the connection the follow's `client` was last
 * given, and reads the follow's log through: the host gives no `stores`, and a store it gives by the
 * name of a follow's store is read in that one's place. No connection is opened, listened to or
 * pruned here: the host does each, as it opened them.
 *
 * ```ts
 * // @/db
 * export const follow = followDrizzle(schema);
 * export const orm = drizzle(follow.client(env.DB), { schema });
 * export const db = followedDb(follow);
 * ```
 */

/** What `followDrizzle` answered, of PostgreSQL's tables or of SQLite's in D1. */
type Follow = DrizzleD1Follow<unknown> | DrizzleFollow<unknown>;

/** The tables of each follow of `F`, as one database declares them all. */
type TablesOf<F> = F extends readonly [infer First, ...infer Rest]
  ? (First extends { readonly tables: infer T } ? T : never) & TablesOf<Rest>
  : unknown;

/** How a state binds a row of `T`, a table of a Drizzle schema, which is all such a table answers. */
type RowsOf<T> = T extends { readonly rows: TableRows<infer C, infer R> }
  ? {
      /**
       * A reference of each column a state may bind of the one row `condition` names: `eq`s, alone
       * or under `and`, that hold a primary key or a unique index whole.
       */
      readonly where: (condition: C) => R;
    }
  : never;

/**
 * The database `followedDb` answers: of each table of the follows' schemas, the row a condition
 * names, and nothing else. The application reads and writes the tables with its Drizzle:
 * `db.<table>.get`, `findMany` and `count` are faults of such a table.
 */
type FollowedDatabase<T> = AnyDatabase & {
  readonly [K in keyof T as T[K] extends { readonly rows: TableRows } ? K : never]: RowsOf<T[K]>;
};

function fail(message: string): never {
  throw new TypeError(`followedDb(): ${message}`);
}

/** What a store of a follow given no connection by the authority's start comes to: a fault. */
function unconnected(storeName: string): never {
  throw new TypeError(
    `The store \`${storeName}\` reads its follow's log through the connection \`follow.client\` was given, and the follow was given none as the authority started: give it the application's connection, \`follow.client(…)\`, first.`,
  );
}

/**
 * The database of `follows`, each of a store its own and of tables no other holds: what the
 * compile's `--database` names, of whose tables a state binds a row (`db.<table>.where(…)`).
 */
export function followedDb<F extends readonly [Follow, ...Follow[]]>(
  ...follows: F
): FollowedDatabase<TablesOf<F>> {
  if (follows.length === 0) {
    fail('give it at least one follow, of what `followDrizzle()` answered');
  }
  const tables: Record<string, Table> = {};
  const stores = new Map<string, () => ExternalStore>();
  for (const [index, follow] of follows.entries()) {
    const internals = internalsOf(follow);
    if (internals === undefined) {
      fail(
        `argument ${String(index + 1)} is not what \`followDrizzle()\` answered: give each follow itself, not its \`tables\` nor a database`,
      );
    }
    const { storeName } = internals;
    if (stores.has(storeName)) {
      fail(
        `two of the follows are of the store \`${storeName}\`: give each follow once, and each its own store, \`followDrizzle(schema, { store })\``,
      );
    }
    stores.set(storeName, () => internals.store() ?? unconnected(storeName));
    for (const [name, table] of Object.entries(internals.tables)) {
      if (Object.hasOwn(tables, name)) {
        fail(
          `\`${name}\` is a table of two of the follows' schemas: export it by another name in one of them`,
        );
      }
      tables[name] = table;
    }
  }
  const db = database(tables);
  bringStores(definitionOf(db), stores);
  return db as unknown as FollowedDatabase<TablesOf<F>>;
}
