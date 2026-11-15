import {
  type CallExpression,
  type Expression,
  isElementAccessExpression,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';

/** Native one-input borrowed calls retain ordered runtime slots across known receiver spreads. */

export interface BorrowedInputs {
  readonly inputs: readonly Expression[];
  readonly applied: boolean;
}

/** Only a proved native target supplies possible text inputs or apply lists after its ignored receiver. */
export function framedBorrowedInputs(
  call: CallExpression,
  names: ReadonlySet<string>,
): BorrowedInputs | undefined {
  const callee = unwrapped(call.expression);
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    const target = framedArgumentPrefix(call, call.arguments, 1).values[0];
    return target !== undefined && framedNativeConstructor(target, names)
      ? { inputs: inputSlot(call, 2), applied: true }
      : undefined;
  }
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const method = frameMemberName(callee);
  if (
    (method !== 'call' && method !== 'apply') ||
    !framedNativeConstructor(callee.expression, names)
  )
    return undefined;
  return { inputs: inputSlot(call, 1), applied: method === 'apply' };
}

/** An unknown prefix retains possible visible inputs without treating its known receiver as input. */
function inputSlot(call: CallExpression, index: number): readonly Expression[] {
  const prefix = framedArgumentPrefix(call, call.arguments, index + 1);
  if (!prefix.unknown) {
    const value = prefix.values[index];
    return value === undefined ? [] : [value];
  }
  const fixed = new Set(prefix.values.slice(0, index));
  return framedConsumedArguments(call, call.arguments, index + 1).filter(
    (value) => !fixed.has(value),
  );
}
