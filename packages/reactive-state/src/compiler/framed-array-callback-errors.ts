import {
  type CallExpression,
  type Expression,
  type Identifier,
  type ParameterDeclaration,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { selectedError } from './framed-array-selections.ts';
import { arrayMethodMayBeOverridden, framedArrayWrittenWords } from './framed-arrays.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { quietNativeCallbackRest } from './framed-callback-rest-patterns.ts';
import { framedCallbackSpreadInput } from './framed-callback-spreads.ts';
import { framedCollectionCallbackError } from './framed-collection-callbacks.ts';
import { namesTypedElements } from './framed-iterated-types.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedLiteralObject } from './framed-literal-data.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedNativeErrorCreation } from './framed-receivers.ts';
import { framedAssignedValues } from './framed-writes.ts';

/** Synchronous native callbacks retain their written array and collection parameter origins. */

const METHODS = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'some',
]);

const BORROWED_METHODS = new Set([...METHODS].map((name) => `Array.prototype.${name}`));
const CALLBACK_INDEX = /^(?:0|[1-9]\d*)$/u;

type ErrorValue = (value: Expression, made: boolean, keys?: readonly string[]) => boolean;

interface CallbackSource {
  readonly receiver: Expression;
  readonly call: CallExpression;
  readonly parameter: number;
  readonly method: string;
  readonly borrowed: boolean;
  /** The file may give an array a method of this name of its own: what it passes is not read. */
  readonly overridden: boolean;
}

/** Native callback positions retain original selected paths, including known call/apply wrappers. */
export function framedArrayCallbackError(
  name: Identifier,
  made: boolean,
  names: ReadonlySet<string>,
  error: ErrorValue,
): boolean {
  return callbackInputError(name, { made, names, error, keys: [] });
}

interface CallbackRead {
  readonly made: boolean;
  readonly names: ReadonlySet<string>;
  readonly error: ErrorValue;
  readonly keys: readonly string[];
}

/** Each callback keeps its native argument number separately from its remaining member path. */
function callbackInputError(name: Identifier, read: CallbackRead): boolean {
  const { made, names, error, keys: selectedKeys } = read;
  const binding = frameBindingOf(name);
  if (binding === undefined || !isParameterDeclaration(binding.binding)) return false;
  const source = callbackSource(binding.binding, name);
  if (source === undefined) return false;
  if (source.overridden) return true;
  const input = callbackInput(source.parameter, binding.binding, [
    ...binding.keys,
    ...selectedKeys,
  ]);
  if (input === undefined || input.parameter > 1) return false;
  if (
    (selectedKeys.length > 0 || binding.binding.dotDotDotToken !== undefined) &&
    !framedCallbackSpreadInput(
      source.call,
      source.receiver,
      name,
      quietNativeCallbackRest(binding.binding, source) ? binding.binding : undefined,
    )
  )
    return false;
  if (binding.binding.dotDotDotToken !== undefined && framedAssignedValues(name).length > 0)
    return false;
  const proof = {
    error: (each: Expression, path: readonly string[] = []) =>
      error(each, made, [...path, ...input.keys]),
    typed: (each: Expression, index: number | undefined) =>
      input.keys.length === 0 && callbackArrayType(each, index, { made, names }),
  };
  if (!source.borrowed && source.method === 'forEach') {
    const collection = framedCollectionCallbackError(source.receiver, proof, {
      parameter: input.parameter,
      keys: input.keys,
      names,
      call: source.call,
    });
    if (collection !== undefined) return collection;
  }
  return input.parameter === 0 && selectedError(source.receiver, undefined, proof, name);
}

/** Literal members of a native callback rest binding retain its selected argument's source path. */
export function framedArrayCallbackMemberError(
  value: Expression,
  made: boolean,
  names: ReadonlySet<string>,
  read: Pick<CallbackRead, 'error' | 'keys'> & { readonly observer: Node },
): boolean {
  const path = [...read.keys];
  let receiver = unwrapped(value);
  while (isPropertyAccessExpression(receiver) || isElementAccessExpression(receiver)) {
    const key = frameMemberName(receiver);
    if (
      key === undefined ||
      (isElementAccessExpression(receiver) &&
        framedMapKey(receiver.argumentExpression) === undefined)
    )
      return false;
    path.unshift(key);
    receiver = unwrapped(receiver.expression);
  }
  if (path.length === 0 || !isIdentifier(receiver)) return false;
  const binding = frameBindingOf(receiver)?.binding;
  return (
    binding !== undefined &&
    isParameterDeclaration(binding) &&
    binding.dotDotDotToken !== undefined &&
    framedPrefixSameOwner(binding, read.observer) &&
    callbackInputError(receiver, { made, names, error: read.error, keys: path })
  );
}

/** A rest binding first selects a native argument, then retains that argument's member path. */
function callbackInput(
  parameter: number,
  binding: ParameterDeclaration,
  keys: readonly string[],
): { readonly parameter: number; readonly keys: readonly string[] } | undefined {
  if (binding.dotDotDotToken === undefined) return { parameter, keys };
  const [key, ...members] = keys;
  if (key === undefined || !CALLBACK_INDEX.test(key)) return undefined;
  const selected = parameter + Number(key);
  return Number.isSafeInteger(selected) ? { parameter: selected, keys: members } : undefined;
}

/** Inline synchronous callbacks preserve the native method's receiver and callback argument. */
function callbackSource(
  parameter: ParameterDeclaration,
  read: Identifier,
): CallbackSource | undefined {
  const fn = parameter.parent;
  if (!isAnswering(fn) || answersLater(fn) || !isExpression(fn)) return undefined;
  const parameters = fn.parameters.filter(
    (each) => !isIdentifier(each.name) || each.name.text !== 'this',
  );
  const index = parameters.indexOf(parameter);
  if (index === -1 || index > 1) return undefined;
  const call = callbackCall(fn);
  if (call === undefined) return undefined;
  const borrowed = borrowedCallback(call, fn);
  if (borrowed !== undefined) return { ...borrowed, parameter: index };
  return directCallback(call, fn, index, read);
}

/** A direct native callback keeps its original receiver; only added spread inputs need the new proof. */
function directCallback(
  call: CallExpression,
  fn: Expression,
  index: number,
  read: Identifier,
): CallbackSource | undefined {
  const args = framedArgumentPrefix(call, call.arguments, 1);
  const first = args.values[0];
  if (first === undefined || args.unknown || unwrapped(first) !== fn) return undefined;
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = frameMemberName(member);
  if (method === undefined || !METHODS.has(method)) return undefined;
  const receiver = member.expression;
  if (sourceArrayFunction(member)) return undefined;
  const raw = call.arguments[0];
  if (raw !== undefined && isSpreadElement(raw) && !framedCallbackSpreadInput(call, receiver, read))
    return undefined;
  const overridden = arrayMethodMayBeOverridden(call, method);
  return { receiver, method, call, parameter: index, borrowed: false, overridden };
}

/** An inline callback may stand inside the literal list supplied to a native apply wrapper. */
function callbackCall(fn: Expression): CallExpression | undefined {
  let node: Node = fn;
  for (;;) {
    const { parent } = useOf(node);
    if (isCallExpression(parent)) return parent;
    if (!isArrayLiteralExpression(parent) && !isSpreadElement(parent)) return undefined;
    node = parent;
  }
}

/** Known borrowed native targets bypass receiver own methods and keep the first runtime callback. */
function borrowedCallback(
  call: CallExpression,
  fn: Expression,
): Omit<CallbackSource, 'parameter'> | undefined {
  const native = framedNativeArguments(call, BORROWED_METHODS);
  if (native === undefined || native.constructed || native.args === undefined) return undefined;
  const callback = framedArgumentPrefix(call, native.args, 1).values[0];
  if (callback === undefined || unwrapped(callback) !== fn) return undefined;
  const reflected = globalPathOf(unwrapped(call.expression))?.join('.') === 'Reflect.apply';
  const receiver = framedArgumentPrefix(call, call.arguments).values[reflected ? 1 : 0];
  return receiver === undefined
    ? undefined
    : { receiver, call, method: '', borrowed: true, overridden: false };
}

/** A written native element type remains available unless every source is local words or literal data. */
function callbackArrayType(
  value: Expression,
  index: number | undefined,
  context: { readonly made: boolean; readonly names: ReadonlySet<string> },
): boolean {
  if (
    framedArrayWrittenWords(value, (each) => {
      return (
        framedLiteralObject(each) ||
        (!context.made && framedNativeErrorCreation(each, context.names, false))
      );
    })
  )
    return false;
  return namesTypedElements(value, index, context.names);
}
