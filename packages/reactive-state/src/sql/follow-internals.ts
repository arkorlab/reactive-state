import type { ExternalStore } from '../authority/external.ts';
import type { Table } from '../server/schema.ts';

/**
 * What a follow keeps of its own beside what it answers (`followDrizzle`), of PostgreSQL's tables
 * or of D1's: its tables, its store's name, and its store, of the connection its `client` was last
 * given. `followedDb` reads them of the follow itself, and finds none of a value `followDrizzle` did
 * not answer.
 */

/** What a follow keeps of its own. */
interface FollowInternals {
  /** Its tables, as a database declares them: its schema's, and the table of its schema's changes. */
  readonly tables: Readonly<Record<string, Table>>;
  /** The name of its store, by which the authority reads its tables. */
  readonly storeName: string;
  /**
   * A store that reads its log through the connection its `client` was last given, made anew at
   * each call; none while it was given no connection.
   */
  readonly store: () => ExternalStore | undefined;
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
