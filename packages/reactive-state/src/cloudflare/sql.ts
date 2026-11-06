import type { Row } from '../authority/rows.ts';
import { refuseAsync, type SqlDriver, type SqlParameter } from '../authority/sql.ts';

/**
 * The authority's SQLite in a Durable Object's own storage (`ctx.storage.sql`). A statement runs as
 * `exec` is called, so a write is never iterated; a read is taken whole, and a row is the first of
 * them.
 *
 * A group of writes is `transactionSync`, the one transaction the storage lets an object open — it
 * refuses `BEGIN` — which commits when its body returns and rolls back when it throws. The storage
 * would take one inside another as a savepoint; the driver refuses it instead, as Node's does, so
 * that the engine is held to one contract wherever it runs. The storage is the object's for as long
 * as the object lives, so there is nothing to close.
 */
/**
 * A statement the object's storage would not run, thrown on as this rather than as the plain
 * `Error` the storage throws, so that it is named a storage fault wherever it lands — the object's
 * log, a test — as Node's driver names its own with a `code`. The engine reads it as it reads any
 * error but an `AuthorityError` (`errors.ts`): a fault, never the session's refusal.
 */
export class StorageFaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageFaultError';
  }
}

/** What `statement` answers; what the storage throws for it, as a `StorageFaultError`. */
function stored<T>(statement: () => T): T {
  try {
    return statement();
  } catch (error) {
    throw new StorageFaultError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

export function durableObjectSql(storage: DurableObjectStorage): SqlDriver {
  let inTransaction = false;
  // Read whole inside `stored`: a read may fail as its rows are stepped through, not only as it starts.
  const rows = (query: string, parameters: readonly SqlParameter[]): Row[] =>
    stored(() => storage.sql.exec(query, ...parameters).toArray());
  return {
    all: (query, ...parameters) => rows(query, parameters),
    close: () => {
      // The object's storage outlives any one engine over it, and is never closed by one.
    },
    get: (query, ...parameters) => rows(query, parameters)[0],
    run: (query, ...parameters) => {
      stored(() => storage.sql.exec(query, ...parameters));
    },
    transaction: (body) => {
      if (inTransaction) {
        throw new Error('A transaction cannot open inside another');
      }
      inTransaction = true;
      try {
        return storage.transactionSync(() => {
          const result = body();
          // Thrown inside the transaction, so that what the body wrote before it returned the
          // promise is rolled back with it.
          refuseAsync(result);
          return result;
        });
      } finally {
        inTransaction = false;
      }
    },
  };
}
