import {
  type CallExpression,
  type Expression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { argumentArrayReached, selectedError } from './framed-array-selections.ts';
import { arrayMethodMayBeOverridden } from './framed-arrays.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';

interface Removal {
  readonly receiver: Expression;
  readonly method: string;
  readonly borrowed: boolean;
}

/** Native pop and shift retain the selected element rather than converting the whole array. */
export function framedArrayRemoval(
  call: CallExpression,
  proof: Parameters<typeof selectedError>[2],
): boolean | undefined {
  const selected = removal(call);
  if (selected === undefined) return undefined;
  if (!selected.borrowed && arrayMethodMayBeOverridden(call, selected.method)) return true;
  const index = selected.method === 'pop' ? -1 : 0;
  return selectedError(
    selected.receiver,
    receiverExposed(selected.receiver) ? undefined : index,
    proof,
    call,
  );
}

/** Borrowed native methods ignore receiver-owned implementations and every supplied argument. */
function removal(call: CallExpression): Removal | undefined {
  const borrowed = borrowedTextCall(call);
  const path = borrowed?.path.join('.');
  if (
    borrowed !== undefined &&
    (path === 'Array.prototype.pop' || path === 'Array.prototype.shift')
  )
    return { receiver: borrowed.receiver, method: borrowed.path.at(-1) ?? '', borrowed: true };
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = frameMemberName(member);
  return method === 'pop' || method === 'shift'
    ? { receiver: unwrapped(member.expression), method, borrowed: false }
    : undefined;
}

/** Whole unchanged aliases preserve a position; prior or deferred exposures retain every element. */
function receiverExposed(expression: Expression): boolean {
  let value = unwrapped(expression);
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
      return true;
    aliases.add(selected.binding);
    const { initializer } = selected.binding;
    if (initializer === undefined) break;
    value = unwrapped(initializer);
  }
  return argumentArrayReached(expression, aliases);
}
