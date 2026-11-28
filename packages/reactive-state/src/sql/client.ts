import { tableReads } from '../server/context.ts';
import { facadeOf, guardedObjects, refusalOf, retainedReceiver } from './client-objects.ts';
import {
  answerOf,
  called,
  codeOf,
  type Connection,
  OWN,
  type Planner,
  Plans,
  REFUSED,
  refusedCall,
} from './client-plans.ts';
import { trackedPool } from './client-pool.ts';
import { endsTransaction, rollsBack, sentToPostgres, TransactionWrites } from './client-writes.ts';
import type { Followed } from './keys.ts';
import { boundOf } from './serialized.ts';

/**
 * A PGlite connection, as the application's Drizzle queries through it, whose queries in a render
 * note what they read: before a render's statement runs, its plan names the tables it reads, and
 * the render depends on each — any change the log tells of one renders it again. Outside a render —
 * a server operation, the host's migrations — a query runs as it would have. In a render, a
 * statement that is no query, a plan that writes, and a table nothing follows are faults: what the
 * render would read could change without the log telling of it. So is any method of the
 * connection but `query` and `transaction`, which Drizzle runs a render's SQL through: `exec`,
 * `sql`, the raw protocol, `listen`, `describeQuery`, a `clone` — each runs SQL no plan is asked of,
 * or off the connection's turn. A `pg` pool is followed alike (`client-pool.ts`).
 *
 * A server operation's statements that may write are told to it as they go (`client-writes.ts`):
 * outside a transaction each ends as it is answered; in one, all end as `transaction` does — as it
 * commits, or as the code's own throw, or `rollback`, rolls it back.
 */

/**
 * What each method that runs a text writes before it: nothing of `exec` and `query`, and of `listen`
 * and `unlisten` the command PGlite writes their channel after, as it is.
 */
const STATEMENTS: ReadonlyMap<PropertyKey, string> = new Map([
  ['exec', ''],
  ['listen', 'LISTEN '],
  ['query', ''],
  ['unlisten', 'UNLISTEN '],
]);

/**
 * Whether a query's options bind its values otherwise than PostgreSQL types them in the plan of no
 * values: of types of their own (`paramTypes`), or by text of their own (`serializers`), as PGlite
 * takes them. No condition of such a query's values is followed.
 */
function rebinds(options: unknown): boolean {
  return (
    typeof options === 'object' &&
    options !== null &&
    (Reflect.get(options, 'paramTypes') !== undefined ||
      Reflect.get(options, 'serializers') !== undefined)
  );
}

/**
 * `connection`, a PGlite or one of its transactions, its queries in a render noted by `plans`; of a
 * transaction, `writes` ends what an operation's statements in it write.
 */
function tracked<C extends Connection>(connection: C, plans: Plans, writes?: TransactionWrites): C {
  const transaction = writes !== undefined;
  let client = connection;
  const planner: Planner = {
    owner: connection,
    check: async (explain, values) => {
      const nulls = Array.isArray(values) ? values.map(() => null) : [];
      try {
        await called(connection, 'query', [explain, nulls]);
      } catch (error) {
        if (transaction || REFUSED.has(String(codeOf(error)))) {
          throw error;
        }
      }
    },
    // The catalog's statement goes first: the plan's text ends with the application's, whose
    // comment would else take in what came after it.
    plan: async (explain, catalog) => {
      const text = catalog === undefined ? explain : `${catalog}; ${explain}`;
      return answerOf(await called(connection, 'exec', [text]), catalog);
    },
  };
  /** A method a render may not call: a fault of the render's, whatever its code does with it. */
  const outside = (name: PropertyKey, args: readonly unknown[]): unknown => {
    const sql = args[0];
    const opening = STATEMENTS.get(name);
    const text = typeof sql === 'string' && opening !== undefined;
    const raw = name === 'sql' || (typeof name === 'string' && name.startsWith('execProtocol'));
    const answered = () => retainedReceiver(called(connection, name, args), connection, client);
    // A transaction's `rollback` leaves nothing it wrote, whatever it answers, unless a text of the
    // code's own committed it before (`COMMIT`, `END`), which no throw of the callback undoes.
    if (name === 'rollback') writes?.undone();
    if (writes !== undefined && opening === '' && typeof sql === 'string') {
      // A transaction's options and savepoints end nothing, nor does a rollback to one.
      if (rollsBack(sql)) writes.undone();
      else if (endsTransaction(sql)) writes.endedUnseen();
    }
    const run = () => sentToPostgres(name, args, answered, writes);
    if (name === 'execProtocolRawSync') return plans.outsideContextNow(run);
    return raw || (text && plans.observesContext(`${opening}${sql}`))
      ? plans.outsideContext(run)
      : run();
  };
  const refusedInRender = (name: PropertyKey) => {
    return (...args: unknown[]): unknown => {
      const noted = tableReads();
      if (noted === undefined) return outside(name, args);
      return refusalOf(
        noted(() => refusedCall(name)),
        name,
        args,
      );
    };
  };
  const wrapped: Readonly<Record<string, unknown>> = {
    query: async (sql: unknown, ...rest: unknown[]) => {
      const noted = tableReads();
      if (
        noted !== undefined &&
        !(transaction && typeof sql === 'string' && OWN.some((form) => form.test(sql)))
      ) {
        await noted(() => {
          if (typeof sql !== 'string') {
            return Promise.reject(new TypeError('A render queries by the text of its statement.'));
          }
          return plans.readsOf(sql, rest[0], planner, rebinds(rest[1]));
        });
      }
      return noted === undefined
        ? outside('query', [sql, ...rest])
        : called(connection, 'query', [sql, ...rest]);
    },
    transaction: (body: unknown, ...rest: unknown[]) => {
      const held = new TransactionWrites();
      // What the code threw, which PGlite rolls the transaction back of before it throws it on.
      let thrown: { readonly error: unknown } | undefined;
      const run =
        typeof body === 'function'
          ? async (opened: Connection): Promise<unknown> => {
              try {
                const answered: unknown = await Reflect.apply(body, undefined, [
                  tracked(opened, plans, held),
                ]);
                held.committing();
                return answered;
              } catch (error) {
                thrown = { error };
                throw error;
              }
            }
          : body;
      const call = () => {
        return held.through(
          called(connection, 'transaction', [run, ...rest]),
          (error) => thrown !== undefined && thrown.error === error,
        );
      };
      return tableReads() === undefined ? plans.outsideTransaction(call) : call();
    },
  };
  const guarded = guardedObjects((name) => refusedCall(name));
  // PGlite's own promise of its start, which no statement answers. No other promise is known so:
  // what holds one says nothing of when it started, or whether a render started it.
  client = facadeOf(connection, wrapped, refusedInRender, (value, key) =>
    key === 'waitReady' ? value : guarded(value, String(key)),
  );
  return client;
}

/**
 * `connection`, a PGlite or a `pg` pool the application's Drizzle is given, whose renders note what
 * they read of `followed`'s tables: the same connection, by its own type, for `drizzle({ client })`.
 */
export function trackedClient<C extends Connection>(connection: C, followed: Followed): C {
  if (typeof Reflect.get(connection, 'exec') !== 'function') {
    return trackedPool(connection, followed);
  }
  return tracked(connection, new Plans(followed, boundOf(connection)));
}

export { type Connection } from './client-plans.ts';
