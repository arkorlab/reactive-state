import {
  type CallExpression,
  type Expression,
  isAwaitExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import { framedQuietData, framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner, framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedReadableStart } from './framed-readable-start.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** An immediate native default read retains a closed start callback's first queued Error chunk. */

const NATIVE_PARSE = new Set(['JSON.parse']);
const STREAMS = new Set(['ReadableStream']);
const ERRORS = new Set([
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

/** Positive queued origins do not establish plain data or specialize arbitrary async stream flow. */
export function framedReadableStreamResult(
  node: Expression,
  selection: { readonly made: boolean; readonly keys: readonly string[] },
  error: (value: Expression, made: boolean, keys: readonly string[]) => boolean,
): true | undefined {
  const selected = selectedRead(node, selection.keys);
  if (selected === undefined) return undefined;
  const source = streamSource(selected.stream);
  if (
    source === undefined ||
    !framedPrefixSameOwner(source.created, selected.call) ||
    argumentArrayExposed(selected.call, source.bindings, undefined, false)
  )
    return undefined;
  const start = framedReadableStart(source.created);
  if (
    start === undefined ||
    !quietReadPrefix(selected.call, source.created) ||
    !framedOriginCoowned(start.owned, selected.call) ||
    !originalChunk(start.value, source.created)
  )
    return undefined;
  return error(start.value, selection.made, selected.keys) ? true : undefined;
}

/** Only the directly awaited first default read and its value slot retain a queued source. */
function selectedRead(
  node: Expression,
  keys: readonly string[],
):
  | { readonly call: CallExpression; readonly stream: Expression; readonly keys: readonly string[] }
  | undefined {
  const path = [...keys];
  let value = unwrapped(node);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    path.unshift(key);
    value = unwrapped(value.expression);
  }
  if (!isAwaitExpression(value) || path.shift() !== 'value') return undefined;
  const used = useOf(value);
  if (
    (!isPropertyAccessExpression(used.parent) && !isElementAccessExpression(used.parent)) ||
    used.parent.expression !== used.at ||
    frameMemberName(used.parent) !== 'value'
  )
    return undefined;
  const read = unwrapped(value.expression);
  if (!isCallExpression(read) || read.arguments.length > 0) return undefined;
  const reader = methodReceiver(read, 'read');
  const acquisition = reader === undefined ? undefined : unwrapped(reader);
  if (
    acquisition === undefined ||
    !isCallExpression(acquisition) ||
    acquisition.arguments.length > 0
  )
    return undefined;
  const stream = methodReceiver(acquisition, 'getReader');
  return stream === undefined ? undefined : { call: read, stream, keys: path };
}

/** Known literal member names add no supplied key conversion before acquisition or read. */
function methodReceiver(call: CallExpression, name: string): Expression | undefined {
  const member = unwrapped(call.expression);
  return (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === name &&
    (!isElementAccessExpression(member) || framedQuietPrimitive(member.argumentExpression))
    ? member.expression
    : undefined;
}

/** Whole unchanged const stream aliases retain their original native construction node. */
function streamSource(
  expression: Expression,
): { readonly created: NewExpression; readonly bindings: ReadonlySet<FrameBinding> } | undefined {
  let value = unwrapped(expression);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const source = frameBindingOf(value);
    if (source === undefined || source.keys.length > 0 || bindings.has(source.binding))
      return undefined;
    const { binding } = source;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isNewExpression(value) && framedNativeConstructor(value.expression, STREAMS)
    ? { created: value, bindings }
    : undefined;
}

/** Earlier source work stays opaque, while constructing this closed native start remains quiet. */
function quietReadPrefix(call: CallExpression, created: NewExpression): boolean {
  return framedQuietOwnerPrefix(call, {
    primitive: framedQuietPrimitive,
    value: (value) =>
      framedNativeConstructor(value, NATIVE_PARSE) || framedNativeConstructor(value, STREAMS),
    call: (node) => {
      return (
        framedNativeConstructor(node.expression, NATIVE_PARSE) &&
        node.arguments.length <= 1 &&
        node.arguments.every((argument) => framedQuietPrimitive(argument))
      );
    },
    construct: (node) => node === created && framedReadableStart(node) !== undefined,
  });
}

/** The original Error input exposure proof remains separate from the selected queued member path. */
function originalChunk(source: Expression, created: NewExpression): boolean {
  if (framedNativeErrorInput(source, created, undefined, false)) return true;
  const value = unwrapped(source);
  return (
    (isNewExpression(value) || isCallExpression(value)) &&
    framedNativeConstructor(value.expression, ERRORS) &&
    (value.arguments ?? []).every((argument) => framedQuietData(argument))
  );
}
