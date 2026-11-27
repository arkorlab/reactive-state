import type { AnyDatabase } from '../server/schema.ts';

/**
 * What a database that holds its own connections brings to the authority it is given to
 * (`reactiveDb`): the application names no store, opens no connection and listens to nothing, as the
 * authority does each of these as it starts, and ends them as it closes. By the database itself, as
 * the compile hands the authority the application's export as it is.
 */
export interface DatabaseHost {
  /** Makes what the database's changes are followed by: the log, and each table's triggers. */
  readonly open: () => Promise<void>;
  /** Has `told` called as each change commits. */
  readonly listen: (told: () => void) => Promise<void>;
  /** Discards what the database keeps of changes past following. */
  readonly prune: () => Promise<void>;
  /** The application's migrations in `folder`, for a host to run before the authority starts. */
  readonly migrate: (folder: string) => Promise<void>;
  /** Runs `first`, which writes the application's first records, unless it ran of this database. */
  readonly seed: (first: () => Promise<void>) => Promise<void>;
  /** Runs `work` alone of the hosts of this database: of two that start at once, one migrates it. */
  readonly alone: (work: () => Promise<void>) => Promise<void>;
  readonly close: () => Promise<void>;
}

/** How long a host's change log keeps an entry: a follower further behind renders everything again. */
export const LOG = { keptMs: 3_600_000 } as const;

/** Where the hosts are kept, on `globalThis`: the authority may be of another copy of this module. */
const HOSTS = Symbol.for('arkorlab.reactive-state.database-hosts');

/** What a database brings, and whether an authority took it. */
interface Hosted {
  readonly host: DatabaseHost;
  taken: boolean;
}

/** What each database brings, of the process's, as the database's definition is (`definitionOf`). */
function hosted(): WeakMap<AnyDatabase, Hosted> {
  const shared = globalThis as unknown as Record<symbol, WeakMap<AnyDatabase, Hosted> | undefined>;
  shared[HOSTS] ??= new WeakMap();
  return shared[HOSTS];
}

/** Has `database` brought by `host`. */
export function hostDatabase(database: AnyDatabase, host: DatabaseHost): void {
  hosted().set(database, { host, taken: false });
}

/** What `database` brings to its authority, of a database that made its own connections. */
export function hostOf(database: AnyDatabase): DatabaseHost | undefined {
  return hosted().get(database)?.host;
}

/**
 * What `database` brings to the authority that starts now: of one alone, as the connections end with
 * it, or with its failed start, and a second start's failure would end those of the first.
 */
export function takeHost(database: AnyDatabase): DatabaseHost | undefined {
  const entry = hosted().get(database);
  if (entry === undefined) return undefined;
  if (entry.taken) {
    throw new Error(
      "This database's connections end with the first authority given it, or with its failed start: make another with `reactiveDb`.",
    );
  }
  entry.taken = true;
  return entry.host;
}
