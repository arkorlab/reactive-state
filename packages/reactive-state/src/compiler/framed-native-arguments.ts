import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Source-known native invocations retain their consumed arguments across ordinary wrappers. */

/** `slots` holds the fixed positions of the wrappers that hand a list; a `call` hands every argument. */
const WRAPPER = { calls: Infinity, slots: 4 } as const;

interface NativeFrameArguments {
  readonly target: Expression;
  readonly args: readonly Expression[] | undefined;
  readonly applied: Expression | undefined;
  readonly constructed: boolean;
}

/** Direct calls and known call/apply/Reflect wrappers preserve the native target's lexical identity. */
export function framedNativeArguments(
  node: Node,
  names: ReadonlySet<string>,
): NativeFrameArguments | undefined {
  if (!isCallExpression(node) && !isNewExpression(node)) return undefined;
  if (framedNativeConstructor(node.expression, names))
    return {
      target: node.expression,
      args: node.arguments ?? [],
      applied: undefined,
      constructed: isNewExpression(node),
    };
  return isCallExpression(node) ? indirectArguments(node, names) : undefined;
}

/** A resolved wrapper prefix fixes the target, ignored receiver and native argument list positions. */
function indirectArguments(
  call: CallExpression,
  names: ReadonlySet<string>,
): NativeFrameArguments | undefined {
  const callee = unwrapped(call.expression);
  const path = globalPathOf(callee)?.join('.');
  if (path === 'Reflect.apply' || path === 'Reflect.construct')
    return reflectedArguments(call, names, path === 'Reflect.construct');
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const method = frameMemberName(callee);
  if (
    (method !== 'call' && method !== 'apply') ||
    !framedNativeConstructor(callee.expression, names)
  )
    return undefined;
  const values = knownArguments(call, method === 'call' ? WRAPPER.calls : WRAPPER.slots);
  if (values?.[0] === undefined) return undefined;
  const applied = method === 'apply' ? values[1] : undefined;
  return {
    target: callee.expression,
    args: method === 'call' ? values.slice(1) : appliedArguments(call, applied),
    applied,
    constructed: false,
  };
}

/** Native Reflect wrappers consume their target and list in distinct fixed slots. */
function reflectedArguments(
  call: CallExpression,
  names: ReadonlySet<string>,
  constructed: boolean,
): NativeFrameArguments | undefined {
  const values = knownArguments(call, WRAPPER.slots);
  const target = values?.[0];
  const applied = values?.[constructed ? 1 : 2];
  if (target === undefined || applied === undefined || !framedNativeConstructor(target, names))
    return undefined;
  return { target, applied, args: framedAppliedArguments(call, applied), constructed };
}

/**
 * Only a known prefix establishes where a wrapper's receiver and argument list occur. A prefix of a
 * `call` is every argument it passes on: one that stopped before the last, or before a spread it
 * cannot read, would give the native fewer arguments than it is called with.
 */
function knownArguments(call: CallExpression, limit: number): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, call.arguments, limit);
  return prefix.unknown || (prefix.alternatives?.length ?? 0) > 0 ? undefined : prefix.values;
}

/** An omitted apply list supplies no arguments; opaque lists retain their separate identity. */
function appliedArguments(
  call: CallExpression,
  value: Expression | undefined,
): readonly Expression[] | undefined {
  return value === undefined ? [] : framedAppliedArguments(call, value);
}
