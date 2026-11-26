import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { framedArrayString } from './framed-arrays.ts';
import { frameTypeOf } from './framed-bindings.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedPrimitiveInputType } from './framed-string-receivers.ts';
import { isTypeOnly } from './scope.ts';

/** Added array argument conversions require quiet complete evaluation and native text ordering. */

const URI_CONVERSIONS = new Set([
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
]);

const NATIVE_TEXT_INPUTS = new Set([
  ...URI_CONVERSIONS,
  'Reflect.apply',
  'String',
  'String.prototype',
  'String.prototype.concat',
  'String.prototype.endsWith',
  'String.prototype.includes',
  'String.prototype.indexOf',
  'String.prototype.lastIndexOf',
  'String.prototype.localeCompare',
  'String.prototype.match',
  'String.prototype.matchAll',
  'String.prototype.padEnd',
  'String.prototype.padStart',
  'String.prototype.replace',
  'String.prototype.replaceAll',
  'String.prototype.search',
  'String.prototype.split',
  'String.prototype.startsWith',
]);

const CONSTRUCTIBLE_TEXT_INPUTS: ReadonlySet<string> = new Set(['String']);

interface ArrayTextWords {
  readonly error: (value: Expression) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Ordinary array arguments add word observations only inside a closed native text invocation. */
export function framedArrayTextArguments(
  args: readonly Expression[],
  words: ArrayTextWords,
  call: Node,
): boolean {
  return (
    isCallExpression(call) &&
    quietArrayCall(call) &&
    args.every((value) => quietConvertedValue(value, words, call)) &&
    args.some((value) => !isSpreadElement(value) && framedArrayString(value, words, call))
  );
}

/** Current callee, receiver, every evaluated argument and earlier owner work remain independent proofs. */
function quietArrayCall(call: CallExpression): boolean {
  return (
    quietCallee(call) &&
    quietReceiver(call) &&
    framedQuietInputs(call.arguments, NATIVE_TEXT_INPUTS) &&
    quietConstructors(call) &&
    framedQuietOwnerPrefix(call, {
      primitive: framedQuietPrimitive,
      value: (value) => framedNativeConstructor(value, NATIVE_TEXT_INPUTS),
    })
  );
}

/** Only native String among the permitted text-input values is constructible. */
function quietConstructors(call: CallExpression): boolean {
  const pending: Node[] = [...call.arguments];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isNewExpression(node) &&
      !framedNativeConstructor(node.expression, CONSTRUCTIBLE_TEXT_INPUTS)
    )
      return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** A computed method key cannot perform application work before selecting the native conversion. */
function quietCallee(call: CallExpression): boolean {
  let value = unwrapped(call.expression);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
      return false;
    value = unwrapped(value.expression);
  }
  return true;
}

/** URI natives ignore this; string methods first convert a non-null primitive receiver. */
function quietReceiver(call: CallExpression): boolean {
  const borrowed = borrowedTextCall(call);
  if (borrowed !== undefined)
    return (
      URI_CONVERSIONS.has(borrowed.path.join('.')) || quietReceiverValue(borrowed.receiver, call)
    );
  if (framedNativeConstructor(call.expression, URI_CONVERSIONS)) return true;
  const member = unwrapped(call.expression);
  return (
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    quietReceiverValue(member.expression, call)
  );
}

/** A literal primitive or unchanged explicitly primitive input cannot invoke a conversion hook. */
function quietReceiverValue(value: Expression, call: CallExpression): boolean {
  const source = framedQuietSource(value, false);
  if (
    source === undefined ||
    source.kind === SyntaxKind.NullKeyword ||
    globalPathOf(source)?.join('.') === 'undefined'
  )
    return false;
  if (framedQuietPrimitive(value)) return true;
  const reading = frameTypeOf(value);
  return (
    reading !== undefined &&
    framedPrimitiveInputType(reading.type, reading.keys) &&
    framedNativeErrorInput(value, call)
  );
}

/** Earlier consumed values cannot replace a later array's text methods or Error words. */
function quietConvertedValue(
  value: Expression,
  words: ArrayTextWords,
  call: CallExpression,
): boolean {
  if (isSpreadElement(value)) return framedQuietArrayWords(value.expression, words.error, call);
  return (
    framedQuietArrayWords(value, words.error, call) ||
    (framedNativeErrorInput(value, call, undefined, false) &&
      (words.error(value) || words.typed(value)))
  );
}
