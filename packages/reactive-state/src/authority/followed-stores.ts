import type { DatabaseDefinition } from '../server/schema.ts';
import type { ExternalStore } from './external.ts';

/**
 * The stores the follows of a database bring (`followedDb`), by the database's declaration — the
 * one object `definitionOf` answers of it each time, which the engine reads its tables of: each the
 * store of one follow's log, by its name, made as an authority starts of the connection the
 * follow's `client` was last given. A store the host gives by the same name is read in its place
 * (`storesOf`). Unlike a database that holds its own connections (`database-host.ts`), the follows
 * bring the authority nothing to open, listen to or prune.
 */

/** A store of each follow of a database, by its name: made anew at each call, or a fault. */
type FollowedStores = ReadonlyMap<string, () => ExternalStore>;

/** Where they are kept, on `globalThis`: the authority may be of another copy of this module. */
const FOLLOWED = Symbol.for('arkorlab.reactive-state.followed-stores');

/** The stores each database's follows bring, of the process's. */
function followed(): WeakMap<DatabaseDefinition, FollowedStores> {
  const shared = globalThis as unknown as Record<
    symbol,
    WeakMap<DatabaseDefinition, FollowedStores> | undefined
  >;
  shared[FOLLOWED] ??= new WeakMap();
  return shared[FOLLOWED];
}

/** Has the database `definition` declares brought `stores` by its follows. */
export function bringStores(definition: DatabaseDefinition, stores: FollowedStores): void {
  followed().set(definition, stores);
}

/** The stores the follows of the database `definition` declares bring: none of any other. */
export function storesBroughtBy(definition: DatabaseDefinition): FollowedStores | undefined {
  return followed().get(definition);
}
