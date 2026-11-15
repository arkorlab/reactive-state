import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isAwaitExpression,
  isBlock,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isReturnStatement,
  isSpreadElement,
  isVariableDeclaration,
  isVariableStatement,
  type Statement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { arrayError } from './framed-arrays.ts';
import {
  framedEncoderStreamRead,
  framedEncoderStreamSource,
  framedEncoderStreamUnexposed,
  streamMember,
  type EncoderStreamSource,
} from './framed-encoder-stream-source.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietInputs,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';

/** A closed native encoder write/read handoff retains the chunk's converted Error words. */

const WRITES = new Set(['WritableStreamDefaultWriter.prototype.write']);
const NATIVES = new Set([
  'Reflect.apply',
  'TextEncoderStream',
  'WritableStreamDefaultWriter.prototype',
  ...WRITES,
  'WritableStreamDefaultWriter.prototype.write.apply',
  'WritableStreamDefaultWriter.prototype.write.call',
]);

interface StreamWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** The next statement must directly await a first default read before application work can intervene. */
export function framedEncoderStreamText(call: CallExpression, words: StreamWords): boolean {
  const write = encoderWrite(call);
  if (write === undefined || !quietStreamInputs(call.arguments)) return false;
  const read = nextAwaitedRead(call);
  const reader = read === undefined ? undefined : framedEncoderStreamRead(read);
  if (
    read === undefined ||
    reader === undefined ||
    !framedEncoderStreamUnexposed(write.source, reader, call, read) ||
    !framedQuietTextPrefix(call, NATIVES, quietStreamAcquisition)
  )
    return false;
  const error = (each: Expression, keys?: readonly string[]) =>
    framedOriginCoowned(each, call) && words.error(each, keys);
  const chunk = write.chunk;
  return (
    (framedNativeErrorInput(chunk, call) && error(chunk)) ||
    (framedQuietArrayWords(chunk, error, call) &&
      arrayError(chunk, { error, typed: words.typed }, call))
  );
}

/** Native borrowing retains the original receiver and the single consumed chunk slot. */
function encoderWrite(
  call: CallExpression,
): { readonly source: EncoderStreamSource; readonly chunk: Expression } | undefined {
  const native = framedNativeArguments(call, WRITES);
  let args: readonly Expression[];
  let receiver: Expression | undefined;
  if (native === undefined) {
    const method = streamMember(call.expression);
    if (method?.name !== 'write') return undefined;
    receiver = method.value;
    args = call.arguments;
  } else {
    if (native.constructed || native.args === undefined) return undefined;
    args = native.args;
    const reflected = globalPathOf(unwrapped(call.expression))?.join('.') === 'Reflect.apply';
    receiver = framedArgumentPrefix(call, call.arguments).values[reflected ? 1 : 0];
  }
  if (receiver === undefined || !quietStreamInputs(args)) return undefined;
  const source = framedEncoderStreamSource(receiver, 'writer');
  const prefix = framedArgumentPrefix(call, args, Infinity);
  const chunk = prefix.values[0];
  return source !== undefined &&
    chunk !== undefined &&
    !isSpreadElement(chunk) &&
    !prefix.unknown &&
    prefix.alternatives === undefined
    ? { source, chunk }
    : undefined;
}

/** Prior native acquisition completes without converting or invoking a supplied object. */
function quietStreamAcquisition(call: CallExpression): boolean {
  return (
    framedEncoderStreamSource(call, 'writer') !== undefined ||
    framedEncoderStreamSource(call, 'reader') !== undefined
  );
}

/** Evaluating a binding is quiet even when it names the separately proved native writer. */
function quietStreamInputs(args: readonly Expression[]): boolean {
  const pending = [...args];
  const seen = new Set<Expression>();
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (isIdentifier(unwrapped(value)) || framedQuietInputs([value], NATIVES)) continue;
    const source = framedQuietSource(isSpreadElement(value) ? value.expression : value);
    if (source === undefined || seen.has(source) || !isArrayLiteralExpression(source)) return false;
    seen.add(source);
    pending.push(...source.elements);
  }
  return true;
}

/** Stored pending writes keep no arbitrary intervening statement or asynchronous application handoff. */
function nextAwaitedRead(call: CallExpression): CallExpression | undefined {
  const statement = writeStatement(call);
  if (statement === undefined || !isBlock(statement.parent)) return undefined;
  const statements = statement.parent.statements;
  const next = statements[statements.indexOf(statement) + 1];
  let value: Expression | undefined;
  if (
    next !== undefined &&
    isVariableStatement(next) &&
    next.declarationList.declarations.length === 1
  )
    value = next.declarationList.declarations[0]?.initializer;
  else if (next !== undefined && (isExpressionStatement(next) || isReturnStatement(next)))
    value = next.expression;
  if (value === undefined) return undefined;
  const awaited = unwrapped(value);
  if (!isAwaitExpression(awaited)) return undefined;
  const read = unwrapped(awaited.expression);
  return isCallExpression(read) ? read : undefined;
}

/** The selected write is an entire expression or a single initializer, without sibling evaluation. */
function writeStatement(call: CallExpression): Statement | undefined {
  const { parent } = useOf(call);
  if (isExpressionStatement(parent) && unwrapped(parent.expression) === call) return parent;
  if (
    !isVariableDeclaration(parent) ||
    parent.initializer === undefined ||
    unwrapped(parent.initializer) !== call
  )
    return undefined;
  const statement = parent.parent.parent;
  return isVariableStatement(statement) && statement.declarationList.declarations.length === 1
    ? statement
    : undefined;
}
