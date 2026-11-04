import {
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { framedAccessorSteps } from './framed-accessor-steps.ts';
import {
  framedAccessorSlot,
  framedAccessorTarget,
  type AccessorTarget,
} from './framed-accessor-targets.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';

/** At an original immediate read, a closed native definition preserves its actual getter or data slot. */
export function framedDefinedAccessorResult(
  node: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean | undefined {
  if (keys.length > 0 || !immediateObservation(node)) return undefined;
  const value = unwrapped(node);
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return undefined;
  const key = frameMemberName(value);
  if (
    key === undefined ||
    key === '__proto__' ||
    (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
  )
    return undefined;
  const targets = new Map<VariableDeclaration, AccessorTarget>();
  const target = framedAccessorTarget(value.expression, { key, consumer: value, targets });
  if (
    target === undefined ||
    !framedAccessorSteps(value, key, targets) ||
    !hasDefinedAccessor(targets)
  )
    return undefined;
  const slot = framedAccessorSlot(target);
  const selected = slot?.kind === 'accessor' ? slot.getter : slot?.value;
  if (selected === undefined) return false;
  return framedOriginCoowned(selected, value) ? error(selected, []) : undefined;
}

/** A data-only chain keeps the existing definition result rule. */
function hasDefinedAccessor(targets: ReadonlyMap<VariableDeclaration, AccessorTarget>): boolean {
  for (const target of targets.values()) {
    if (target.accessorDefined) return true;
  }
  return false;
}

/** A captured value or a later invocation does not acquire a proof at an earlier receiver position. */
function immediateObservation(node: Expression): boolean {
  const use = useOf(node);
  const parent = use.parent;
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === use.at
  ) {
    const name = frameMemberName(parent);
    return (
      name !== undefined &&
      ['message', 'name', 'stack'].includes(name) &&
      (!isElementAccessExpression(parent) || framedQuietPrimitive(parent.argumentExpression))
    );
  }
  return (
    isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    isExpression(use.at) &&
    parent.arguments[0] === use.at &&
    isIdentifier(unwrapped(parent.expression)) &&
    globalPathOf(unwrapped(parent.expression))?.join('.') === 'String'
  );
}
