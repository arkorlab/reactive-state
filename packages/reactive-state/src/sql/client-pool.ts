import { tableReads } from '../server/context.ts';
import {
  callbackOf,
  facadeOf,
  guardedObjects,
  refusalOf,
  retainedReceiver,
} from './client-objects.ts';
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
import { endsTransaction, sentToPostgres, textOf, TransactionWrites } from './client-writes.ts';
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
 * plans a statement through it.
 *
 * A render may settle while a transaction it opened runs on. What opens and ends one reads nothing
 * and runs regardless, so Drizzle's `rollback` still ends it, and a connection given back in one is
 * closed: the next to take it would write into a transaction no one will commit.
 *
 * A server operation's statements that may write are told to it as they go (`client-writes.ts`):
 * outside a transaction each ends as it is answered; in one a checked-out connection opens, all
 * end as it does — as its `COMMIT` answers, or as `ROLLBACK`, or a connection given back in it,
 * leaves them unwritten.
 */

/** What opens a checked-out connection's transaction, and ends it, in the forms Drizzle writes. */
const BEGIN = /^\s*begin(?:\s+[a-z]+)*\s*$/iu;
const COMMIT = /^\s*commit\s*$/iu;
const ROLLBACK = /^\s*rollback\s*$/iu;
/** What a checked-out connection's transaction runs of its own: what opens and ends it, too. */
const TRANSACTION: readonly RegExp[] = [...OWN, BEGIN, COMMIT, ROLLBACK];

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

/** What `connection`, one a pool checked out, says of its transaction: nothing, of a `pg` that says not. */
function statusOf(connection: PoolConnection): unknown {
  const status: unknown = Reflect.get(connection, 'getTransactionStatus');
  return typeof status === 'function' ? Reflect.apply(status, connection, []) : undefined;
}

/** Whether `connection`, one a pool checked out, is in a transaction: of a `pg` that says not, it may be. */
function inTransaction(connection: PoolConnection): boolean {
  return statusOf(connection) !== IDLE;
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
      'A render queries through no checked-out connection whose settings were changed beyond a transaction, which the plans of the pool were not asked under: give every connection its settings as it connects.',
    ),
  );
}

/** `connection`, a pool or one it checked out, its queries in a render noted by `plans`. */
function tracked<C extends PoolConnection>(connection: C, plans: Plans, checkedOut: boolean): C {
  let client = connection;
  /** What an operation's statements wrote in the transaction this connection opened, if one is open. */
  let writes: TransactionWrites | undefined;
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
  /**
   * `statement`, one of the transaction's own, run: what opens one opens what its statements write,
   * and what ends one ends that — a `COMMIT` of what wrote is a write of its own, which an operation
   * that sends no more refuses, and which the code then rolls back. A `COMMIT` of a transaction this
   * did not see open — of a form Drizzle does not write — is told to the operation as a write.
   */
  const transacted = (statement: Statement): unknown => {
    const run = () => called(connection, 'query', statement.run);
    if (BEGIN.test(statement.text)) {
      // A transaction whose end went unseen (`END`, `COMMIT AND CHAIN`) may have written.
      writes?.ended('unknown');
      writes = new TransactionWrites();
    }
    if (ROLLBACK.test(statement.text)) {
      writes?.undone();
      writes = undefined;
    }
    if (!COMMIT.test(statement.text)) return run();
    const held = writes;
    if (held === undefined) return sentToPostgres('query', statement.run, run);
    try {
      held.committing();
    } catch (error) {
      const refused: Error = error as Error;
      return Promise.reject(refused);
    }
    writes = undefined;
    return held.through(run(), () => false);
  };
  const query = (first: unknown, ...rest: unknown[]): unknown => {
    const statement = statementOf(first, rest);
    if (
      checkedOut &&
      statement !== undefined &&
      TRANSACTION.some((form) => form.test(statement.text))
    ) {
      return transacted(statement);
    }
    let noted: ReturnType<typeof tableReads>;
    try {
      noted = tableReads();
    } catch (error) {
      const settled: Error = error as Error;
      return refusalOf(Promise.reject(settled), 'query', [first, ...rest]);
    }
    if (noted !== undefined) {
      if (!changed) return rendered(noted, statement);
      return refusalOf(
        noted(() => settingsRefused()),
        'query',
        [first, ...rest],
      );
    }
    const text = textOf(first);
    if (checkedOut && typeof text === 'string' && plans.leavesSession(text)) changed = true;
    if (!checkedOut && typeof text === 'string' && plans.changesOneSession(text)) {
      return sessionRefused(first, rest, text);
    }
    const args = [first, ...rest];
    if (checkedOut && typeof text === 'string' && endsTransaction(text)) writes?.endedUnseen();
    return sentToPostgres('query', args, () => outside('query', args), writes);
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
    // Closed in its transaction, the connection leaves nothing of it; one that ended unseen may have.
    const status = statusOf(connection);
    const closedIn = typeof status === 'string' && status !== IDLE;
    if (closedIn) writes?.undone();
    else writes?.ended('unknown');
    writes = undefined;
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
