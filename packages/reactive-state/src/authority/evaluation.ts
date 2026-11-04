import type { User } from '../program.ts';
import { type Evaluation, evaluate } from '../server/context.ts';
import type { Dependencies } from './dependencies.ts';
import { asRefusal, isAuthorityError } from './errors.ts';
import { countIn, findIn, getIn, type Reader, readTablesIn, type Tables } from './tables.ts';
import type { Transaction } from './transaction.ts';

/**
 * How the authority runs the application's code — a page's components as it renders them, the
 * components a write replays, a server operation — and what that code's `db` and `requireUser` are
 * answered with while it runs.
 *
 * Only the authority's refusals keep their status: `forbidden()`'s, the session's own that
 * `requireUser` throws, and those the database's writes make (a record not found, a value a field
 * cannot hold, a `unique` group held twice), of whichever copy of the package. A read or a write
 * that failed otherwise — a storage error, a query of a field the table does not declare, a write
 * outside a transaction — makes the call's outcome that fault, whatever the code did with it:
 * caught, it would otherwise become a refusal, or an answer read wrong. A call still running after
 * its time is a fault as well, and the authority's queue moves on without it: what its code reads
 * after that is refused.
 */

/** How long a call may run unless the authority is told otherwise. */
const CALL_TIMEOUT_MS = 5000;
/** The longest wait a timer takes: a longer one would fire at once. */
const LONGEST_TIMER_MS = 2_147_483_647;

/** How long a call may run, as the authority was told: a wait a timer can take. */
export function timeoutOf(milliseconds: number | undefined): number {
  if (milliseconds === undefined) {
    return CALL_TIMEOUT_MS;
  }
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > LONGEST_TIMER_MS) {
    throw new TypeError(
      `A call's timeout is a number of milliseconds above 0 and up to ${String(LONGEST_TIMER_MS)}.`,
    );
  }
  return milliseconds;
}

/**
 * One call of the engine's that runs the application's code: its time, and the fault its reads
 * and writes raised, if one did. It is open until it is closed, or its time is up.
 */
export class Call {
  readonly #what: string;
  readonly #timer: ReturnType<typeof setTimeout>;
  /** What ends each run under way when the call's time is up. */
  readonly #running = new Set<(error: Error) => void>();
  #open = true;
  #fault: { readonly error: unknown } | undefined;
  #timedOut: Error | undefined;
  /** What the call's code read that makes its answer the request's: none until it reads one. */
  #requestBound: string | undefined;
  /**
   * How many reads of the call's code made its answer the request's, and the last of them: what one
   * part of the call read of the request since a mark (`boundSince`).
   */
  #boundReads = 0;
  #lastBound: string | undefined;

  constructor(what: string, timeoutMs: number) {
    this.#what = what;
    this.#timer = setTimeout(() => {
      const error = new Error(
        `${what} did not settle within ${String(timeoutMs)} ms: it holds the authority's one queue, which every request waits in.`,
      );
      this.#fault ??= { error };
      this.#timedOut = error;
      this.#open = false;
      for (const end of this.#running) {
        end(error);
      }
    }, timeoutMs);
  }

  #stillOpen(): void {
    if (!this.#open) {
      throw new Error(
        `${this.#what} was read after it had settled, or timed out: nothing answers it now.`,
      );
    }
  }

  async #awaited<V>(pending: Promise<V>): Promise<V> {
    try {
      const value = await pending;
      this.#stillOpen();
      return value;
    } catch (error) {
      if (!isAuthorityError(error)) {
        this.#fault ??= { error };
      }
      throw error;
    }
  }

  /** The fault the call's reads and writes raised: its outcome, whatever its code did. */
  get fault(): { readonly error: unknown } | undefined {
    return this.#fault;
  }

  /** Answers one read or write of the call's code, noting a fault it raises. */
  answer<T>(read: () => T): T {
    this.#stillOpen();
    try {
      const answered = read();
      // An external table's store answers in time: what it fails with is the call's fault as well,
      // and an answer that comes after the call settled is none.
      return answered instanceof Promise ? (this.#awaited(answered) as T) : answered;
    } catch (error) {
      if (!isAuthorityError(error)) {
        this.#fault ??= { error };
      }
      throw error;
    }
  }

  /**
   * What the call's code read that only the request answers — the session's identity, an input
   * nothing tracks — where it read one. It stays read whatever the code did next: a render that
   * caught the refusal it was answered with is the request's all the same.
   */
  get requestBound(): string | undefined {
    return this.#requestBound;
  }

  /** Notes that the call's code read `what`, which makes its answer the request's. */
  boundToRequest(what: string): void {
    this.#requestBound ??= what;
    this.#boundReads += 1;
    this.#lastBound = what;
  }

  /** A mark of what the call's code read of the request so far, for `boundSince` to read past. */
  get boundMark(): number {
    return this.#boundReads;
  }

  /**
   * What the call's code read that only the request answers since `mark` (`boundMark`) — the last
   * of it — or nothing where it read none since: what one component's rendering read of the request,
   * the components it renders included, which the memo keeps with it (`MemoEntry.requestBound`).
   */
  boundSince(mark: number): string | undefined {
    return this.#boundReads > mark ? this.#lastBound : undefined;
  }

  /** Notes `error`, a fault of the code's, as the call's outcome, and answers it to be thrown. */
  faulted(error: Error): Error {
    this.#fault ??= { error };
    return error;
  }

  /** Runs the application's `body` in `evaluation`, within the call's time. */
  async run<T>(evaluation: Evaluation, body: () => Promise<T>): Promise<T> {
    if (this.#timedOut !== undefined) {
      throw this.#timedOut;
    }
    const { promise, reject } = Promise.withResolvers<never>();
    this.#running.add(reject);
    try {
      return await Promise.race([evaluate(evaluation, body), promise]);
    } finally {
      this.#running.delete(reject);
    }
  }

  /**
   * What the call's code threw, as the call answers it: the fault its reads raised, where one did;
   * a refusal of any copy of the package as this copy's; anything else as it is.
   */
  outcome(thrown: unknown): unknown {
    return this.#fault === undefined ? asRefusal(thrown) : this.#fault.error;
  }

  close(): void {
    this.#open = false;
    clearTimeout(this.#timer);
  }
}

/** What every evaluation of one call shares: the call, the records, and the session's user. */
export interface Scope {
  readonly call: Call;
  readonly tables: Tables;
  /** The session's user, while the session lasts: the authority's refusal (401) once it ends. */
  readonly user: () => User;
  /** The session's user, or `null` for a call of none; the session's, where not given. */
  readonly optionalUser?: () => User | null;
  /**
   * Whether the call renders what every visitor is to share: then nothing it reads of the request
   * is answered, and the call is the request's from the read on (`Call.requestBound`).
   */
  readonly shared?: boolean;
  /** Told of each read of the database the call's code makes: what counts them, where anything does. */
  readonly onRead?: () => void;
}

/** The fault of code that asked the database for what it may not ask for there. */
function misuse(scope: Scope, what: string, why: string): Error {
  return scope.call.faulted(new Error(`${what}: ${why}`));
}

/** What a call reads with: the reader, and what is told of each query it runs, where anything is. */
function reads(
  scope: Scope,
  reader: Reader,
  queried?: () => void,
): Pick<Evaluation, 'count' | 'findMany' | 'get' | 'optionalUser' | 'shared' | 'user'> {
  return {
    count: (table, query) => {
      queried?.();
      scope.onRead?.();
      return scope.call.answer(() => countIn(reader, table, query));
    },
    findMany: (table, query) => {
      queried?.();
      scope.onRead?.();
      return scope.call.answer(() => findIn(reader, table, query));
    },
    get: (table, id) => {
      scope.onRead?.();
      return scope.call.answer(() => getIn(reader, table, id));
    },
    optionalUser: () => scope.call.answer(scope.optionalUser ?? scope.user),
    shared: scope.shared === true ? scope.call : undefined,
    user: () => scope.call.answer(scope.user),
  };
}

/**
 * What a component reads as it renders, or as a write replays it: the committed records, each read
 * noted in `track` where the render is followed, each query it runs told to `queried`. It writes
 * nothing, nor opens a transaction.
 */
export function renderEvaluation(
  scope: Scope,
  track: Dependencies | undefined,
  queried?: () => void,
): Evaluation {
  const why =
    'a component writes nothing as it renders; a server operation does, in its transaction';
  const reader: Reader = { source: scope.tables, tables: scope.tables, track };
  return {
    ...reads(scope, reader, queried),
    delete: (table) => {
      throw misuse(scope, `db.${table}.delete`, why);
    },
    insert: (table) => {
      throw misuse(scope, `db.${table}.insert`, why);
    },
    readTables: (answered) => {
      queried?.();
      scope.onRead?.();
      return scope.call.answer(async () => {
        readTablesIn(reader, await answered());
      });
    },
    transaction: () => Promise.reject(misuse(scope, 'db.transaction', why)),
    update: (table) => {
      throw misuse(scope, `db.${table}.update`, why);
    },
  };
}

/**
 * What a server operation reads and writes outside its transaction: the committed records, noted
 * nowhere — nothing renders an operation again — and no write: those are made in `transaction`.
 */
export function operationEvaluation(
  scope: Scope,
  transaction: <T>(body: () => Promise<T>) => Promise<T>,
): Evaluation {
  const why = 'a server operation writes in its transaction, `db.transaction(async () => …)`';
  return {
    ...reads(scope, { source: scope.tables, tables: scope.tables, track: undefined }),
    delete: (table) => {
      throw misuse(scope, `db.${table}.delete`, why);
    },
    insert: (table) => {
      throw misuse(scope, `db.${table}.insert`, why);
    },
    transaction,
    update: (table) => {
      throw misuse(scope, `db.${table}.update`, why);
    },
  };
}

/**
 * What an operation's transaction reads and writes: its reads see its writes, and its writes wait
 * in it. It opens no other transaction inside it.
 */
export function transactionEvaluation(scope: Scope, transaction: Transaction): Evaluation {
  return {
    ...reads(scope, { source: transaction, tables: scope.tables, track: undefined }),
    delete: (table, id) => {
      scope.call.answer(() => {
        transaction.delete(table, id);
      });
    },
    insert: (table, fields) => scope.call.answer(() => transaction.insert(table, fields)),
    transaction: () => {
      return Promise.reject(
        misuse(
          scope,
          'db.transaction',
          'a server operation runs one transaction, and none inside it',
        ),
      );
    },
    update: (table, id, patch) => scope.call.answer(() => transaction.update(table, id, patch)),
  };
}
