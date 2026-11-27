/**
 * The prune of an application's change log in D1 (`pruneChanges`), and what it runs its statement
 * through (`D1Executor`): a D1 binding's (`d1Executor`), or a host's own, as a private database
 * gateway is. The log is the one `followDrizzle`'s `captureSql()` makes (`d1-log.ts`), whose
 * follow's `prune` is this one; a host that prunes it over a connection of its own calls it here.
 * The `./d1` entry runs on Node as well, without loading `cloudflare:workers`.
 */

/** How the prune reaches D1: a statement and its parameters, answered by its rows. */
export interface D1Executor {
  readonly all: (
    sql: string,
    params: readonly unknown[],
  ) => Promise<readonly Readonly<Record<string, unknown>>[]>;
}

/** The D1 binding's own, as much of it as is read: a statement prepared, bound, and answered. */
interface D1Like {
  readonly prepare: (sql: string) => {
    readonly bind: (...params: unknown[]) => {
      readonly all: () => Promise<{ readonly results: readonly Record<string, unknown>[] }>;
    };
  };
}

/** A D1 binding (`env.DB`) as the prune's executor. */
export function d1Executor(database: D1Like): D1Executor {
  return {
    all: async (sql, params) => {
      return (
        await database
          .prepare(sql)
          .bind(...params)
          .all()
      ).results;
    },
  };
}

/** The log the triggers write. */
const LOG = '_rs_changes';

/**
 * Lets go of the changes of the log older than `before` (epoch milliseconds), for the application's
 * own schedule to run: those before the first change at or after it, by their order in the log —
 * every one, where none is that new. A change the database's clock stamped earlier than one before
 * it is kept with it, never let go of from between two kept ones: a follower would read past the
 * gap, its floor where it was. SQLite's sequence keeps the head even when no row remains. A
 * follower behind what was let go of renders again whatever read the store's tables.
 */
export async function pruneChanges(executor: D1Executor, before: number): Promise<void> {
  // A cutoff the statement may bind: a safe whole number, zero too.
  if (!Number.isSafeInteger(before) || before < 0) {
    throw new RangeError('A D1 pruning cutoff is a non-negative safe integer.');
  }
  await executor.all(
    `DELETE FROM ${LOG} WHERE seq < coalesce((SELECT min(seq) FROM ${LOG} WHERE at >= ?), (SELECT max(seq) FROM ${LOG}) + 1)`,
    [before],
  );
}
