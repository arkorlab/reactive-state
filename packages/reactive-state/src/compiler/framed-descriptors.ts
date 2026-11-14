import {
  type CallExpression,
  type Expression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingContainer, frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedDescriptorEntries } from './framed-descriptor-entries.ts';
import { framedDescriptorWrites } from './framed-descriptor-writes.ts';
import { framedArgumentPrefix, framedKeyNames, framedMemberNames } from './framed-keys.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedProxyDescriptorBinding } from './framed-proxy-descriptor-bindings.ts';
import {
  framedProxyDescriptorResult,
  framedProxyDescriptorValues,
} from './framed-proxy-descriptors.ts';

/** A native own-property descriptor's value retains the member it describes. */
export function framedDescriptorValue(node: Node):
  | {
      readonly names: readonly string[] | undefined;
      readonly of: Expression;
      readonly alternatives?: readonly Expression[] | undefined;
    }
  | undefined {
  if (isBindingElement(node)) return boundDescriptorValue(node);
  const selected = descriptorReceiver(node);
  if (selected === undefined) return undefined;
  return descriptorSelection(selected);
}

/** A value binding selects its descriptor before any later use of the extracted value. */
function boundDescriptorValue(node: Node): ReturnType<typeof framedDescriptorValue> {
  if (!isBindingElement(node) || frameMemberName(node) !== 'value') return undefined;
  const selected = frameBindingContainer(node);
  if (selected === undefined) return undefined;
  const initializer = selected.binding.initializer;
  if (initializer === undefined) return undefined;
  const { keys } = selected;
  if (keys.length === 0) return descriptorSelection(initializer);
  if (keys.length !== 1) return undefined;
  const call = descriptorSource(initializer);
  return call === undefined ? undefined : pluralDescriptor(call, keys);
}

/** A descriptor data value can itself be the error selected by a later member read. */
export function framedDescriptorSources(node: Expression): readonly Expression[] | undefined {
  const binding = framedProxyDescriptorBinding(node);
  if (binding !== undefined) return binding;
  const reading = descriptorReading(node);
  if (reading === undefined) return undefined;
  const { selected, descriptor, keys } = reading;
  const proxy = framedProxyDescriptorValues(descriptor.of, descriptor.names, {
    consumer: node,
    observation: selected,
    keys,
  });
  if (keys.length > 0) return proxy;
  const initial = proxy ?? framedDescriptorEntries(descriptor.of, descriptor.names);
  const written = framedDescriptorWrites(selected);
  return written.length === 0 ? initial : [...(initial ?? []), ...written];
}

/** A finite member suffix retains its original native value observation and lexical member keys. */
function descriptorReading(node: Expression):
  | {
      readonly selected: Expression;
      readonly descriptor: NonNullable<ReturnType<typeof framedDescriptorValue>>;
      readonly keys: readonly string[];
    }
  | undefined {
  let value = unwrapped(node);
  const keys: string[] = [];
  for (;;) {
    const selected = descriptorReceiver(value);
    const descriptor = selected === undefined ? undefined : rawDescriptorSelection(selected);
    if (selected !== undefined && descriptor !== undefined) return { selected, descriptor, keys };
    if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return undefined;
    const key = frameMemberName(value);
    if (
      key === undefined ||
      (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
    )
      return undefined;
    keys.unshift(key);
    value = unwrapped(value.expression);
  }
}

/** A selected descriptor from either a singular native call or a native descriptor map. */
function descriptorSelection(node: Expression): ReturnType<typeof framedDescriptorValue> {
  return proxyDescriptorSelection(rawDescriptorSelection(node));
}

/** A value-origin read retains the original Proxy and native descriptor call for conversion checks. */
function rawDescriptorSelection(node: Expression): ReturnType<typeof framedDescriptorValue> {
  const selected = descriptorSource(node);
  if (selected === undefined) return undefined;
  const direct = descriptorCall(selected);
  if (direct !== undefined) return singularDescriptor(direct);
  if (!isPropertyAccessExpression(selected) && !isElementAccessExpression(selected))
    return undefined;
  const call = descriptorSource(selected.expression);
  return call === undefined ? undefined : pluralDescriptor(call, framedMemberNames(selected));
}

/** A known trap's descriptor replaces the target's own descriptor, without changing ordinary get. */
function proxyDescriptorSelection(
  selected: ReturnType<typeof framedDescriptorValue>,
): ReturnType<typeof framedDescriptorValue> {
  if (selected === undefined || (selected.alternatives?.length ?? 0) > 0) return selected;
  const returned = framedProxyDescriptorResult(selected.of);
  return returned === undefined ? selected : { names: ['value'], of: returned };
}

/** A descriptor-map member keeps the target and the selected property names. */
function pluralDescriptor(
  call: Expression,
  names: readonly string[] | undefined,
): ReturnType<typeof framedDescriptorValue> {
  if (
    !isCallExpression(call) ||
    globalPathOf(unwrapped(call.expression))?.join('.') !== 'Object.getOwnPropertyDescriptors'
  )
    return undefined;
  const prefix = framedArgumentPrefix(call);
  const [target] = prefix.values;
  return target === undefined
    ? undefined
    : {
        names,
        of: target,
        alternatives: prefix.alternatives,
      };
}

/** The target and key consumed by the two singular descriptor APIs. */
function singularDescriptor(call: CallExpression): ReturnType<typeof framedDescriptorValue> {
  const prefix = framedArgumentPrefix(call);
  const [target, key] = prefix.values;
  if (target === undefined || (key === undefined && !prefix.unknown)) return undefined;
  return {
    names: key === undefined ? undefined : framedKeyNames(key),
    of: target,
    alternatives: prefix.alternatives,
  };
}

/** A value selection may expose the described property; other descriptor fields do not. */
function descriptorReceiver(node: Node): Expression | undefined {
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    const names = framedMemberNames(node);
    return names === undefined || names.includes('value') ? node.expression : undefined;
  }
  if (
    !isCallExpression(node) ||
    globalPathOf(unwrapped(node.expression))?.join('.') !== 'Reflect.get'
  )
    return undefined;
  const prefix = framedArgumentPrefix(node);
  const [target, key] = prefix.values;
  if ((prefix.alternatives?.length ?? 0) > 0) return undefined;
  if (target === undefined || (key === undefined && !prefix.unknown)) return undefined;
  const names = key === undefined ? undefined : framedKeyNames(key);
  return names === undefined || names.includes('value') ? target : undefined;
}

/** Whole constant descriptor aliases retain their native call in the declaring lexical scope. */
function descriptorCall(node: Expression): CallExpression | undefined {
  const value = descriptorSource(node);
  if (value === undefined || !isCallExpression(value)) return undefined;
  const path = globalPathOf(unwrapped(value.expression))?.join('.');
  return path === 'Object.getOwnPropertyDescriptor' || path === 'Reflect.getOwnPropertyDescriptor'
    ? value
    : undefined;
}

/** Whole constants retain a descriptor call or map selection without following mutable aliases. */
function descriptorSource(node: Expression): Expression | undefined {
  const seen = new Set<Node>();
  let value = unwrapped(node);
  while (!seen.has(value)) {
    seen.add(value);
    if (!isIdentifier(value)) return value;
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) return undefined;
    const declared = selected.binding;
    if (
      !isVariableDeclaration(declared) ||
      !isVariableDeclarationList(declared.parent) ||
      !/^const\s/u.test(declared.parent.getText(declared.getSourceFile())) ||
      declared.initializer === undefined
    )
      return undefined;
    value = unwrapped(declared.initializer);
  }
  return undefined;
}
