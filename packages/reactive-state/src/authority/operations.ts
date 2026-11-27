import type { Json, OperationCall, OperationReceipt } from '../program.ts';
import { evaluate, type ExternalWriteEnd } from '../server/context.ts';
import {
  HTTP_CONFLICT,
  HTTP_INTERNAL_ERROR,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
} from '../status.ts';
import { digest } from './canonical.ts';
import { AuthorityError, isAuthorityError, messageOf, refusal } from './errors.ts';
import {
  Call,
  operationEvaluation,
  type OperationHooks,
  transactionEvaluation,
} from './evaluation.ts';
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
 *
 * The application's own tables (`followDrizzle`) are written by its own statements, which no
 * transaction of the authority's holds: so, before the first of them that may write, the operation
 * makes its record as a commit would, and a resend of it is never run again. Once one may have
 * landed, the operation is no refusal either: what it throws is a failure (500 `OPERATION_FAILED`),
 * and running past its time leaves it unsettled. Where every such statement was refused by the
 * database as a statement, nothing was written, and the record is let go of. An attempt answered as
 * of an outcome unknown sends no more of them.
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
  | {
      readonly receipt: {
        readonly committedRevision: number | null;
        readonly result: Json;
        readonly sessionChange?: Json;
      };
    }
  /**
   * What its commit says of it, until its code settles: it committed — or, `external`, it was about
   * to write the application's own tables, at the authority's revision then.
   */
  | { readonly committed: { readonly revision: number }; readonly external?: true }
  /** It committed — or, `external`, may have written the application's own tables — and then threw. */
  | {
      readonly failed: { readonly committedRevision: number; readonly message: string };
      readonly external?: true;
    };

/** How much of a statement an error that refuses it quotes. */
const SHOWN_STATEMENT = 80;

/** What an operation is, which one operation id names: the function, and what it was sent. */
function fingerprintOf(call: OperationCall): string {
  return digest(['operation', call.module, call.name, call.args]);
}

/**
 * What an operation that committed and then threw is answered, first and on a resend; or one that
 * may have written the application's own tables (`external`) and then threw.
 */
function failure(committedRevision: number, message: string, external = false): AuthorityError {
  const done = external
    ? "The operation may have written the application's own tables"
    : `The operation committed at revision ${String(committedRevision)}`;
  return refusal(HTTP_INTERNAL_ERROR, 'OPERATION_FAILED', `${done}, and then threw: ${message}`);
}

/**
 * What an operation is answered whose outcome is unknown past what it did: it committed at
 * `revision`, or may have written the application's own tables (`external`).
 */
function unsettled(revision: number, external = false): AuthorityError {
  const done = external
    ? "The operation may have written the application's own tables"
    : `The operation committed at revision ${String(revision)}`;
  return refusal(
    HTTP_INTERNAL_ERROR,
    'OPERATION_UNSETTLED',
    `${done}; what it did after that is unknown.`,
  );
}

/** A resend's answer: the first one's receipt, or its refusal or its failure again. */
function repeated(previous: Outcome, operationId: string): OperationReceipt {
  if ('refusal' in previous) {
    const { code, message, status } = previous.refusal;
    throw new AuthorityError(message, { code, status });
  }
  if ('failed' in previous) {
    const { committedRevision, message } = previous.failed;
    throw failure(committedRevision, message, previous.external === true);
  }
  if ('committed' in previous) {
    throw unsettled(previous.committed.revision, previous.external === true);
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
  /** Whether its record was made before a write of the application's own tables. */
  #marked = false;
  /** How many writes of the application's own tables it began that have not ended. */
  #writing = 0;
  /** Whether a write of the application's own tables ended landed, or of an outcome unknown. */
  #wrote = false;
  /** The change of the application's session the code asked for; it counts once it succeeds. */
  #change: Json | undefined;
  /** What it asked for inside its transaction: the run's once that commits, none if it rolls back. */
  #pending: Json | undefined;
  /** Whether its transaction (`db.transaction`) is under way. */
  #inTransaction = false;
  /** Whether its transaction ended in a rollback, which what its code asks for later goes with. */
  #rolledBack = false;
  /** Whether its transaction committed, which what its code asks for later stays the run's after. */
  #transactionCommitted = false;
  /** The connections of the application's own tables it uses, each with its probe of a transaction. */
  readonly #connections = new Map<WeakKey, () => boolean>();
  /** What became of its answer: kept for a resend, or answered as of an outcome unknown. */
  #settled: 'abandoned' | 'kept' | undefined;

  constructor(core: Core, session: Session, call: OperationCall, fingerprint: string) {
    this.#core = core;
    this.#session = session;
    this.#call = call;
    this.#fingerprint = fingerprint;
    this.#timer = new Call(`The server operation ${call.module}#${call.name}`, core.timeoutMs);
  }

  /**
   * What the operation threw, as it is answered: a fault as itself, not kept (`#faulted`); one that
   * threw after its transaction committed as a failure that committed, and one that threw once a
   * write of the application's own tables may have landed as a failure that may have written, each
   * kept; a refusal of the session (401) as itself, not kept — a session that ended sends nothing
   * again; any other refusal as itself, and anything else as the operation's rejection (422), each
   * kept. Answered, the attempt sends no more writes of the application's own tables, unless kept.
   */
  #refused(thrown: unknown): unknown {
    this.#settled = 'abandoned';
    if (this.#timer.fault !== undefined) {
      return this.#faulted(thrown);
    }
    if (this.#committed === null && this.#mayHaveWritten()) {
      const message = messageOf(thrown, MAX_MESSAGE_LENGTH);
      const committedRevision = this.#core.db.revision();
      try {
        this.#keep({ external: true, failed: { committedRevision, message } });
      } catch (error) {
        // Not kept, the record still says the operation may have written, which a resend answers.
        return error;
      }
      return failure(committedRevision, message, true);
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
    } else if (this.#marked) {
      try {
        this.#withdraw();
      } catch (error) {
        return error;
      }
    }
    return refused;
  }

  /** Tells the application's `onError` of `error`, unless it is the authority's own refusal. */
  #told(error: unknown): void {
    if (!isAuthorityError(error)) {
      const { module, name, operationId } = this.#call;
      this.#core.report(error, { kind: 'operation', module, name, operationId });
    }
  }

  /**
   * `changeSession`: takes the change the code asks for, once — one held, committed or pending,
   * counts — while the run is under way, from the code of any of its transactions. Asked while
   * `db.transaction` runs, by the transaction's own code, it is the transaction's, and the run's if
   * that commits; refused while a connection of the application's own tables it uses is in a
   * transaction, whose rollback it could not follow; and
   * refused once the run has answered or timed out.
   */
  #changeSession(change: Json, fromTransaction: boolean): void {
    if (this.#timer.settled) {
      throw new TypeError(
        'changeSession(change) was called after the server operation had settled or timed out — its code ended, and its answer is built: a change the authority does not see is not kept.',
      );
    }
    if (this.#inTransactionOfTheApplication()) {
      throw new TypeError(
        "changeSession(change) is called while a statement or a transaction of the application's own tables is under way, which it cannot follow: call it once they have returned.",
      );
    }
    if (fromTransaction && this.#rolledBack) {
      throw new TypeError(
        'changeSession(change) is called by the code of a transaction that rolled back: what it asked for went with it.',
      );
    }
    if (this.#change !== undefined || this.#pending !== undefined) {
      throw new TypeError('changeSession(change): a server operation changes the session once.');
    }
    if (fromTransaction && this.#inTransaction) {
      this.#pending = change;
    } else {
      this.#change = change;
    }
  }

  /**
   * Whether a connection of the application's own tables it uses is in a transaction now, by the
   * connection's own state; one whose probe throws counts as in one.
   */
  #inTransactionOfTheApplication(): boolean {
    for (const probe of this.#connections.values()) {
      let inTransaction: boolean;
      try {
        inTransaction = probe();
      } catch {
        inTransaction = true;
      }
      if (inTransaction) return true;
    }
    return false;
  }

  /** What a connection the operation uses is told: one probe for it, which the answer lets go of. */
  #applicationConnection(connection: WeakKey, inTransaction: () => boolean): () => void {
    this.#connections.set(connection, inTransaction);
    return () => {
      this.#connections.delete(connection);
    };
  }

  /**
   * What the code of either of the operation's evaluations tells it of; `fromTransaction` says
   * whether it is the transaction's own evaluation that the code runs in.
   */
  #hooks(fromTransaction: boolean): OperationHooks {
    return {
      applicationConnection: (connection, inTransaction) =>
        this.#applicationConnection(connection, inTransaction),
      changeSession: (change) => {
        this.#changeSession(change, fromTransaction);
      },
      externalWrite: (sql) => this.#externalWrite(sql),
    };
  }

  /**
   * The transaction committed: what the code asked for inside it is the run's, at once, and its
   * hold ends with the commit — a call that follows is the run's, not a pending change that
   * `#transaction` would let go of.
   */
  #adopt(): void {
    this.#inTransaction = false;
    this.#transactionCommitted = true;
    if (this.#pending !== undefined) {
      this.#change = this.#pending;
      this.#pending = undefined;
    }
  }

  /** Whether a write of the application's own tables may have landed: one ended so, or under way. */
  #mayHaveWritten(): boolean {
    return this.#wrote || this.#writing > 0;
  }

  /**
   * A fault of the call's — its time, the storage's, a misuse of the database — as it is answered:
   * as itself, not kept, as before; of an operation that may have written the application's own
   * tables, as unsettled, which its record answers a resend. Where each write it sent was refused as
   * a statement, the record is let go of, and it may be sent again: it sends no more.
   */
  #faulted(thrown: unknown): unknown {
    if (this.#committed === null && this.#marked) {
      if (this.#mayHaveWritten()) {
        return unsettled(this.#core.db.revision(), true);
      }
      try {
        this.#withdraw();
      } catch (error) {
        return error;
      }
    }
    return thrown;
  }

  /**
   * Notes that the operation's code is about to send `sql`, a statement that may write a table of
   * the application's own: before the first, its record is made, which a resend finds — and the
   * operation runs no more — and how each ends says what its answer may be. An attempt whose answer
   * is a fault's, or of an outcome unknown, sends no more of them; one whose answer was kept sends
   * them as before.
   */
  #externalWrite(sql: string): (ended: ExternalWriteEnd) => void {
    if (this.#settled === 'kept') {
      return () => {
        // Its answer is kept: a resend answers that, whatever this statement does.
      };
    }
    if (this.#settled === 'abandoned' || this.#timer.fault !== undefined) {
      throw new Error(
        `The server operation ${this.#call.module}#${this.#call.name} has an outcome other than its code's, and sends no more statements: ${sql.slice(0, SHOWN_STATEMENT)}`,
      );
    }
    if (!this.#marked) {
      try {
        this.#mark();
      } catch (error) {
        throw this.#timer.faulted(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.#writing += 1;
    let told = false;
    return (ended) => {
      if (told) return;
      told = true;
      this.#writing -= 1;
      if (ended !== 'none') this.#wrote = true;
    };
  }

  /**
   * Makes the operation's record before its first write of the application's own tables, as a
   * commit makes it: should its answer be lost, a resend says it may have written, and runs it not.
   */
  #mark(): void {
    // After a commit, its record says it committed already, which a resend answers as unsettled.
    if (this.#committed === null) {
      const { db } = this.#core;
      const revision = db.revision();
      this.#core.sweep();
      db.insertOperation({
        created: this.#core.clock(),
        fingerprint: this.#fingerprint,
        id: this.#call.operationId,
        kind: 'operation',
        outcome: JSON.stringify({ committed: { revision }, external: true } satisfies Outcome),
        revision,
        sessionId: this.#session.id,
      });
    }
    this.#marked = true;
  }

  /** Lets go of the record `#mark` made: each write it was made for was refused as a statement. */
  #withdraw(): void {
    this.#core.db.deleteOperation(this.#session.id, this.#call.operationId);
    this.#marked = false;
  }

  /** Keeps what the operation answered: in its record, made by its commit or now. */
  #keep(outcome: Outcome): void {
    const { db } = this.#core;
    const { id: sessionId } = this.#session;
    const { operationId } = this.#call;
    if (this.#committed === null && !this.#marked) {
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
    this.#settled = 'kept';
  }

  /**
   * `db.transaction(body)`: the operation's one transaction. Its writes wait in it while `body`
   * runs, and are committed at once when it returns — with the operation's record, which says it
   * committed, should its answer be lost — or let go of when it throws.
   */
  async #transaction<T>(body: () => Promise<T>): Promise<T> {
    this.#inTransaction = true;
    try {
      return await this.#transacting(body);
    } finally {
      // Not committed, what the code asked for inside the transaction is let go of.
      this.#pending = undefined;
      this.#inTransaction = false;
      this.#rolledBack = !this.#transactionCommitted;
    }
  }

  /** The transaction itself; its commit hands over its change (`#adopt`), as it lands. */
  async #transacting<T>(body: () => Promise<T>): Promise<T> {
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
    const result = await evaluate(
      transactionEvaluation(scope, transaction, this.#hooks(true)),
      body,
    );
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
        this.#adopt();
        return;
      }
      const event = this.#core.commit({
        kind: 'state',
        rows: transaction.changes(),
        with: (revision) => {
          if (this.#marked) {
            // Its record was made as it was to write the application's own tables: it says it
            // committed now, as well.
            const outcome: Outcome = { committed: { revision }, external: true };
            this.#core.db.settleOperation(
              this.#session.id,
              this.#call.operationId,
              JSON.stringify(outcome),
            );
            return;
          }
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
      this.#adopt();
    });
    return result;
  }

  async run(operation: (...args: readonly unknown[]) => unknown): Promise<OperationReceipt> {
    const timer = this.#timer;
    const scope = scopeOf(this.#core, timer, this.#session);
    const args = argumentsOf(this.#call.args);
    try {
      const returned = await timer.run(
        operationEvaluation(scope, (body) => this.#transaction(body), this.#hooks(false)),
        // What the operation answers, though it be no promise: one it throws becomes the run's.
        () => Promise.resolve(operation(...args)),
      );
      if (timer.fault !== undefined) {
        throw timer.fault.error;
      }
      const receipt = {
        committedRevision: this.#committed,
        result: operationResult(returned),
        ...(this.#change !== undefined && { sessionChange: this.#change }),
      };
      // Kept as the operation's code is answered: a storage that fails it is the call's fault.
      timer.answer(() => {
        this.#keep({ receipt });
      });
      return { ...receipt, deduplicated: false, operationId: this.#call.operationId };
    } catch (error) {
      const thrown = timer.fault === undefined ? timer.outcome(error) : timer.fault.error;
      // Answered first: what the hook does to the error changes nothing of the answer or its record.
      const answered = this.#refused(thrown);
      this.#told(thrown);
      // A fault that answers in a refusal's place (its keeping failed) is the application's to hear.
      if (answered !== thrown) {
        this.#told(answered);
      }
      throw answered;
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
