import {
  type CallExpression,
  type Expression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { iteratorPrefixQuiet, iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Fixed native Map groups retain finite source elements without simulating arbitrary callbacks. */

const GROUPS = new Set(['Map.groupBy']);
const MAPS = new Set(['Map']);
const GETTERS = new Set(['Map.prototype.get']);
const TAIL = { reflect: 3 } as const;

interface GetSource {
  readonly receiver: Expression;
  readonly args: readonly Expression[];
}

interface GroupRead {
  readonly made: boolean;
  readonly keys: readonly string[];
}

type ErrorValue = (value: Expression, made: boolean, keys?: readonly string[]) => boolean;

/** A quiet constant callback key selects an unchanged finite native group's original element. */
export function framedMapGroupedResult(
  call: CallExpression,
  read: GroupRead,
  error: ErrorValue,
): true | undefined {
  const get = selectedGet(call);
  if (get === undefined || !iteratorQuietValues(get.args)) return undefined;
  const source = nativeGroup(get.receiver, call);
  if (source === undefined) return undefined;
  const given = argumentsOf(source, source.arguments);
  const input = given?.[0];
  const callback = given?.[1];
  if (
    input === undefined ||
    callback === undefined ||
    given === undefined ||
    !iteratorQuietValues(given.slice(2))
  )
    return undefined;
  const key = callbackKey(callback);
  if (key === undefined || key !== framedMapKey(get.args[0])) return undefined;
  const index = read.keys[0];
  if (index === undefined || !/^(?:0|[1-9]\d*)$/u.test(index)) return undefined;
  const selected = framedAppliedArguments(source, input);
  if (selected === undefined) return undefined;
  const elements = argumentsOf(source, selected);
  if (elements === undefined || !iteratorQuietValues(elements)) return undefined;
  const value = elements[Number(index)];
  if (value === undefined || !carriedGroup(value, [...given, ...elements, ...get.args], call))
    return undefined;
  return error(value, read.made, read.keys.slice(1)) ? true : undefined;
}

/** A source-known fresh group is consumed before any other runtime work or execution owner. */
function nativeGroup(receiver: Expression, read: CallExpression): CallExpression | undefined {
  const source = wholeConstant(receiver);
  if (source === undefined || !isCallExpression(source) || !nativeGrouping(source.expression))
    return undefined;
  return executionOwner(source) === executionOwner(read) &&
    iteratorPrefixQuiet(source, read) &&
    framedOriginPrefix(source)
    ? source
    : undefined;
}

/** A group retains only same-owner carried objects whose fields have not been exposed. */
function carriedGroup(
  value: Expression,
  roots: readonly Expression[],
  read: CallExpression,
): boolean {
  return framedOriginCoowned(value, read) && iteratorCarriedUnexposed(roots, [{ value }], read);
}

/** A native constructor alias retains its groupBy member without reading a local method of that name. */
function nativeGrouping(expression: Expression): boolean {
  if (framedNativeConstructor(expression, GROUPS)) return true;
  const value = unwrapped(expression);
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
  if (frameMemberName(value) !== 'groupBy') return false;
  if (isElementAccessExpression(value) && framedMapKey(value.argumentExpression) !== 'text:groupBy')
    return false;
  return framedNativeConstructor(value.expression, MAPS);
}

/** Whole immutable aliases retain the original grouping call or written callback body. */
function wholeConstant(expression: Expression): Expression | undefined {
  let value = unwrapped(expression);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected?.keys.length !== 0 ||
      seen.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isIdentifier(binding.name) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return value;
}

/** The callback performs only one literal primitive-key return, with no defaults or destructuring. */
function callbackKey(expression: Expression): string | undefined {
  const value = wholeConstant(expression);
  if (
    value === undefined ||
    (!isArrowFunction(value) && !isFunctionExpression(value)) ||
    value.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true ||
    (isFunctionExpression(value) && value.asteriskToken !== undefined) ||
    value.parameters.some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  )
    return undefined;
  let result: Expression | undefined;
  if (isBlock(value.body)) {
    const first = value.body.statements[0];
    if (first === undefined || value.body.statements.length !== 1 || !isReturnStatement(first))
      return undefined;
    result = first.expression;
  } else result = value.body;
  return framedMapKey(result);
}

/** Borrowed get keeps its explicit receiver and all evaluated ignored wrapper arguments. */
function selectedGet(call: CallExpression): GetSource | undefined {
  const callee = unwrapped(call.expression);
  const native = framedNativeArguments(call, GETTERS);
  if (native === undefined) {
    return (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
      frameMemberName(callee) === 'get'
      ? directGet(call, callee.expression)
      : undefined;
  }
  if (native.constructed || native.args === undefined) return undefined;
  const consumed = argumentsOf(call, native.args);
  const original = argumentsOf(call, call.arguments);
  if (consumed === undefined || original === undefined) return undefined;
  const reflect = globalPathOf(callee)?.join('.') === 'Reflect.apply';
  const receiver = original[reflect ? 1 : 0];
  if (receiver === undefined) return undefined;
  const apply = !reflect && frameMemberName(callee) === 'apply';
  const offset = apply ? 2 : 1;
  return { receiver, args: [...consumed, ...original.slice(reflect ? TAIL.reflect : offset)] };
}

/** A directly selected get retains its source receiver rather than evaluating an unrelated callable. */
function directGet(call: CallExpression, receiver: Expression): GetSource | undefined {
  const args = argumentsOf(call, call.arguments);
  return args === undefined ? undefined : { receiver, args };
}

/** A finite unexposed argument tuple expands only where every consumed slot stays source-known. */
function argumentsOf(
  call: CallExpression,
  args: readonly Expression[],
): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, args, Infinity);
  return prefix.unknown || prefix.alternatives !== undefined ? undefined : prefix.values;
}
