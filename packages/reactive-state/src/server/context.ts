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
}

/**
 * What a render's statement read of one external table: the records whose fields `where` names
 * hold the values it gives, as text — every record where it names none.
 */
export interface TableRead {
  readonly table: string;
  readonly where: Readonly<Record<string, string>>;
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
 * The call of the shared render under way, where the code running is one: what notes a read of the
 * request nothing tracks (`./untracked.ts`). None outside an evaluation, or in any other.
 */
export function sharedRender(): { readonly boundToRequest: (what: string) => void } | undefined {
  const slot = storage().getStore();
  return slot?.open === true ? slot.evaluation.shared : undefined;
}
