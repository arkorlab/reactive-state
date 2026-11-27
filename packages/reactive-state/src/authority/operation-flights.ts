import type { OperationCall, OperationReceipt } from '../program.ts';
import type { Core } from './model.ts';
import { keptAnswer, type Running, runningOf, runOperation } from './operations.ts';

/**
 * The server operations an authority runs apart from its queue. An application whose every table
 * is external — a follow's (`followDrizzle`) — has none the authority holds, so an operation's code
 * writes nothing of the authority's, and only awaits the application's own database: it need not
 * hold the queue every page's render waits in while it does. Such a call enters the queue twice:
 *
 * - first, to resolve its session, read the record of its operation id, and answer a kept outcome
 *   as a resend is answered; where a run of the same session and id is under way, the call waits
 *   for it apart from the queue and begins again; otherwise it reserves the id and leaves;
 * - last, once the code has settled, to keep the outcome — an asserted session always keeps it, a
 *   demo session while its row exists — and to release the reservation, whatever came of it, so
 *   that a call that waited always wakes.
 *
 * A field update of the same session and operation id waits for a run under way as well (`write`).
 */

/** What the first entry of the queue found. */
type Begun =
  | { readonly kind: 'kept'; readonly receipt: OperationReceipt }
  | { readonly kind: 'flying'; readonly flight: Promise<void> }
  | { readonly kind: 'reserved'; readonly running: Running; readonly key: string };

/** How a call joins the authority's queue, the closing authority's refusal included. */
export type Enter = <T>(body: () => Promise<T> | T) => Promise<T>;

/** The reservation of a session's operation id: the two never run together. */
function keyOf(sessionId: string, operationId: string): string {
  return JSON.stringify([sessionId, operationId]);
}

/** The runs apart from the queue that are under way, by the session and the operation id. */
export class OperationFlights {
  readonly #enter: Enter;
  /**
   * Whether the operations run apart from the queue: every table the application declares is
   * external.
   */
  readonly #apart: boolean;
  readonly #flying = new Map<string, { readonly done: Promise<void>; readonly end: () => void }>();
  #closing = false;

  constructor(enter: Enter, apart: boolean) {
    this.#enter = enter;
    this.#apart = apart;
  }

  /**
   * The first entry of the queue: the session, the kept answer, the run under way, or a
   * reservation.
   */
  #begin(core: Core, sessionId: unknown, call: OperationCall): Begun {
    const session = core.session(sessionId);
    const key = keyOf(session.id, call.operationId);
    const under = this.#flying.get(key);
    if (under !== undefined) {
      return { flight: under.done, kind: 'flying' };
    }
    const receipt = keptAnswer(core, session, call);
    if (receipt !== undefined) {
      return { kind: 'kept', receipt };
    }
    // A call that waited for a run is answered from its record to the end; none begins a new run.
    if (this.#closing) {
      throw new Error('The authority is closed');
    }
    const { promise, resolve } = Promise.withResolvers<undefined>();
    this.#flying.set(key, {
      done: promise,
      end: () => {
        resolve(undefined);
      },
    });
    return { key, kind: 'reserved', running: runningOf(core, session, call, false) };
  }

  /** Releases a reservation, which wakes the calls that wait for it. */
  #release(key: string): void {
    this.#flying.get(key)?.end();
    this.#flying.delete(key);
  }

  /** The code of a run that holds a reservation, outside the queue, and its last entry of it. */
  async #finish(
    begun: Extract<Begun, { readonly kind: 'reserved' }>,
    operation: (...args: readonly unknown[]) => unknown,
  ): Promise<OperationReceipt> {
    try {
      const finish = await begun.running.execute(operation);
      return await this.#enter(() => finish(true));
    } finally {
      this.#release(begun.key);
    }
  }

  /** One server operation: its receipt, or the error it throws. */
  async operate(
    core: Core,
    sessionId: unknown,
    call: OperationCall,
    operation: (...args: readonly unknown[]) => unknown,
  ): Promise<OperationReceipt> {
    if (!this.#apart) {
      return this.#enter(async () => runOperation(core, sessionId, call, operation));
    }
    for (;;) {
      const begun = await this.#enter(() => this.#begin(core, sessionId, call));
      if (begun.kind === 'kept') {
        return begun.receipt;
      }
      if (begun.kind === 'flying') {
        await begun.flight;
        continue;
      }
      return this.#finish(begun, operation);
    }
  }

  /**
   * `body`, a write to a field, in the queue: where a run of the same session and operation id is
   * under way, it waits for the run apart from the queue and begins again, and finds the
   * operation's record, which refuses an id of another kind. Without runs apart, it is `body`.
   */
  async write<T>(
    core: Core,
    sessionId: unknown,
    operationId: string,
    body: () => Promise<T>,
  ): Promise<T> {
    if (!this.#apart) {
      return this.#enter(body);
    }
    for (;;) {
      const step = await this.#enter(async () => {
        const flight = this.#flying.get(keyOf(core.session(sessionId).id, operationId));
        return flight === undefined ? { value: await body() } : { flight: flight.done };
      });
      if ('value' in step) {
        return step.value;
      }

      await step.flight;
    }
  }

  /**
   * Refuses the runs that begin from now on: a call is still answered from a kept record, but none
   * reserves an id.
   */
  refuse(): void {
    this.#closing = true;
  }

  /** Waits for every run under way; each is bounded by its own time. */
  async settled(): Promise<void> {
    while (this.#flying.size > 0) {
      await Promise.all([...this.#flying.values()].map(({ done }) => done));
    }
  }
}
