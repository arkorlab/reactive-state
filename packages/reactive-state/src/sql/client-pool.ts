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
import type { Followed } from './keys.ts';
import { boundOf } from './serialized.ts';

/**
 * A `pg.Pool`, as the application's Drizzle queries through it, whose queries in a render note what
 * they read, as a PGlite's do (`client.ts`). A pool and not a `pg.Client`: Drizzle opens a transaction
 * on the connection it is given, and a client is one session, in which a concurrent render would
 * read what that transaction has not committed. A pool gives each transaction a connection of its
 * own.
 *
 * `pg` differs in what a text can do. It sends a text of no values by the simple protocol, which
 * runs a text of several statements, so a plan is checked by the extended protocol, whatever the
 * text's values. It takes a statement as an object, read here once, and answers a callback and a
 * submittable beside it, which a render may not use: neither says when what it read arrived. And
 * a setting changed on a pool reaches one connection of many, which the plans of every other
 * connection were not asked under, so a text that changes one is refused there. A checked-out
 * connection may change its own, as a transaction does; of what it changes beyond that — a `SET`
 * not `LOCAL`, a `set_config` of a session's — it is closed as it is given back, and no render
 * plans a statement through it. Nor does one through it while its open transaction holds a setting
 * of its own (`SET LOCAL`, `set_config(…, true)`): the plans of the pool were not asked under it,
 * and one asked under it would be read by every other connection. It is read again once the
 * transaction ends.
 *
 * A render may settle while a transaction it opened runs on. What opens and ends one reads nothing
 * and runs regardless, so Drizzle's `rollback` still ends it, and a connection given back in one is
 * closed: the next to take it would write into a transaction no one will commit.
 */

/** What a checked-out connection's transaction opens and ends with, in the forms Drizzle writes. */
const TRANSACTION: readonly RegExp[] = [
  ...OWN,
  /^\s*begin(?:\s+[a-z]+)*\s*$/iu,
  /^\s*(?:commit|rollback)\s*$/iu,
];

/**
 * The classes of SQLSTATE a check answers only of a text PostgreSQL took as one statement: of what
 * it reads of the statement, and what a plan of nulls may be refused. Any other — a connection lost,
 * none to be had, a server shutting down, a statement canceled — says nothing of the text, which
 * `plan` would send by the simple protocol, on a connection that may answer.
 */
const PARSED = ['22', '42', 'P0'] as const;

/** What a `pg` connection says of itself between transactions. */
const IDLE = 'I';

/** A statement as `pg` was given it: its text, its values, and what runs them as they were read. */
interface Statement {
  readonly text: string;
  readonly values: unknown;
  /** Whether it types its values itself: `pg` sends an array of `types` as their oids. */
  readonly rebound: boolean;
  readonly run: readonly unknown[];
}

/** A `pg` connection a render may hold: a pool, or a connection it checked out. */
type PoolConnection = Connection;

/** What `first` and `rest`, as `query` was called, say of a callback, or of an object's own. */
function callbackOf(first: unknown, rest: readonly unknown[]): unknown {
  const beside = rest.find((each) => typeof each === 'function');
  if (beside !== undefined || typeof first !== 'object' || first === null) return beside;
  return Reflect.get(first, 'callback');
}

/**
 * The statement `query` was called with, read once, as `pg` reads it: the values beside a text or an
 * object before an object's own. Nothing of a callback, of a submittable, or of no text: a render
 * awaits what it read. What runs is the copy, of values, whatever a getter would answer next.
 */
function statementOf(first: unknown, rest: readonly unknown[]): Statement | undefined {
  if (rest.some((each) => typeof each === 'function')) return undefined;
  const object = typeof first === 'object' && first !== null;
  const config: Readonly<Record<string, unknown>> = object ? { ...first } : { text: first };
  const { callback, submit, text, types } = config;
  // Of the object as well: a `Query` holds `submit` of its class, which no copy reads.
  const held: readonly unknown[] = object
    ? [Reflect.get(first, 'callback'), Reflect.get(first, 'submit')]
    : [];
  if ([callback, submit, ...held].some((each) => typeof each === 'function')) return undefined;
  if (typeof text !== 'string') return undefined;
  const given: unknown = rest[0] ?? config['values'];
  const values: unknown = Array.isArray(given) ? [...(given as unknown[])] : given;
  const rebound =
    typeof types === 'object' && typeof Reflect.get(types ?? {}, 'length') === 'number';
  return { rebound, run: [{ ...config, text, values }], text, values };
}

/** The text `first` holds, as a string or an object's, to read what it would do. */
function textOf(first: unknown): unknown {
  return typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : first;
}

/**
 * That a pool does not run `sql`, which would change one connection of many, answered as `pg`
 * answers a fault of a call of the form of `first` and `rest`.
 */
function sessionRefused(first: unknown, rest: readonly unknown[], sql: string): unknown {
  const refusal = new Error(
    `A pool runs a statement on one connection of many, which this would change alone: give every connection its settings as it connects, or set them in a transaction of a checked-out connection: ${sql}`,
  );
  const callback = callbackOf(first, rest);
  if (typeof callback !== 'function') return Promise.reject(refusal);
  queueMicrotask(() => {
    Reflect.apply(callback, undefined, [refusal]);
  });
  return undefined;
}

/** Whether `connection`, one a pool checked out, is in a transaction: of a `pg` that says not, it may be. */
function inTransaction(connection: PoolConnection): boolean {
  const status: unknown = Reflect.get(connection, 'getTransactionStatus');
  return typeof status !== 'function' || Reflect.apply(status, connection, []) !== IDLE;
}

/**
 * What a checked-out connection does of an `error` event: the statement it ended answers it, and of
 * no listener `pg` would throw it at the process, the authority's. The pool listens of an idle one.
 */
function heard(): void {
  // Nothing more to tell.
}

/** Why a render queries through no connection whose settings were changed: its plans were not asked under them. */
function settingsRefused(): Promise<never> {
  return Promise.reject(
    new Error(
      'A render queries through no checked-out connection whose settings were changed — beyond a transaction, or for the transaction still open — which the plans of the pool were not asked under: give every connection its settings as it connects, or query once the transaction has ended.',
    ),
  );
}

/** `connection`, a pool or one it checked out, its queries in a render noted by `plans`. */
function tracked<C extends PoolConnection>(connection: C, plans: Plans, checkedOut: boolean): C {
  let client = connection;
  const planner: Planner = {
    owner: connection,
    check: async (explain, values) => {
      const nulls = Array.isArray(values) ? values.map(() => null) : [];
      try {
        await called(connection, 'query', [
          { queryMode: 'extended', text: explain, values: nulls },
        ]);
      } catch (error) {
        const code = String(codeOf(error));
        const parsed = PARSED.some((kind) => code.startsWith(kind));
        // A refusal aborts a transaction, of which the render's statement would say no more.
        if (!parsed || REFUSED.has(code) || (checkedOut && inTransaction(connection))) throw error;
      }
    },
    // By the simple protocol, of no values, which answers each statement of the text: a generic
    // plan takes none, and `check` has held the application's text to one statement.
    plan: async (explain, catalog) => {
      const text = catalog === undefined ? explain : `${catalog}; ${explain}`;
      const answered: unknown = await called(connection, 'query', [text]);
      return answerOf(Array.isArray(answered) ? answered : [answered], catalog);
    },
  };
  /** Whether a statement of this checked-out connection changed its settings beyond a transaction. */
  let changed = false;
  /** Whether a statement of it set a setting for its transaction, which may be open still. */
  let scoped = false;
  /** Whether a setting of this connection's differs from those the plans of the pool were asked under. */
  const unplanned = (): boolean => {
    // The transaction's own settings end with it.
    if (scoped && !inTransaction(connection)) scoped = false;
    return changed || scoped;
  };
  const outside = (name: PropertyKey, args: readonly unknown[]): unknown =>
    retainedReceiver(called(connection, name, args), connection, client);
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
  type Noted = NonNullable<ReturnType<typeof tableReads>>;
  const rendered = async (noted: Noted, statement: Statement | undefined) => {
    if (statement === undefined) {
      await noted(() => {
        return Promise.reject(
          new TypeError(
            'A render queries by the text of its statement and awaits the answer: no callback, and no object that submits itself.',
          ),
        );
      });
      return;
    }
    const { rebound, run, text, values } = statement;
    await noted(() => plans.readsOf(text, values, planner, rebound));
    return called(connection, 'query', run);
  };
  const query = (first: unknown, ...rest: unknown[]): unknown => {
    const statement = statementOf(first, rest);
    if (
      checkedOut &&
      statement !== undefined &&
      TRANSACTION.some((form) => form.test(statement.text))
    ) {
      return called(connection, 'query', statement.run);
    }
    let noted: ReturnType<typeof tableReads>;
    try {
      noted = tableReads();
    } catch (error) {
      const settled: Error = error as Error;
      return refusalOf(Promise.reject(settled), 'query', [first, ...rest]);
    }
    if (noted !== undefined) {
      if (!unplanned()) return rendered(noted, statement);
      return refusalOf(
        noted(() => settingsRefused()),
        'query',
        [first, ...rest],
      );
    }
    const text = textOf(first);
    if (checkedOut && typeof text === 'string') {
      if (plans.leavesSession(text)) changed = true;
      else if (plans.changesOneSession(text)) scoped = true;
    }
    if (!checkedOut && typeof text === 'string' && plans.changesOneSession(text)) {
      return sessionRefused(first, rest, text);
    }
    return outside('query', [first, ...rest]);
  };
  const checkOut = async (args: readonly unknown[]): Promise<PoolConnection> =>
    tracked((await called(connection, 'connect', args)) as PoolConnection, plans, true);
  const connect = (...args: unknown[]): unknown => {
    const [callback] = args;
    if (typeof callback !== 'function') return checkOut(args);
    const noted = tableReads();
    if (noted !== undefined) {
      return refusalOf(
        noted(() => refusedCall('connect')),
        'connect',
        args,
      );
    }
    return called(connection, 'connect', [
      (error: unknown, held: PoolConnection | undefined, done: unknown): unknown => {
        if (held === undefined) return Reflect.apply(callback, undefined, [error, held, done]);
        const answered = tracked(held, plans, true);
        const release: unknown = Reflect.get(answered, 'release');
        return Reflect.apply(callback, undefined, [error, answered, release]);
      },
    ]);
  };
  const release = (...given: unknown[]): unknown => {
    // What it changed of its settings is not for the next to take it: it is closed.
    const args = changed ? [true] : given;
    called(connection, 'removeListener', ['error', heard]);
    return called(connection, 'release', inTransaction(connection) ? [true] : args);
  };
  if (checkedOut) called(connection, 'on', ['error', heard]);
  const guarded = guardedObjects((name) => refusedCall(name));
  client = facadeOf(
    connection,
    checkedOut ? { query, release } : { connect, query },
    refusedInRender,
    (value, key) => guarded(value, String(key)),
  );
  return client;
}

/**
 * `pool`, a `pg.Pool` the application's Drizzle is given, whose renders note what they read of
 * `followed`'s tables; a fault of a connection of one session.
 */
export function trackedPool<C extends Connection>(pool: C, followed: Followed): C {
  const isPool =
    typeof Reflect.get(pool, 'connect') === 'function' &&
    typeof Reflect.get(pool, 'totalCount') === 'number';
  if (!isPool) {
    throw new TypeError(
      '`follow.client` is given a PGlite or a `pg.Pool`: one `pg.Client` is one session, in which a transaction of the application would hold what every render reads. The store may read through a client of its own.',
    );
  }
  return tracked(pool, new Plans(followed, boundOf(pool)), false);
}
