import type { ExternalStore } from '../authority/external.ts';
import type { Table } from '../server/schema.ts';

/**
 * What a follow keeps of its own beside what it answers (`followDrizzle`), of PostgreSQL's tables
 * or of D1's: its tables, its store's name, and its store, of the connection its `client` was last
 * given or of one a host holds. `followedDb` and `reactiveDb` read them of the follow itself, and
 * find none of a value `followDrizzle` did not answer.
 */

/** What a follow's type carries of its tables, which no value of it holds: the key of none. */
declare const TABLES: unique symbol;

/** A follow's type, which carries the type of its tables `T`: what its database's type is of. */
export interface Declaring<T> {
  readonly [TABLES]?: T;
}

/** The tables a follow of the type `F` declares, as its database's type has them. */
export type TablesOfFollow<F> = F extends Declaring<infer T> ? T : never;

/** What a follow keeps of its own. */
interface FollowInternals {
  /** Its tables, as a database declares them: its schema's, and the table of its schema's changes. */
  readonly tables: Readonly<Record<string, Table>>;
  /** The name of its store, by which the authority reads its tables. */
  readonly storeName: string;
  /**
   * A store that reads its log through the connection its `client` was last given — of D1's, given
   * a function that answers it, the connection of now at each read (`sqlite/late-binding.ts`) —
   * made anew at each call; none while it was given no connection.
   */
  readonly store: () => ExternalStore | undefined;
  /**
   * A store that reads its log through `connection` — of PostgreSQL's follow what `pg` or PGlite
   * queries, of D1's a binding — made anew at each call: what a host that holds its own connections
   * reads it through (`reactiveDb`).
   */
  readonly storeOf: (connection: unknown) => ExternalStore;
}

/** Where they are kept, on `globalThis`: a follow may be of another copy of this module. */
const INTERNALS = Symbol.for('arkorlab.reactive-state.follow-internals');

/** What each follow keeps of its own, of the process's. */
function kept(): WeakMap<WeakKey, FollowInternals> {
  const shared = globalThis as unknown as Record<
    symbol,
    WeakMap<WeakKey, FollowInternals> | undefined
  >;
  shared[INTERNALS] ??= new WeakMap();
  return shared[INTERNALS];
}

/** `follow`, which `followDrizzle` answers, keeping `internals`. */
export function withInternals<F extends WeakKey>(follow: F, internals: FollowInternals): F {
  kept().set(follow, internals);
  return follow;
}

/** What `follow` keeps of its own: nothing of a value `followDrizzle` did not answer. */
export function internalsOf(follow: unknown): FollowInternals | undefined {
  return typeof follow === 'object' && follow !== null ? kept().get(follow) : undefined;
}

/** What `follow` keeps of its own, of one `followDrizzle` answered: a fault of any other value. */
export function ownInternals(follow: unknown): FollowInternals {
  const internals = internalsOf(follow);
  if (internals === undefined) {
    throw new TypeError('This is no follow `followDrizzle` answered.');
  }
  return internals;
}
