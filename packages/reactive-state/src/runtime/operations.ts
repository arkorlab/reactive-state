import type { Frame, Value } from '../program.ts';

/**
 * What a page shows of a field: the value the frame it was rendered with confirms, and on top of
 * it the operations this session has made of the field that the frame does not reflect yet, in the
 * order they were made. Computed as a component renders, never stored: a frame and what it reflects
 * arrive together, so an operation is shown on top of a frame that does not reflect it and never on
 * top of one that does — not twice, whatever order its acknowledgement and the frame arrive in.
 */

/**
 * What a registered `apply` predicts: the value shown in, the value to show out. The authority
 * never runs it; it runs its own copy of the update, with the values the call captured.
 */
export type Predictor = (current: Value) => Value;

interface Pending {
  readonly id: string;
  /** The field's key: `table:id:field`. */
  readonly field: string;
  /**
   * The session the page was rendered for when the operation was made: a page rendered for
   * another session — signed in again, as someone else — never shows it.
   */
  readonly session: string | undefined;
  /** The revision its commit was answered with, or a frame said it was reflected at; else `null`. */
  readonly committedRevision: number | null;
}

/** A registered `set`, which shows the value it writes. */
interface PendingSet extends Pending {
  readonly kind: 'set';
  readonly value: Value;
}

/** A registered `apply`, shown by running `predict` on the value shown before it. */
interface PendingApply extends Pending {
  readonly kind: 'apply';
  readonly predict: Predictor;
}

/** An operation the page has made that no frame it shows may reflect yet. */
export type PendingOperation = PendingApply | PendingSet;

/** The operations each frame names, read once per frame however many fields render from it. */
const named = new WeakMap<Frame, ReadonlySet<string>>();

function namedBy(frame: Frame): ReadonlySet<string> {
  let ids = named.get(frame);
  if (ids === undefined) {
    ids = new Set(frame.operations);
    named.set(frame, ids);
  }
  return ids;
}

/**
 * Whether `frame` reflects an operation: it names it among the operations it was read after, or
 * was read at or after the revision the operation committed at — what the bounded list of names
 * may have let go of.
 */
export function reflects(
  frame: Frame,
  operation: Pick<Pending, 'committedRevision' | 'id'>,
): boolean {
  return (
    namedBy(frame).has(operation.id) ||
    (operation.committedRevision !== null && operation.committedRevision <= frame.revision)
  );
}

/**
 * The value of `field` a page rendered with `frame`, for `session`, shows: the frame's, with each
 * of `pending` the frame does not reflect applied on top in the order they were made. A prediction
 * that throws leaves the value as it was; nothing at all for a field the frame does not hold and no
 * `set` writes.
 */
export function displayValue(
  frame: Frame,
  session: string | undefined,
  pending: readonly PendingOperation[],
  field: string,
): Value | undefined {
  let value: Value | undefined = frame.fields[field];
  for (const operation of pending) {
    if (operation.field !== field || operation.session !== session || reflects(frame, operation)) {
      continue;
    }
    if (operation.kind === 'set') {
      value = operation.value;
      continue;
    }
    if (value === undefined) {
      continue;
    }
    try {
      value = operation.predict(value);
    } catch {
      // A prediction that throws leaves the value as it was: the authority's own update decides.
    }
  }
  return value;
}
