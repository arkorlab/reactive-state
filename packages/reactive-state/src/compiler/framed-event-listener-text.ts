import {
  type CallExpression,
  type Expression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { arrayError } from './framed-arrays.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import {
  LISTENER_METHODS,
  LISTENER_NATIVES,
  quietListenerCallback,
  quietListenerInputs,
} from './framed-listener-inputs.ts';
import { framedListenerReceiver } from './framed-listener-receivers.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietData,
  framedQuietPrimitive,
} from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';

/** Native EventTarget add/remove listener calls convert their first event-type slot before registration. */

const METHODS = new Set(['addEventListener', 'removeEventListener']);
interface ListenerWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Known native receiver identity and explicit native borrowing retain the same consumed type slot. */
export function framedEventListenerText(call: CallExpression, words: ListenerWords): boolean {
  if (!quietListenerInputs(call.arguments) || !quietMemberKeys(call.expression)) return false;
  const args = listenerArguments(call);
  if (
    args === undefined ||
    !quietListenerInputs(args) ||
    !framedQuietTextPrefix(call, LISTENER_NATIVES, quietEarlierListenerCall)
  )
    return false;
  const error = (each: Expression, keys?: readonly string[]) =>
    framedOriginCoowned(each, call) && words.error(each, keys);
  return framedConsumedArguments(call, args, 1).some((argument) => {
    const spread = isSpreadElement(argument);
    const value = spread ? argument.expression : argument;
    return (
      (!spread && framedNativeErrorInput(value, call) && error(value)) ||
      (framedQuietArrayWords(value, error, call) &&
        arrayError(value, { error, typed: words.typed }, call))
    );
  });
}

/** Borrowing keeps the actual receiver separate from the converted event type. */
function listenerArguments(call: CallExpression): readonly Expression[] | undefined {
  const native = framedNativeArguments(call, LISTENER_METHODS);
  if (native !== undefined) {
    if (native.constructed || native.args === undefined || !quietMemberKeys(native.target))
      return undefined;
    const reflected = globalPathOf(unwrapped(call.expression))?.join('.') === 'Reflect.apply';
    const receiver = framedArgumentPrefix(call, call.arguments).values[reflected ? 1 : 0];
    return receiver !== undefined && framedListenerReceiver(receiver, call)
      ? native.args
      : undefined;
  }
  const member = unwrapped(call.expression);
  return (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    METHODS.has(frameMemberName(member) ?? '') &&
    framedListenerReceiver(member.expression, call)
    ? call.arguments
    : undefined;
}

/** Computed member keys may not run an ignored application effect before type conversion. */
function quietMemberKeys(expression: Expression): boolean {
  let value = unwrapped(expression);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
      return false;
    value = unwrapped(value.expression);
  }
  return true;
}

/** Native registration does not invoke a closed callback; prior type and option conversion stays quiet. */
function quietEarlierListenerCall(call: CallExpression): boolean {
  if (!quietListenerInputs(call.arguments) || !quietMemberKeys(call.expression)) return false;
  const args = listenerArguments(call);
  if (args === undefined || !quietListenerInputs(args)) return false;
  const prefix = framedArgumentPrefix(call, args, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return false;
  const type = prefix.values[0];
  const options = prefix.values[2];
  return (
    type !== undefined &&
    framedQuietPrimitive(type) &&
    quietListenerCallback(prefix.values[1]) &&
    (options === undefined || framedQuietData(options))
  );
}
