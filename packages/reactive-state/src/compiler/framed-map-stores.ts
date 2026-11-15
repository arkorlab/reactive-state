import type { CallExpression, Expression } from 'typescript/ast';

import { executionOwner } from './framed-array-mutations.ts';
import { framedArgumentPrefix } from './framed-keys.ts';

/** What the possible writes of a Map's selected key leave stored there. */

/** A possible write of the selected key; an open one runs an own method that acts on the Map. */
export interface MapWrite {
  readonly call: CallExpression;
  readonly value: Expression | undefined;
  readonly definite: boolean;
  /** An own method that acts on the Map may store any of its arguments, or anything, anywhere. */
  readonly open: boolean;
  /** The call may run an own method in place of the native one. */
  readonly custom: boolean;
}

/** The possible stored values, whether they are all of them, and whether the receiver stays. */
export interface MapValues {
  readonly values: readonly Expression[];
  readonly complete: boolean;
  readonly sameReceiver: boolean;
}

/**
 * The last definite native write replaces earlier entries, including a known undefined value. An
 * open write keeps every argument of its call and leaves the entries unknown.
 */
export function framedStoredValues(
  read: CallExpression,
  writes: readonly MapWrite[],
  initial: readonly Expression[] | undefined,
  sameReceiver: boolean,
): MapValues {
  let latest: MapWrite | undefined;
  for (const write of writes)
    if (write.definite && (latest === undefined || write.call.end > latest.call.end))
      latest = write;
  const values = latest === undefined ? [...(initial ?? [])] : [];
  if (latest?.value !== undefined) values.push(latest.value);
  const owner = executionOwner(read);
  const kept = writes.filter((write) => {
    return (
      latest === undefined ||
      write.call.end > latest.call.end ||
      executionOwner(write.call) !== owner
    );
  });
  for (const write of kept) values.push(...writtenValues(write));
  return {
    values,
    complete: kept.every((write) => !write.open) && (latest !== undefined || initial !== undefined),
    sameReceiver,
  };
}

/**
 * Writes a proof cannot follow keep every value they may store beside the entries; none replaces
 * another, and any one leaves the entries unknown.
 */
export function framedUnprovenValues(
  writes: readonly MapWrite[],
  initial: readonly Expression[] | undefined,
  sameReceiver: boolean,
): MapValues {
  return {
    values: [...(initial ?? []), ...writes.flatMap((write) => writtenValues(write))],
    complete: writes.length === 0,
    sameReceiver,
  };
}

/** A native write's value, or every argument an open own method may store. */
function writtenValues(write: MapWrite): readonly Expression[] {
  if (write.open) return framedArgumentPrefix(write.call, undefined, Infinity).values;
  return write.value === undefined ? [] : [write.value];
}
