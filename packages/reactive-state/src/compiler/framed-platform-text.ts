import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
  type NewExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { arrayError } from './framed-arrays.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedBlobParts } from './framed-blob-parts.ts';
import { framedBorrowedInputs, type BorrowedInputs } from './framed-borrowed-inputs.ts';
import { framedConstructorInitText } from './framed-constructor-init-text.ts';
import { framedEncoderSource, framedOwnEncoderMethod } from './framed-encoder-methods.ts';
import { framedEncoderStreamText } from './framed-encoder-stream-text.ts';
import { framedEventListenerText } from './framed-event-listener-text.ts';
import { framedEventMethodText } from './framed-event-methods.ts';
import { framedAppliedArguments } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedParamMethodText } from './framed-param-methods.ts';
import { framedRequestBodyText } from './framed-request-body-text.ts';
import { framedResponseStatusText } from './framed-response-status.ts';
import { framedSearchParamsText } from './framed-search-params-text.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { framedUrlSetterText } from './framed-url-setters.ts';

/** Native text consumers retain the supplied words converted in their consumed argument slots. */

const TEXT_FUNCTIONS = new Set(['atob', 'btoa', 'Symbol', 'Symbol.for']);
const RESPONSE_CONSTRUCTORS = new Set(['Response']);
const URL_PARSERS = new Set(['URL.parse']);
const URL_CONSTRUCTORS = new Set(['URL']);
const EVENT_CONSTRUCTORS = new Set(['CustomEvent', 'Event']);
const ENCODER_METHODS = new Set(['encode', 'encodeInto']);

interface ConvertedWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Only a known native instance or borrowed native method establishes encoder conversion. */
export function framedPlatformText(
  node: Node,
  error: (value: Expression, keys?: readonly string[]) => boolean,
  typed: (value: Expression) => boolean,
): boolean {
  const words = { error, typed };
  if (framedUrlSetterText(node, words)) return true;
  if (!isCallExpression(node) && !isNewExpression(node)) return false;
  if (framedRequestBodyText(node, words)) return true;
  if (framedBlobParts(node, words)) return true;
  if (framedConstructorInitText(node, words)) return true;
  if (framedResponseStatusText(node, words)) return true;
  const response = framedNativeArguments(node, RESPONSE_CONSTRUCTORS);
  if (response?.constructed === true)
    return response.args === undefined
      ? response.applied !== undefined && arrayError(response.applied, words, node)
      : convertedArgument(node, response.args, words);
  if (isNewExpression(node)) return constructedText(node, words);
  if (framedNativeConstructor(node.expression, TEXT_FUNCTIONS))
    return convertedArgument(node, node.arguments, words);
  const inputs = framedBorrowedInputs(node, TEXT_FUNCTIONS);
  if (inputs !== undefined) return borrowedTextWords(node, inputs, words);
  return platformMethodText(node, words);
}

/** Native constructions retain their existing constructor-specific consumed inputs. */
function constructedText(node: NewExpression, words: ConvertedWords): boolean {
  if (framedNativeConstructor(node.expression, URL_CONSTRUCTORS))
    return convertedArgument(node, node.arguments ?? [], words, 2);
  if (framedNativeConstructor(node.expression, EVENT_CONSTRUCTORS))
    return convertedArgument(node, node.arguments ?? [], words);
  return framedBlobParts(node, words) || framedSearchParamsText(node, words);
}

/** Native method text consumers keep their own receiver and consumed-argument proofs. */
function platformMethodText(node: CallExpression, words: ConvertedWords): boolean {
  return (
    urlParseText(node, words) ||
    encoderText(node, words) ||
    framedEncoderStreamText(node, words) ||
    framedParamMethodText(node, words) ||
    framedEventListenerText(node, words) ||
    framedEventMethodText(node, words)
  );
}

/** Static URL parsing converts its first input and optional base, including native borrowing. */
function urlParseText(node: CallExpression, words: ConvertedWords): boolean {
  const selected = framedNativeArguments(node, URL_PARSERS);
  if (selected !== undefined && !selected.constructed)
    return selected.args === undefined
      ? selected.applied !== undefined && arrayError(selected.applied, words, node)
      : convertedArgument(node, selected.args, words, 2);
  const member = unwrapped(node.expression);
  return (
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === 'parse' &&
    framedNativeConstructor(member.expression, URL_CONSTRUCTORS) &&
    convertedArgument(node, node.arguments, words, 2)
  );
}

/** Native encoder receiver and borrowed-method proofs retain their existing conversion. */
function encoderText(node: CallExpression, words: ConvertedWords): boolean {
  const member = unwrapped(node.expression);
  if (
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    ENCODER_METHODS.has(frameMemberName(member) ?? '') &&
    framedEncoderSource(member.expression) !== undefined
  )
    return !framedOwnEncoderMethod(node) && convertedArgument(node, node.arguments, words);
  const borrowed = borrowedTextCall(node);
  if (borrowed === undefined) return false;
  const path = borrowed.path.join('.');
  if (
    !TEXT_FUNCTIONS.has(path) &&
    (framedEncoderSource(borrowed.receiver) === undefined ||
      borrowed.path.slice(0, -1).join('.') !== 'TextEncoder.prototype' ||
      !ENCODER_METHODS.has(borrowed.path.at(-1) ?? ''))
  )
    return false;
  if (borrowed.applied === undefined) return convertedArgument(node, borrowed.given, words);
  const args = framedAppliedArguments(node, borrowed.applied);
  return args === undefined
    ? arrayError(borrowed.applied, words, node)
    : convertedArgument(node, args, words);
}

/** Later destination, receiver and ignored arguments do not become text input. */
function convertedArgument(
  call: CallExpression | NewExpression,
  args: readonly Expression[],
  words: ConvertedWords,
  limit = 1,
): boolean {
  return framedConsumedArguments(call, args, limit).some((argument) => {
    const spread = isSpreadElement(argument);
    const value = spread ? argument.expression : argument;
    return (!spread && words.error(value)) || arrayError(value, words, call);
  });
}

/** Each possible first native input or apply list retains conversion; ignored receivers stay excluded. */
function borrowedTextWords(
  call: CallExpression,
  inputs: BorrowedInputs,
  words: ConvertedWords,
): boolean {
  return inputs.inputs.some((value) => {
    if (!inputs.applied) return convertedArgument(call, [value], words);
    const args = framedAppliedArguments(call, value);
    return args === undefined
      ? arrayError(value, words, call)
      : convertedArgument(call, args, words);
  });
}
