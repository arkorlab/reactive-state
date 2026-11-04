import type { Json, OperationCall, OperationReceipt } from '../program.ts';
import { evaluate } from '../server/context.ts';
import {
  HTTP_CONFLICT,
  HTTP_INTERNAL_ERROR,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
} from '../status.ts';
import { digest } from './canonical.ts';
import { AuthorityError, messageOf, refusal } from './errors.ts';
import { Call, operationEvaluation, transactionEvaluation } from './evaluation.ts';
import type { Core, Session } from './model.ts';
import { operationResult } from './operation-results.ts';
import { argumentsOf } from './requests.ts';
import { Transaction } from './transaction.ts';
import { scopeOf } from './views.ts';

/**
 * A server operation — an export of a `'use server'` module a component imports — run in the
 * authority, as the application's server asks for it under an operation id it made: once, however
 * often it is sent. A resend answers what the first answered, its refusal too; an id sent again for
 * another operation is refused (409).
 *
 * The operation is the application's own code, run with the session's user, its reads of the
 * committed records, and one transaction (`db.transaction`), whose writes land together — with the
 * operation's own record, which a resend finds — or not at all. What it returns is its result. A
 * refusal of the authority's (`forbidden()`, a record not found, a value a field cannot hold) is
 * answered with its status; anything else the code throws — its own checks of what it was sent —
 * refuses the operation (422) with the error's message. Either is definitive, and kept for a
 * resend; a fault — the storage's, or a misuse of the database — is neither, and is not kept: its
 * outcome is unknown, and the operation may be sent again.
 *
 * Once its transaction committed, the operation is no refusal whatever it does: its record says it
 * committed, and is settled once its code is — with what it returned, or, where it threw after the
 * commit, as a failure that committed (500 `OPERATION_FAILED`). A record never settled, as an
 * authority that stopped in between leaves it, answers a resend that its outcome is unknown (500
 * `OPERATION_UNSETTLED`), never a result it did not see returned.
 */

/** The longest message of a refusal that quotes what the operation threw. */
const MAX_MESSAGE_LENGTH = 500;

/** What an operation answered, as it is kept for a resend. */
type Outcome =
  | {
      readonly refusal: {
        readonly status: number;
        readonly code: string;
        readonly message: string;
      };
    }
  | { readonly receipt: { readonly committedRevision: number | null; readonly result: Json } }
  /** What its commit says of it, until its code settles: it committed. */
  | { readonly committed: { readonly revision: number } }
  /** It committed, and then threw. */
  | { readonly failed: { readonly committedRevision: number; readonly message: string } };

/** What an operation is, which one operation id names: the function, and what it was sent. */
function fingerprintOf(call: OperationCall): string {
  return digest(['operation', call.module, call.name, call.args]);
}

/** What an operation that committed and then threw is answered, first and on a resend. */
function failure(committedRevision: number, message: string): AuthorityError {
  return refusal(
    HTTP_INTERNAL_ERROR,
    'OPERATION_FAILED',
    `The operation committed at revision ${String(committedRevision)}, and then threw: ${message}`,
  );
}

/** A resend's answer: the first one's receipt, or its refusal or its failure again. */
function repeated(previous: Outcome, operationId: string): OperationReceipt {
  if ('refusal' in previous) {
    const { code, message, status } = previous.refusal;
    throw new AuthorityError(message, { code, status });
  }
  if ('failed' in previous) {
    throw failure(previous.failed.committedRevision, previous.failed.message);
  }
  if ('committed' in previous) {
    throw refusal(
      HTTP_INTERNAL_ERROR,
      'OPERATION_UNSETTLED',
      `The operation committed at revision ${String(previous.committed.revision)}; what it did after that is unknown.`,
    );
  }
  return { ...previous.receipt, deduplicated: true, operationId };
}

/** One run of an operation: its call, its one transaction, and what it committed. */
class Running {
  readonly #core: Core;
  readonly #session: Session;
  readonly #call: OperationCall;
  readonly #fingerprint: string;
  readonly #timer: Call;
  #transacted = false;
  /** The revision its transaction committed at; `null` until one did. */
  #committed: number | null = null;

  constructor(core: Core, session: Session, call: OperationCall, fingerprint: string) {
    this.#core = core;
    this.#session = session;
    this.#call = call;
    this.#fingerprint = fingerprint;
    this.#timer = new Call(`The server operation ${call.module}#${call.name}`, core.timeoutMs);
  }

  /**
   * What the operation threw, as it is answered: a fault as itself, not kept; one that threw after
   * its transaction committed as a failure that committed, kept; a refusal of the session (401) as
   * itself, not kept — a session that ended sends nothing again; any other refusal as itself, and
   * anything else as the operation's rejection (422), each kept.
   */
  #refused(thrown: unknown): unknown {
    if (this.#timer.fault !== undefined) {
      return thrown;
    }
    if (this.#committed !== null) {
      const message = messageOf(thrown, MAX_MESSAGE_LENGTH);
      try {
        this.#keep({ failed: { committedRevision: this.#committed, message } });
      } catch (error) {
        // Not kept, the record still says the operation committed, which a resend answers.
        return error;
      }
      return failure(this.#committed, message);
    }
    const refused =
      thrown instanceof AuthorityError
        ? thrown
        : refusal(HTTP_UNPROCESSABLE, 'OPERATION_REJECTED', messageOf(thrown, MAX_MESSAGE_LENGTH));
    if (refused.status !== HTTP_UNAUTHORIZED) {
      const { code, message, status } = refused;
      try {
        this.#keep({ refusal: { code, message, status } });
      } catch (error) {
        // Not kept, the refusal is no answer: the operation's outcome is unknown, and it may be
        // sent again.
        return error;
      }
    }
    return refused;
  }

  /** Keeps what the operation answered: in its record, made by its commit or now. */
  #keep(outcome: Outcome): void {
    const { db } = this.#core;
    const { id: sessionId } = this.#session;
    const { operationId } = this.#call;
    if (this.#committed === null) {
      // A receipt of no commit's: what no asserted session needs any more is let go of beside it,
      // as beside a commit's.
      this.#core.sweep();
      db.insertOperation({
        created: this.#core.clock(),
        fingerprint: this.#fingerprint,
        id: operationId,
        kind: 'operation',
        outcome: JSON.stringify(outcome),
        revision: db.revision(),
        sessionId,
      });
    } else {
      db.settleOperation(sessionId, operationId, JSON.stringify(outcome));
    }
  }

  /**
   * `db.transaction(body)`: the operation's one transaction. Its writes wait in it while `body`
   * runs, and are committed at once when it returns — with the operation's record, which says it
   * committed, should its answer be lost — or let go of when it throws.
   */
  async #transaction<T>(body: () => Promise<T>): Promise<T> {
    const scope = scopeOf(this.#core, this.#timer, this.#session);
    this.#timer.answer(() => {
      if (typeof body !== 'function') {
        throw new TypeError('db.transaction runs a function: `db.transaction(async () => …)`.');
      }
      if (this.#transacted) {
        throw new Error('db.transaction: a server operation runs one transaction.');
      }
      this.#transacted = true;
    });
    const transaction = new Transaction(this.#core.tables);
    const result = await evaluate(transactionEvaluation(scope, transaction), body);
    // A fault the call's code raised is its outcome, though the code caught it: what the
    // transaction wrote is let go of, as a throw lets it go, never committed by an operation that
    // fails.
    const { fault } = this.#timer;
    if (fault !== undefined) {
      throw fault.error;
    }
    this.#timer.answer(() => {
      transaction.check();
      if (!transaction.written) {
        return;
      }
      const event = this.#core.commit({
        kind: 'state',
        rows: transaction.changes(),
        with: (revision) => {
          this.#core.db.insertOperation({
            created: this.#core.clock(),
            fingerprint: this.#fingerprint,
            id: this.#call.operationId,
            kind: 'operation',
            outcome: JSON.stringify({ committed: { revision } } satisfies Outcome),
            revision,
            sessionId: this.#session.id,
          });
        },
      });
      this.#committed = event.revision;
    });
    return result;
  }

  async run(operation: (...args: readonly unknown[]) => unknown): Promise<OperationReceipt> {
    const timer = this.#timer;
    const scope = scopeOf(this.#core, timer, this.#session);
    const args = argumentsOf(this.#call.args);
    try {
      const returned = await timer.run(
        operationEvaluation(scope, (body) => this.#transaction(body)),
        // What the operation answers, though it be no promise: one it throws becomes the run's.
        () => Promise.resolve(operation(...args)),
      );
      if (timer.fault !== undefined) {
        throw timer.fault.error;
      }
      const receipt = { committedRevision: this.#committed, result: operationResult(returned) };
      // Kept as the operation's code is answered: a storage that fails it is the call's fault.
      timer.answer(() => {
        this.#keep({ receipt });
      });
      return { ...receipt, deduplicated: false, operationId: this.#call.operationId };
    } catch (error) {
      throw this.#refused(timer.fault === undefined ? timer.outcome(error) : timer.fault.error);
    } finally {
      timer.close();
    }
  }
}

/** Runs one server operation for the session `sessionId` names; its receipt, or a refusal. */
export async function runOperation(
  core: Core,
  sessionId: unknown,
  call: OperationCall,
  operation: (...args: readonly unknown[]) => unknown,
): Promise<OperationReceipt> {
  const session = core.session(sessionId);
  const fingerprint = fingerprintOf(call);
  const { operationId } = call;
  const previous = core.db.operation(session.id, operationId);
  if (previous !== undefined) {
    if (previous.kind !== 'operation' || previous.fingerprint !== fingerprint) {
      throw refusal(
        HTTP_CONFLICT,
        'OPERATION_REUSED',
        'That operation id was used for another operation.',
      );
    }
    core.metrics.deduplicated += 1;
    return repeated(JSON.parse(previous.outcome) as Outcome, operationId);
  }
  core.metrics.operationRuns += 1;
  return new Running(core, session, call, fingerprint).run(operation);
}
