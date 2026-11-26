import {
  type CallExpression,
  type Expression,
  type Identifier,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { quietListenerCallback, quietListenerInputs } from './framed-listener-inputs.ts';
import { framedQuietData, framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedPossibleBranch, repeatedBodyRead } from './framed-writes.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Fresh EventTarget identity survives only aliases and quiet native listener-registration prefixes. */

const TARGETS = new Set(['EventTarget']);
const METHODS = new Set(['addEventListener', 'removeEventListener']);

interface TargetSource {
  readonly bindings: ReadonlySet<FrameBinding>;
}

/** Prior own member writes, other calls and captured receiver uses preserve the old opaque boundary. */
export function framedListenerReceiver(expression: Expression, call: CallExpression): boolean {
  const source = targetSource(expression);
  if (source === undefined) return false;
  const pending: Node[] = [expression.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && exposedTarget(node, expression, call, source.bindings)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Whole immutable aliases retain the actual unshadowed native construction. */
function targetSource(expression: Expression): TargetSource | undefined {
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
  return isNewExpression(value) &&
    framedNativeConstructor(value.expression, TARGETS) &&
    (value.arguments ?? []).every((argument) => framedQuietData(argument))
    ? { bindings }
    : undefined;
}

/** A receiver's earlier native listener calls add no own property or callback execution. */
function exposedTarget(
  name: Identifier,
  selected: Expression,
  call: CallExpression,
  bindings: ReadonlySet<FrameBinding>,
): boolean {
  if (!readsBinding(name)) return false;
  const reading = frameBindingOf(name);
  if (
    reading === undefined ||
    !bindings.has(reading.binding) ||
    name === reading.binding.name ||
    name === unwrapped(selected)
  )
    return false;
  const owner = executionOwner(call);
  if (executionOwner(name) !== owner) return true;
  if (
    (name.pos >= call.pos || destructuredFirst(call, name)) &&
    !repeatedBodyRead(name, call, reading.binding, owner)
  )
    return false;
  if (!framedPossibleBranch(name)) return false;
  const { parent } = useOf(name);
  if (
    isVariableDeclaration(parent) &&
    parent.initializer !== undefined &&
    unwrapped(parent.initializer) === name &&
    bindings.has(parent)
  )
    return false;
  return !quietListenerPrefix(name);
}

/** Earlier types and options have quiet primitive/data conversion, and listener bodies remain deferred. */
function quietListenerPrefix(name: Identifier): boolean {
  const { at, parent } = useOf(name);
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    parent.expression !== at ||
    !METHODS.has(frameMemberName(parent) ?? '')
  )
    return false;
  if (isElementAccessExpression(parent) && !framedQuietPrimitive(parent.argumentExpression))
    return false;
  const used = useOf(parent);
  const call = used.parent;
  if (
    !isCallExpression(call) ||
    call.expression !== used.at ||
    !quietListenerInputs(call.arguments)
  )
    return false;
  const type = call.arguments[0];
  const options = call.arguments[2];
  return (
    type !== undefined &&
    framedQuietPrimitive(type) &&
    quietListenerCallback(call.arguments[1]) &&
    (options === undefined || framedQuietData(options))
  );
}
