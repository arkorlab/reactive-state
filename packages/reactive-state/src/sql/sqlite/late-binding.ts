import type { ExternalChanges, ExternalStore } from '../../authority/external.ts';
import { tableReads } from '../../server/context.ts';
import type { D1Binding } from './client.ts';
import { type FollowedSqliteStore, readBySql, sqliteStore } from './store.ts';

/**
 * A D1 binding of a function that answers the binding of now, or none: what a follow is given where
 * its binding arrives only as its host starts — a Durable Object's, of the environment its
 * constructor is given — and the follow's own store of it. The binding asks the function at each
 * call of one of D1's methods (`prepare`, `batch`, `exec`, `withSession`, `dump`) and calls that
 * method of what it answered, as D1's own are called of their binding: of none, the call throws,
 * naming the store, and a render that made it fails, whatever its code does with the error, so
 * that no answer of it outlasts the binding's arrival; what the function throws, the call throws,
 * and a render that made it fails the same way.
 * The store asks it at each read of the log: of none, it reads nothing and tells of no change, of
 * an epoch no log of D1's has; of a binding, it reads the log through it by a store of that
 * binding's own (`store.ts`), so that the digest of a schema and the epoch a store keeps are of one
 * database alone; a binding made anew at each call is a store anew at each read, which reads the
 * schema each time. A binding answered once none was is another log to the authority, which
 * renders again whatever read the store's tables.
 */

/** What answers the D1 binding of now, or none — `undefined` or `null` — while there is none. */
export type BindingOfNow<B extends D1Binding = D1Binding> = () => B | null | undefined;

/** D1's methods, which the binding of a function holds and calls of the binding of now. */
type D1Method = 'batch' | 'dump' | 'exec' | 'prepare' | 'withSession';

/**
 * The binding of a function that answers bindings of `B`'s: D1's methods of `B`'s, and nothing
 * else of it — of a Worker's `D1Database`, all of it.
 */
export type ForwardedD1<B extends D1Binding> = Pick<B, Extract<keyof B, D1Method>>;

/**
 * The page of the log of no binding: no change, ever, of an epoch no D1 log's is — each of those
 * holds a `:` (`store.ts`).
 */
const UNCONNECTED: ExternalChanges = Object.freeze({
  changes: Object.freeze([]),
  epoch: 'unconnected',
  floor: 0,
  head: 0,
});

/**
 * Throws `thrown` as a fault of the render that made the call, where a render did — noted as a
 * refused statement's is (`client.ts`), as the call threw before the render could note what it
 * read: an answer its code made of the error would be kept, and not rendered again once the binding
 * arrives — and as it is outside one.
 */
function faulted(thrown: unknown): never {
  const note = tableReads();
  if (note !== undefined) {
    const reason = thrown instanceof Error ? thrown : new Error(String(thrown));
    const fault = (): Promise<never> => Promise.reject(reason);
    void note(fault).catch(() => {
      // Noted as the render's: the call's own answer is the error.
    });
  }
  throw thrown;
}

/** What a call of a binding whose function answered none comes to: a fault, naming the store. */
function unconnected(storeName: string): never {
  return faulted(
    new Error(
      `The store \`${storeName}\` reads and writes D1 through the binding that the function given to \`follow.client\` answers, and it answered none: connect the binding before a statement runs — a Durable Object's, of its environment, in its constructor.`,
    ),
  );
}

/**
 * What the method `name` of `binding` answers of `args`, called of the binding, as D1's own methods
 * are: a fault of a binding that has no such method.
 */
function called(binding: D1Binding, name: string, args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(binding, name);
  if (typeof method !== 'function') {
    throw new TypeError(
      `The binding that the function given to \`follow.client\` answered has no D1 method \`${name}\`.`,
    );
  }
  return Reflect.apply(method as (...given: unknown[]) => unknown, binding, args);
}

/** Whether `given`, what a follow's `client` was given, is a function that answers a binding. */
export function isBindingOfNow<B extends D1Binding>(
  given: B | BindingOfNow<B>,
): given is BindingOfNow<B> {
  return typeof given === 'function';
}

/**
 * The binding of `current`, for the follow of the store `storeName`: each of D1's methods asks it
 * for the binding of now as it is called, and calls that one's. A method D1 answers a promise of
 * rejects, as D1's does, rather than throws.
 */
export function lateD1<B extends D1Binding>(
  current: BindingOfNow<B>,
  storeName: string,
): ForwardedD1<B> {
  const now = (): B => {
    let binding: B | null | undefined;
    try {
      binding = current();
    } catch (error) {
      // What the function throws, the call throws: a fault of the render that made it as well.
      return faulted(error);
    }
    return binding ?? unconnected(storeName);
  };
  const answered = async (name: string, args: readonly unknown[]): Promise<unknown> => {
    const answer: unknown = await called(now(), name, args);
    return answer;
  };
  // Not frozen: the follow's client is a Proxy of it (`trackedD1`), which answers a `prepare` and a
  // `batch` of its own, as a Proxy may not of an object's own method that is frozen.
  const late = {
    batch: async (statements: unknown[]) => now().batch(statements),
    dump: async () => answered('dump', []),
    exec: async (sql: string) => answered('exec', [sql]),
    prepare: (sql: string) => now().prepare(sql),
    withSession: (...args: unknown[]) => called(now(), 'withSession', args),
  };
  return late as unknown as ForwardedD1<B>;
}

/**
 * The store of the tables `followed` names, whose log is read through the binding `current`
 * answers at each read: of none, no change, read of nothing; of a binding, what a store of its own
 * reads — of the binding the read before was of, the same store; of another, or of one it comes
 * back to, a store made anew. A store brings the follow's plans to its database's schema as it
 * first reads it (`store.ts`), and one kept of a binding left would not read it again on the way
 * back: the plans would stay of the schema read in between.
 */
function lateStore(current: BindingOfNow, followed: FollowedSqliteStore): ExternalStore {
  let last: { readonly binding: D1Binding; readonly store: ExternalStore } | undefined;
  return {
    changes: async (since, limit) => {
      const binding = current() ?? undefined;
      if (binding === undefined) return UNCONNECTED;
      if (last?.binding !== binding) last = { binding, store: sqliteStore(binding, followed) };
      return last.store.changes(since, limit);
    },
    count: (table) => readBySql(table.name),
    find: (table) => readBySql(table.name),
    get: (table) => readBySql(table.name),
  };
}

/**
 * The follow's own store of the tables `followed` names, of what its `client` was last given,
 * `given`: of a binding, a store that reads the log through it; of a function, one that asks it at
 * each read; none of nothing.
 */
export function ownStoreOf(
  given: D1Binding | BindingOfNow | undefined,
  followed: FollowedSqliteStore,
): ExternalStore | undefined {
  if (given === undefined) return undefined;
  return isBindingOfNow(given) ? lateStore(given, followed) : sqliteStore(given, followed);
}
