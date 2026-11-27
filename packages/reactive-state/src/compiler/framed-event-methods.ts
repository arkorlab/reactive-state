import {
  type CallExpression,
  type Expression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { arrayError } from './framed-arrays.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietData,
  framedQuietInputs,
} from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';

/** Native initEvent converts its type argument, independently of the boolean flags beside it. */

const EVENTS = new Set(['CustomEvent', 'Event']);
const INITIALIZERS = new Set(['CustomEvent.prototype.initEvent', 'Event.prototype.initEvent']);
const QUIET_EVENTS = new Set(INITIALIZERS);
for (const name of EVENTS) QUIET_EVENTS.add(name);

interface EventWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** A source-known fresh instance or explicit native borrowing fixes the converted first slot. */
export function framedEventMethodText(call: CallExpression, words: EventWords): boolean {
  if (!framedQuietInputs(call.arguments, QUIET_EVENTS)) return false;
  const borrowed = borrowedEventArguments(call);
  if (borrowed !== undefined) return convertedEventArguments(call, borrowed, words);
  const member = unwrapped(call.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'initEvent' ||
    (isElementAccessExpression(member) &&
      !framedQuietInputs([member.argumentExpression], QUIET_EVENTS))
  )
    return false;
  const source = nativeEventSource(member.expression);
  return (
    source !== undefined &&
    !argumentArrayExposed(member.expression, source.bindings, undefined, false) &&
    convertedEventArguments(call, call.arguments, words)
  );
}

/** Borrowed native initialization ignores own methods, while unresolved applied lists stay opaque. */
function borrowedEventArguments(call: CallExpression): readonly Expression[] | undefined {
  const native = framedNativeArguments(call, INITIALIZERS);
  if (native === undefined || native.constructed || native.args === undefined) return undefined;
  const reflected = globalPathOf(unwrapped(call.expression))?.join('.') === 'Reflect.apply';
  const receiver = framedArgumentPrefix(call, call.arguments).values[reflected ? 1 : 0];
  return receiver === undefined || nativeEventSource(receiver) === undefined
    ? undefined
    : native.args;
}

/** Whole constant receiver aliases preserve their original unshadowed native construction. */
function nativeEventSource(
  expression: Expression,
): { readonly bindings: ReadonlySet<FrameBinding> } | undefined {
  let value = unwrapped(expression);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || bindings.has(selected.binding))
      return undefined;
    const { binding } = selected;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isNewExpression(value) &&
    framedNativeConstructor(value.expression, EVENTS) &&
    (value.arguments ?? []).every((argument) => framedQuietData(argument))
    ? { bindings }
    : undefined;
}

/** Only the event type becomes text; flags and later ignored arguments keep their own values. */
function convertedEventArguments(
  call: CallExpression,
  args: readonly Expression[],
  words: EventWords,
): boolean {
  if (!framedQuietInputs(args, QUIET_EVENTS)) return false;
  return framedConsumedArguments(call, args, 1).some((argument) => {
    const spread = isSpreadElement(argument);
    const value = spread ? argument.expression : argument;
    return (
      (!spread && framedNativeErrorInput(value, call, undefined, false) && words.error(value)) ||
      (framedQuietArrayWords(value, words.error, call) && arrayError(value, words, call))
    );
  });
}
