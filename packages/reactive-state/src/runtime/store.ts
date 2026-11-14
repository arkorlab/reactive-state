import type { FieldOperation, FieldReceipt, Frame, Json, Result, Value } from '../program.ts';
import { BUILD_MISMATCH, HTTP_UNAUTHORIZED } from '../status.ts';
import { toJsonRecord } from './json.ts';
import { type PendingOperation, type Predictor, reflects } from './operations.ts';
import { isDefinitive, isReceipt, refusesBinding } from './store-answers.ts';

/**
 * The page's store, one for the page however many roots it renders: every operation the page has
 * made of a field (`table:id:field`) that the frames it shows do not all reflect yet, in the order
 * they were made. The confirmed values are the frames' — each root's own, which it renders with the
 * tree it came with — and never the store's: a component shows a field's value as its frame
 * confirms it with the operations that frame does not reflect applied on top (`displayValue`), and
 * the store lets an operation go once every frame of its session reflects it.
 *
 * Operations are sent one at a time for the whole page, in the order they were made. One the
 * authority refused is dropped — with every other operation of its binding, where it refused the
 * binding itself — and the ones after it are applied again; one whose outcome is unknown is sent
 * again under the same operation id, which the authority applies at most once.
 *
 * An operation is a registered `apply`, whose prediction runs on the value shown and which the
 * authority runs with the values the call captured, or a registered `set`, which carries the value
 * it writes: what a setter passed on to a control writes, once for each keystroke. A `set` never
 * sent, the last operation of the page, gives way to a newer `set` of its field, which takes its
 * place: a field typed into while an operation is on its way sends its newest text once that one is
 * answered, not every keystroke in between. An `apply` never gives way.
 */

/** Sends one operation: the `update` Server Function of the root it was made under. */
export type Send = (operation: FieldOperation) => Promise<Result<FieldReceipt>>;

/** Where an operation goes: the field, the binding that lets this session write it, and how. */
export interface WriteTarget {
  readonly field: string;
  readonly binding: string;
  readonly updaterId: string;
  readonly session: string | undefined;
  readonly send: Send;
}

export interface SetWrite extends WriteTarget {
  readonly value: Value;
}

export interface ApplyWrite extends WriteTarget {
  readonly captures: Readonly<Record<string, Json>>;
  readonly predict: Predictor;
}

/** What the page says of its operations, beside their values. */
export interface StoreStatus {
  readonly pending: number;
  readonly error: string | null;
  /** Whether an operation's outcome stayed unknown through every send, and sending waits. */
  readonly offline: boolean;
  /** Whether the session ended, after which nothing is sent until the page is another session's. */
  readonly revoked: boolean;
  /** Whether the page's code no longer matches the authority's: a reload is asked for. */
  readonly mismatched: boolean;
  /** The root that says so on the page: the first one attached. */
  readonly primary: string | undefined;
}

export interface StoreOptions {
  /** The wait before the first retry of an operation whose outcome is unknown; it grows per attempt. */
  readonly retryDelay?: number;
  /** Names a new operation; unique per operation. */
  readonly id?: () => string;
  /**
   * An operation committed at `revision` — at the latest, where a frame told of it first — which the
   * page should show.
   */
  readonly onCommitted?: (revision: number) => void;
  /**
   * An operation was let go of whose effect the page cannot show from what it holds — the authority
   * refused its binding, or whether it was made is unknown — so the page renders again.
   */
  readonly onRefused?: () => void;
  /** An operation's outcome stayed unknown through every send: sending waits for `resume`. */
  readonly onOffline?: () => void;
  /** The session ended, once: the page renders again for whoever it is now. */
  readonly onRevoked?: () => void;
}

type Write =
  | {
      readonly kind: 'apply';
      readonly captures: Readonly<Record<string, Json>>;
      readonly predict: Predictor;
    }
  | { readonly kind: 'set'; readonly value: Value };

interface Operation {
  readonly id: string;
  readonly target: WriteTarget;
  readonly write: Write;
  committedRevision: number | null;
  attempts: number;
  /** The times its sends ran out and the store went offline for it. */
  recoveries: number;
  /**
   * Whether a send of it went unanswered — no answer, or one that said nothing of it: whether it
   * was made, a receipt or a frame says from then on, and a refusal of a resend does not.
   */
  unknown: boolean;
  sending: boolean;
  /**
   * Whether it was ever handed to its transport. One that was is never replaced: a copy of it still
   * on its way could commit after the operation that replaced it, an older value over a newer one.
   */
  sent: boolean;
}

/** A root the page renders, and the frame it shows. */
interface Shown {
  readonly frame: Frame;
  readonly session: string | undefined;
}

/** Operations neither settled nor failed, past which a new one is refused. */
const MAX_PENDING = 64;
/** Sends of one operation whose outcome stays unknown, after which the store goes offline. */
const MAX_ATTEMPTS = 3;
/** The times an operation may take the store offline before it is given up. */
const MAX_RECOVERIES = 3;
const RETRY_DELAY_MS = 200;
/** The random bytes of an operation's id: 128 bits. */
const OPERATION_ID_BYTES = 16;
const HEX = 16;
const CHECKING = 'Checking whether the change was saved.';
const NOT_SAVED = 'The change could not be saved.';
/** What the page says of a write it let go of without learning whether the authority made it. */
const UNCERTAIN = 'The change may have been saved: check the page before making it again.';
const OFFLINE = 'Not connected. Try again once the connection is back.';
const TOO_MANY = 'Too many unconfirmed changes.';
const UPDATED = 'The application was updated. Reload the page.';
const REVOKED = 'Your access was revoked.';

const NONE: readonly PendingOperation[] = Object.freeze([]);

/**
 * A new operation's id: 128 random bits, in hex. `crypto.randomUUID` exists only on a secure
 * origin, and a page served over plain HTTP — a phone reaching a laptop on its network — writes too.
 */
function operationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(OPERATION_ID_BYTES));
  return Array.from(bytes, (byte) => byte.toString(HEX).padStart(2, '0')).join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The operation as it is sent: a `set` carries its value — `false`, `0` or `''` too. */
function operationOf(operation: Operation): FieldOperation {
  const { binding, updaterId } = operation.target;
  return operation.write.kind === 'set'
    ? { binding, operationId: operation.id, updaterId, value: operation.write.value }
    : { binding, captures: operation.write.captures, operationId: operation.id, updaterId };
}

function viewOf(operation: Operation): PendingOperation {
  const { committedRevision, id, target, write } = operation;
  const pending = { committedRevision, field: target.field, id, session: target.session };
  return Object.freeze(
    write.kind === 'set'
      ? { ...pending, kind: 'set', value: write.value }
      : { ...pending, kind: 'apply', predict: write.predict },
  );
}

function sameStatus(a: StoreStatus, b: StoreStatus): boolean {
  return (
    a.pending === b.pending &&
    a.error === b.error &&
    a.offline === b.offline &&
    a.revoked === b.revoked &&
    a.mismatched === b.mismatched &&
    a.primary === b.primary
  );
}

export class PageStore {
  readonly #listeners = new Set<() => void>();
  readonly #retryDelay: number;
  readonly #id: () => string;
  readonly #onCommitted: (revision: number) => void;
  readonly #onRefused: () => void;
  readonly #onOffline: () => void;
  readonly #onRevoked: () => void;
  /** The roots the page renders, in the order they were attached, and what each shows. */
  readonly #roots = new Map<string, Shown>();
  /** Each field's pending operations as components read them, kept until the field's change. */
  readonly #views = new Map<string, readonly PendingOperation[]>();
  #operations: Operation[] = [];
  /** The session the page's newest frame was rendered for, and that frame's revision. */
  #session: string | undefined = undefined;
  #sessionRevision = -Infinity;
  #error: string | null = null;
  #offline = false;
  #revoked = false;
  #mismatched = false;
  #sending = false;
  /**
   * The drains started, the one that sends the last: a frame that names the operation a drain waits
   * on, unanswered, lets another start (`#settle`), and the one that waited stops once it is answered.
   */
  #drains = 0;
  #disposed = false;
  #status: StoreStatus;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getStatus = (): StoreStatus => this.#status;

  /** The pending operations of `field`, the same array until one of them changes. */
  readonly pendingOf = (field: string): readonly PendingOperation[] => {
    let view = this.#views.get(field);
    if (view === undefined) {
      const operations = this.#operations.filter((operation) => operation.target.field === field);
      view =
        operations.length === 0
          ? NONE
          : Object.freeze(operations.map((operation) => viewOf(operation)));
      this.#views.set(field, view);
    }
    return view;
  };

  constructor(options: StoreOptions = {}) {
    this.#retryDelay = options.retryDelay ?? RETRY_DELAY_MS;
    this.#id = options.id ?? operationId;
    this.#onCommitted = options.onCommitted ?? ((): void => undefined);
    this.#onRefused = options.onRefused ?? ((): void => undefined);
    this.#onOffline = options.onOffline ?? ((): void => undefined);
    this.#onRevoked = options.onRevoked ?? ((): void => undefined);
    this.#status = this.#read();
  }

  #read(): StoreStatus {
    return Object.freeze({
      error: this.#error,
      mismatched: this.#mismatched,
      offline: this.#offline,
      pending: this.#operations.length,
      primary: this.#roots.keys().next().value,
      revoked: this.#revoked,
    });
  }

  #publish(): void {
    const status = this.#read();
    if (!sameStatus(status, this.#status)) {
      this.#status = status;
    }
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #changed(operation: Operation): void {
    this.#views.delete(operation.target.field);
  }

  #remove(dropped: (operation: Operation) => boolean): void {
    this.#operations = this.#operations.filter((operation) => {
      if (!dropped(operation)) {
        return true;
      }
      this.#changed(operation);
      return false;
    });
  }

  /**
   * Notes each operation a frame names as committed, and lets go of each one every frame of its
   * session reflects: nothing renders it on top of a frame any more. With no root attached, one
   * whose commit is known is let go of as well, as nothing renders it at all.
   *
   * A frame that names an operation whose outcome was unknown — its answer lost after the authority
   * committed it — answers what the page was checking: once no operation's outcome is unknown any
   * more, the page says so no longer, though no answer to a send of it ever comes.
   *
   * A commit a frame names before any answer said it — one that comes after, ignored once the
   * operation is let go of, or none — is told as a receipt's is (`onCommitted`): every root renders
   * that revision, which each must reflect before the operation is let go of.
   */
  #settle(): void {
    const shown = [...this.#roots.values()];
    let learned = -Infinity;
    this.#remove((operation) => {
      const own = shown.filter(({ session }) => session === operation.target.session);
      for (const { frame } of own) {
        // Named by a frame, it committed at that frame's revision at the latest.
        const named = reflects(frame, { committedRevision: null, id: operation.id });
        if (named && (operation.committedRevision ?? Infinity) > frame.revision) {
          if (operation.committedRevision === null) {
            learned = Math.max(learned, frame.revision);
            // Its commit known before its answer came, the writes after it go — they commit after
            // it, and a copy of it still on its way the authority answers with its receipt, writing
            // nothing again; `attach` starts their drain.
            if (operation.sending) {
              this.#sending = false;
            }
          }
          operation.committedRevision = frame.revision;
          this.#changed(operation);
        }
      }
      return (
        operation.committedRevision !== null && own.every(({ frame }) => reflects(frame, operation))
      );
    });
    if (this.#error === CHECKING && !this.#checking()) {
      this.#error = null;
    }
    if (learned > -Infinity) {
      this.#onCommitted(learned);
    }
  }

  /** Whether an operation was sent whose outcome is unknown: no answer said, and no frame named it. */
  #checking(): boolean {
    return this.#operations.some(
      (operation) => operation.attempts > 0 && operation.committedRevision === null,
    );
  }

  /** Starts sending, unless a send is already under way; `#drain` reports its own failures. */
  #sendAll(): void {
    void this.#drain().catch((error: unknown) => {
      this.#error = error instanceof Error ? error.message : NOT_SAVED;
      this.#publish();
    });
  }

  async #drain(): Promise<void> {
    if (this.#sending || this.#disposed) {
      return;
    }
    this.#sending = true;
    this.#drains += 1;
    const drain = this.#drains;
    try {
      let operation = this.#next();
      while (operation !== undefined) {
        if (!(await this.#send(operation)) || drain !== this.#drains) {
          break;
        }
        operation = this.#next();
      }
    } finally {
      if (drain === this.#drains) {
        this.#sending = false;
      }
    }
  }

  /** The next operation to send; none once the store is disposed, revoked or offline. */
  #next(): Operation | undefined {
    if (this.#disposed || this.#revoked || this.#offline) {
      return undefined;
    }
    return this.#operations.find(
      (operation) => !operation.sending && operation.committedRevision === null,
    );
  }

  /** Sends one operation; false when the store should stop sending for now. */
  async #send(operation: Operation): Promise<boolean> {
    operation.sending = true;
    operation.sent = true;
    let answer: Result<FieldReceipt> | undefined;
    try {
      answer = await operation.target.send(operationOf(operation));
    } catch {
      answer = undefined;
    }
    if (this.#disposed || this.#revoked) {
      return false;
    }
    const acknowledged = answer?.ok === true && isReceipt(answer.value) ? answer.value : undefined;
    // An operation a frame has settled already — or that was dropped meanwhile — takes no failure,
    // whatever its answer says: the answer was lost after the commit, or refuses a resend the commit
    // made moot.
    if (!this.#operations.includes(operation) || operation.committedRevision !== null) {
      if (acknowledged !== undefined && this.#operations.includes(operation)) {
        this.#acknowledged(operation, acknowledged);
      }
      return true;
    }
    if (acknowledged !== undefined) {
      this.#acknowledged(operation, acknowledged);
      return true;
    }
    if (answer !== undefined && !answer.ok && isDefinitive(answer.status)) {
      return this.#refused(operation, answer);
    }
    return this.#unknown(operation);
  }

  #acknowledged(operation: Operation, receipt: FieldReceipt): void {
    operation.committedRevision = receipt.committedRevision;
    this.#changed(operation);
    this.#error = null;
    this.#settle();
    this.#publish();
    this.#onCommitted(receipt.committedRevision);
  }

  #refused(operation: Operation, failure: Extract<Result<never>, { readonly ok: false }>): boolean {
    // A refusal for another build says the page's code no longer matches the authority's: every
    // later operation would be refused alike.
    if (failure.code === BUILD_MISMATCH) {
      this.mismatched();
      return false;
    }
    if (failure.status === HTTP_UNAUTHORIZED) {
      this.revoke(failure.message === '' ? REVOKED : failure.message);
      return false;
    }
    const binding = refusesBinding(failure);
    // Of the binding's operations, those not made yet would be refused alike; one that committed is
    // shown on top of each frame that does not reflect it until every frame does (`#settle`).
    this.#remove((pending) => {
      return binding
        ? pending.target.binding === operation.target.binding && pending.committedRevision === null
        : pending === operation;
    });
    // A refused resend says nothing of a send before it that went unanswered, which may have
    // committed — a write that took its own binding's target away is refused when sent again — so
    // the page says the change may have been made, and renders again to show whether it was.
    if (operation.unknown) {
      this.#error = UNCERTAIN;
    } else {
      this.#error = failure.message === '' ? NOT_SAVED : failure.message;
    }
    this.#publish();
    if (binding || operation.unknown) {
      this.#onRefused();
    }
    return true;
  }

  async #unknown(operation: Operation): Promise<boolean> {
    // The outcome is unknown: sent again under the same id, never counted as a failure.
    operation.sending = false;
    operation.unknown = true;
    operation.attempts += 1;
    this.#error = CHECKING;
    this.#publish();
    if (operation.attempts < MAX_ATTEMPTS) {
      await sleep(this.#retryDelay * operation.attempts);
      return true;
    }
    operation.recoveries += 1;
    // One that keeps failing however often the store comes back is given up rather than sent
    // forever: whether it was made, a frame says, which the page renders again for.
    if (operation.recoveries >= MAX_RECOVERIES) {
      this.#remove((pending) => pending === operation);
      this.#error = UNCERTAIN;
      this.#publish();
      this.#onRefused();
      return true;
    }
    this.#offline = true;
    this.#publish();
    this.#onOffline();
    return false;
  }

  /**
   * Whether an operation can be made now: none once the store was revoked or disposed. Refused
   * without a throw — it is an event handler's call, where a throw is nobody's to catch — and the
   * revocation keeps its own message.
   */
  #ready(): boolean {
    return !this.#revoked && !this.#disposed;
  }

  #refuse(message: string): void {
    this.#error = message;
    this.#publish();
  }

  #operation(target: WriteTarget, write: Write): Operation {
    const { binding, field, send, session, updaterId } = target;
    return {
      attempts: 0,
      committedRevision: null,
      id: this.#id(),
      recoveries: 0,
      sending: false,
      sent: false,
      unknown: false,
      target: { binding, field, send, session, updaterId },
      write,
    };
  }

  #push(operation: Operation): string {
    this.#operations.push(operation);
    this.#changed(operation);
    if (this.#offline) {
      // Offline, no send starts: `resume` sends it, and the error shown, which says why the store
      // is offline, still holds.
      this.#publish();
      return operation.id;
    }
    this.#error = null;
    this.#publish();
    this.#sendAll();
    return operation.id;
  }

  #switch(session: string | undefined, revision: number): void {
    this.#session = session;
    this.#sessionRevision = revision;
    this.#remove((operation) => operation.target.session !== session);
    // Another session is another start: what the one before ran into is not this one's.
    if (!this.#mismatched) {
      this.#revoked = false;
      this.#offline = false;
      this.#error = null;
    }
  }

  #end(message: string, mismatched: boolean): void {
    if (this.#disposed) {
      return;
    }
    const first = !this.#revoked;
    this.#revoked = true;
    this.#mismatched ||= mismatched;
    this.#remove(() => true);
    // The first revocation says why the page stopped; a reload asked for says more than it.
    if (first || mismatched) {
      this.#error = message;
    }
    this.#offline = false;
    this.#publish();
    if (first && !mismatched) {
      this.#onRevoked();
    }
  }

  /**
   * Writes `value` to a field through a registered `set`, which the authority checks against the
   * field before anything is written; the value is shown at once. Returns the operation's id, or
   * nothing when it was refused here.
   *
   * Unlike an `apply`, a `set` is taken while the store is offline, and sent once it resumes: a
   * controlled input shows what the store shows, so a refused keystroke would be taken back from
   * under the caret, and a composition of an input method under way would end.
   */
  set(write: SetWrite): string | undefined {
    if (!this.#ready()) {
      return undefined;
    }
    // The last operation gives way when it is a `set` of the field never sent: what it would write,
    // this one writes over before anyone could read it. The last alone: an operation of another
    // field made after it was made on what it showed, so it is kept before that one.
    const previous = this.#operations.at(-1);
    const replacing =
      previous?.write.kind === 'set' &&
      !previous.sent &&
      previous.target.field === write.field &&
      previous.target.updaterId === write.updaterId &&
      previous.target.session === write.session;
    if (!replacing && this.#operations.length >= MAX_PENDING) {
      this.#refuse(TOO_MANY);
      return undefined;
    }
    if (replacing) {
      this.#operations.pop();
    }
    return this.#push(this.#operation(write, { kind: 'set', value: write.value }));
  }

  /**
   * Writes a field through a registered `apply`: `predict` shows the result at once, and the
   * authority computes the real one with its own copy of the update, from the values the call
   * captured — copied here, so that nothing the page changes later changes what was sent. Returns
   * the operation's id, or nothing when it was refused here.
   */
  apply(write: ApplyWrite): string | undefined {
    if (!this.#ready()) {
      return undefined;
    }
    if (this.#offline) {
      this.#refuse(OFFLINE);
      return undefined;
    }
    if (this.#operations.length >= MAX_PENDING) {
      this.#refuse(TOO_MANY);
      return undefined;
    }
    const captures = Object.freeze(toJsonRecord(write.captures, 'What the update captured'));
    return this.#push(this.#operation(write, { captures, kind: 'apply', predict: write.predict }));
  }

  /**
   * A root shows `frame`, rendered for `session`. A newer frame of another session than the page
   * showed — the browser signed in again — takes the page to that session: the operations of the
   * one before are dropped, never sent as the new one nor shown on its frames. A frame rendered while
   * the store was offline says the server answers again, and the store resumes.
   */
  attach(root: string, frame: Frame, session: string | undefined): void {
    if (this.#disposed) {
      return;
    }
    const previous = this.#roots.get(root);
    this.#roots.set(root, { frame, session });
    if (session !== this.#session && frame.revision >= this.#sessionRevision) {
      this.#switch(session, frame.revision);
    } else if (session === this.#session) {
      this.#sessionRevision = Math.max(this.#sessionRevision, frame.revision);
    }
    this.#settle();
    if (this.#offline && previous?.frame !== frame) {
      this.resume();
      return;
    }
    this.#publish();
    this.#sendAll();
  }

  /** The session the page shows now, as its newest frame was rendered for it. */
  get session(): string | undefined {
    return this.#session;
  }

  /** A root the page no longer renders: its frame holds no operation back any more. */
  detach(root: string): void {
    if (!this.#roots.delete(root) || this.#disposed) {
      return;
    }
    this.#settle();
    this.#publish();
  }

  /** After an outage: sends again what was never acknowledged, and what was made offline. */
  resume(): void {
    if (this.#revoked || this.#disposed) {
      return;
    }
    // Only a store that was offline sends its operations again from their first attempt: one that
    // stayed online is still sending them, and must not start their count again.
    if (this.#offline) {
      for (const operation of this.#operations) {
        if (operation.committedRevision === null) {
          operation.sending = false;
          operation.attempts = 0;
        }
      }
    }
    this.#offline = false;
    this.#publish();
    this.#sendAll();
  }

  /** Forgets every pending operation and sends nothing more: the session ended. */
  revoke(message = REVOKED): void {
    this.#end(message, false);
  }

  /** The page's code no longer matches the authority's: revoked, and asked to reload. */
  mismatched(): void {
    this.#end(UPDATED, true);
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }
}
