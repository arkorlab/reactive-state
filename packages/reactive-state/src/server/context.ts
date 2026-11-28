import { AsyncLocalStorage } from 'node:async_hooks';

import type { Json, User } from '../program.ts';

/**
 * The evaluation the application's own modules — its `db`, its `requireUser` — run in while the
 * authority renders a component, replays one for a write, or runs a server operation: what they
 * read and write is answered by it. The authority opens one for each and closes it once it
 * settles, so that a read made later, by a timer or a promise the code left behind, is refused
 * rather than taken for one of another evaluation. A server operation's transaction is an
 * evaluation of its own, opened inside the operation's: its reads see its writes, and the writes
 * wait in it until it is over.
 *
 * One `AsyncLocalStorage` for every copy of this module: the authority's engine and an
 * application's modules may each load their own (a bundle that inlines one, a package resolved
 * twice), and a read must find the evaluation the engine opened whichever copy it is made through.
 * Only `run()` is used — workerd implements no `enterWith()`.
 */

/** A record as the application reads it: its `id` beside its fields, or beside those selected. */
export type Entry = Readonly<Record<string, Json>>;

/**
 * How a statement an operation sent ended, as the client that sent it tells: `landed`, answered;
 * `none` where the database refused the statement itself, which wrote nothing of it; and `unknown`
 * where no answer came, or one the client does not read.
 */
export type ExternalWriteEnd = 'landed' | 'none' | 'unknown';

/**
 * What the authority answers an evaluation's reads and writes with. Each takes what the
 * application's code handed `db` as it is: the authority checks it against the declaration.
 */
export interface Evaluation {
  /** The session's user: the authority's own refusal (401) when there is none. */
  readonly user: () => User;
  /**
   * The session's user, or `null` for a request of none. A read of identity all the same: a render
   * every visitor is to share takes no answer from it, and becomes the request's.
   */
  readonly optionalUser: () => User | null;
  /**
   * The call of a render every visitor is to share, which notes what its code reads of the request
   * that nothing tracks (`./untracked.ts`); none for any other.
   */
  readonly shared?: { readonly boundToRequest: (what: string) => void } | undefined;
  /**
   * The record of `table` with that id, or `null`: an id no record could have names none. An
   * external table's store answers it in time (`external.ts`).
   */
  readonly get: (table: string, id: unknown) => Entry | null | Promise<Entry | null>;
  /** The records of `table` a query names (`{ where, select?, orderBy?, limit? }`), in its order. */
  readonly findMany: (
    table: string,
    query: unknown,
  ) => readonly Entry[] | Promise<readonly Entry[]>;
  /** How many records of `table` a query names (`{ where }`). */
  readonly count: (table: string, query: unknown) => number | Promise<number>;
  /** Makes a record, in the operation's transaction: it answers the record, its id the authority's. */
  readonly insert: (table: string, fields: unknown) => Entry;
  /** Changes fields of a record there is, in the operation's transaction. */
  readonly update: (table: string, id: unknown, patch: unknown) => Entry;
  /** Deletes a record there is, in the operation's transaction. */
  readonly delete: (table: string, id: unknown) => void;
  /** Runs `body` as the operation's one transaction: its writes land together, or none does. */
  readonly transaction: <T>(body: () => Promise<T>) => Promise<T>;
  /**
   * Notes that a render read, by SQL the application wrote itself, the records of each external
   * table `reads` answers that its `where` names — every record of a table whose `where` names
   * none: any change its store's log tells of such a record, before or after it, renders it again.
   * What `reads` fails with is the render's fault, whatever the code did with it. A render's alone —
   * nothing renders an operation again.
   */
  readonly readTables?: ((reads: () => Promise<readonly TableRead[]>) => Promise<void>) | undefined;
  /**
   * Whether this render is an event stream's, not a page's: what follows its reads may ask the
   * database more beside its statements, to say which rows they read.
   */
  readonly streamed?: boolean | undefined;
  /**
   * Told, before it goes, of each statement an operation's code sends that may write a table of the
   * application's own (`sentAsWrite`): what it answers is told how the statement ended. It throws
   * where the attempt was answered as of an outcome unknown — timed out, or faulted with nothing
   * kept — whose statements are sent no more. An operation's alone.
   */
  readonly externalWrite?: ((sql: string) => (ended: ExternalWriteEnd) => void) | undefined;
  /**
   * Takes the change of the application's own session that the operation asks for
   * (`changeSession`), once: it throws where the operation asked already. An operation's alone.
   */
  readonly changeSession?: ((change: Json) => void) | undefined;
  /**
   * Told of a connection of the application's own tables the operation uses (`followDrizzle`'s
   * PGlite, a connection checked out of its pool), with a probe of whether it is in a transaction
   * now: one connection is one probe however often it is told. What it answers unregisters the
   * probe. An operation's alone; it refuses `changeSession` while any probe says true.
   */
  readonly applicationConnection?:
    | ((connection: WeakKey, inTransaction: () => boolean) => () => void)
    | undefined;
}

/**
 * What a render's statement read of one external table: the records whose fields `where` names
 * hold the values it gives, as text — every record where it names none.
 */
export interface TableRead {
  readonly table: string;
  readonly where: Readonly<Record<string, string>>;
  /** Whether this is the table every statement reads of a change of the schema, not of its reads. */
  readonly schema?: true;
}

interface Slot {
  readonly evaluation: Evaluation;
  open: boolean;
}

const KEY = Symbol.for('arkorlab.reactive-state.evaluation');

function storage(): AsyncLocalStorage<Slot> {
  const shared = globalThis as unknown as Record<symbol, AsyncLocalStorage<Slot> | undefined>;
  shared[KEY] ??= new AsyncLocalStorage<Slot>();
  return shared[KEY];
}

/** Runs `body` in `evaluation`, which is closed once `body` settles. */
export async function evaluate<T>(evaluation: Evaluation, body: () => Promise<T>): Promise<T> {
  const slot: Slot = { evaluation, open: true };
  try {
    return await storage().run(slot, body);
  } finally {
    slot.open = false;
  }
}

/** The evaluation under way, for `what` to read; a fault anywhere else. */
export function currentEvaluation(what: string): Evaluation {
  const slot = storage().getStore();
  if (slot === undefined) {
    throw new Error(
      `${what} is read in the authority alone, as it renders a component or runs a server operation: not in the application's server, nor in the browser.`,
    );
  }
  if (!slot.open) {
    throw new Error(
      `${what} was read after the evaluation that started it had settled: a read the authority does not see would not render it again.`,
    );
  }
  return slot.evaluation;
}

/**
 * What notes the tables a render's own SQL reads (`Evaluation.readTables`): none outside an
 * evaluation — the host's own queries, a migration — nor in one that renders nothing again, an
 * operation, whose code may go on querying after it settled as it would have anywhere. A render's
 * query after the render settled is refused, as `currentEvaluation` refuses it.
 */
export function tableReads():
  | ((reads: () => Promise<readonly TableRead[]>) => Promise<void>)
  | undefined {
  if (storage().getStore()?.evaluation.readTables === undefined) {
    return undefined;
  }
  return currentEvaluation('A query').readTables;
}

/**
 * Begins a write of `sql`, a statement that may write a table of the application's own, as the
 * server operation under way sends it (`Evaluation.externalWrite`): what ends it, told how it ended,
 * once — none outside an operation, of the host's migrations or a module's own code. It throws where
 * the operation sends no more. The slot is read whether or not it is open: an attempt left running
 * past its time is still the one its statements are of.
 */
export function beganWrite(sql: string): ((ended: ExternalWriteEnd) => void) | undefined {
  return storage().getStore()?.evaluation.externalWrite?.(sql);
}

/** What `sentAsWrite` is given besides the statement and how it sends. */
export interface SentOptions<T = unknown> {
  /** The answer of a statement the operation sends no more of, as its call would fail. */
  readonly refusal?: ((error: unknown) => T) | undefined;
  /**
   * Whether what a statement answered shows it wrote no row, which ends it `none` rather than
   * `landed`.
   */
  readonly unwritten?: ((answered: unknown) => boolean | Promise<boolean>) | undefined;
}

/**
 * Sends `send`, a statement of `sql` that may write a table of the application's own and ends as it
 * is answered, as the operation under way sends it (`beganWrite`): `refused` says which of its errors
 * the database answered of the statement itself, which wrote nothing of it. A statement answered at
 * once, or through a callback, is of an outcome unknown. A statement the operation sends no more
 * of is answered by `options.refusal`, as its call would fail — a rejection, a callback — or else
 * thrown. A promised answer that `options.unwritten` says wrote no row ends the statement `none`.
 */
export function sentAsWrite<T>(
  sql: string,
  send: () => T,
  refused: (error: unknown) => boolean,
  options: SentOptions<T> = {},
): T {
  const { refusal, unwritten } = options;
  let ended: ReturnType<typeof beganWrite>;
  try {
    ended = beganWrite(sql);
  } catch (error) {
    if (refusal === undefined) throw error;
    return refusal(error);
  }
  if (ended === undefined) return send();
  let answered: T;
  try {
    answered = send();
  } catch (error) {
    ended(refused(error) ? 'none' : 'unknown');
    throw error;
  }
  if (answered instanceof Promise) return endedBy(answered, ended, refused, unwritten) as T;
  ended('unknown');
  return answered;
}

/**
 * Whether `unwritten` says `value` wrote no row, awaited where it answers a promise; a throw or a
 * rejection says not, and the answer stands.
 */
async function unwrittenBy(unwritten: SentOptions['unwritten'], value: unknown): Promise<boolean> {
  try {
    return (await unwritten?.(value)) === true;
  } catch {
    return false;
  }
}

/** What `answered`, a statement's answer, settles to, as it ends the statement: of its error too. */
async function endedBy(
  answered: Promise<unknown>,
  ended: (end: ExternalWriteEnd) => void,
  refused: (error: unknown) => boolean,
  unwritten: SentOptions['unwritten'],
): Promise<unknown> {
  try {
    const value: unknown = await answered;
    ended((await unwrittenBy(unwritten, value)) ? 'none' : 'landed');
    return value;
  } catch (error) {
    ended(refused(error) ? 'none' : 'unknown');
    throw error;
  }
}

/**
 * What takes the session change the operation under way asks for (`Evaluation.changeSession`):
 * none outside an operation — a render, a shared view, a route's middleware, or no evaluation at
 * all. The operation's own state says whether it still takes one.
 */
export function sessionChanger(): ((change: Json) => void) | undefined {
  return storage().getStore()?.evaluation.changeSession;
}

/**
 * Notes that the operation under way uses `connection`, one of the application's own tables, and
 * how to tell it is in a transaction: what unregisters it — none outside an operation. The slot is
 * read whether or not it is open: a connection the operation left running is still its own.
 */
export function usedConnection(
  connection: WeakKey,
  inTransaction: () => boolean,
): (() => void) | undefined {
  return storage().getStore()?.evaluation.applicationConnection?.(connection, inTransaction);
}

/**
 * `run`, a statement or a transaction of the application's own tables the operation under way
 * sends, counted as under way until it settles: a probe of the operation's that says so, however
 * the connection's own state reads. Run as it is outside an operation. A promised answer ends it
 * before whatever awaits it goes on.
 */
export function underway(run: () => unknown): unknown {
  const over = usedConnection({}, () => true);
  if (over === undefined) return run();
  let answered: unknown;
  try {
    answered = run();
  } catch (error) {
    over();
    throw error;
  }
  // One reaction for both outcomes, registered before the caller's: whatever awaits it goes on after.
  // eslint-disable-next-line unicorn/prefer-then-catch -- a `.catch` would run a tick after a rejection
  if (answered instanceof Promise) void answered.then(over, over);
  else over();
  return answered;
}

/**
 * `callback`, bound to the context it is bound in: called later, by whatever code the callback was
 * handed to, it reads the evaluation of the operation that bound it, as the code that made the call
 * does — a pool serves a waiting checkout from the context that released a connection.
 */
export function inThisContext<F extends (...args: never[]) => unknown>(callback: F): F {
  return AsyncLocalStorage.bind(callback);
}

/** Whether the render under way is an event stream's (`Evaluation.streamed`). */
export function streamedRender(): boolean {
  const slot = storage().getStore();
  return slot?.open === true && slot.evaluation.streamed === true;
}

/**
 * The call of the shared render under way, where the code running is one: what notes a read of the
 * request nothing tracks (`./untracked.ts`). None outside an evaluation, or in any other.
 */
export function sharedRender(): { readonly boundToRequest: (what: string) => void } | undefined {
  const slot = storage().getStore();
  return slot?.open === true ? slot.evaluation.shared : undefined;
}
