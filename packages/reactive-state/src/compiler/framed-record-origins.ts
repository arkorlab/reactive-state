import {
  type Expression,
  type Identifier,
  isIdentifier,
  isObjectLiteralExpression,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedPossibleBranch, reachedLoopRead } from './framed-writes.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Saved literal records retain their initializer only until a possible write or mutable exposure. */

interface RecordOrigin {
  readonly record: ObjectLiteralExpression;
  readonly unchanged: boolean;
}

interface RecordRead {
  readonly consumer: Node;
  readonly bindings: ReadonlySet<FrameBinding>;
  readonly selected: ReadonlySet<Identifier>;
  readonly reached: boolean | 'loops';
}

/**
 * Whole lexical aliases preserve a record identity separately from its unchanged-field proof. A use
 * that may run before the consumer changes the record: one written before it, but for one in a
 * destructuring pattern whose source holds the consumer, and one in a loop's condition, update or
 * body on the next pass. Where `reached`, for a reader that keeps what a changed record may hold, one
 * in what a pattern around the consumer destructures too, run first though written after; where
 * false, for a reader whose proof a change drops, only a loop body's uses repeat.
 */
export function framedRecordOrigin(
  expression: Expression,
  consumer: Node,
  reached: boolean | 'loops' = 'loops',
): RecordOrigin | undefined {
  let value = unwrapped(expression);
  const bindings = new Set<FrameBinding>();
  const selected = new Set<Identifier>();
  while (isIdentifier(value)) {
    const reading = frameBindingOf(value);
    if (
      reading === undefined ||
      reading.keys.length > 0 ||
      reading.binding.initializer === undefined ||
      bindings.has(reading.binding)
    )
      return undefined;
    bindings.add(reading.binding);
    selected.add(value);
    value = unwrapped(reading.binding.initializer);
  }
  if (!isObjectLiteralExpression(value)) return undefined;
  return { record: value, unchanged: unchangedRecord({ consumer, bindings, selected, reached }) };
}

/** Every possible earlier or repeated use retains mutable-record opacity, independently of text fields. */
function unchangedRecord(read: RecordRead): boolean {
  if (read.bindings.size === 0) return true;
  const pending: Node[] = [read.consumer.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && exposedRecord(node, read)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Whole selected wiring is harmless; other prior, same-call or captured uses may replace entries. */
function exposedRecord(name: Identifier, read: RecordRead): boolean {
  if (!readsBinding(name) || read.selected.has(name)) return false;
  const reading = frameBindingOf(name);
  if (reading === undefined || name === reading.binding.name || !read.bindings.has(reading.binding))
    return false;
  const reader = executionOwner(read.consumer);
  const owner = executionOwner(name);
  if (owner === reader) {
    if (
      (name.pos >= read.consumer.end || destructuredFirst(read.consumer, name)) &&
      !(read.reached === true && destructuredFirst(name, read.consumer)) &&
      !reachedLoopRead(read.reached)(name, read.consumer, reading.binding, reader)
    )
      return false;
  } else if (unreferencedLocalFunction(owner, reader)) return false;
  return framedPossibleBranch(name);
}
