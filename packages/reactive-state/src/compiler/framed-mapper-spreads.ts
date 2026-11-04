import {
  type ArrowFunction,
  type FunctionExpression,
  type CallExpression,
  type Expression,
  isArrowFunction,
  isFunctionExpression,
  isIdentifier,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedGroupByOwnedInput } from './framed-groupby-inputs.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { quietMapperFunction } from './framed-mapper-quiet.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';

/** Added mapper argument-spread origins keep all original operand and callback evaluation quiet. */

/** Original selected inputs stay unexposed through a quiet callback and complete argument list. */
export function mapperSpreadViews(
  views: readonly ArrayElementView[] | undefined,
  mapping: { readonly receiver: Expression; readonly callback: Expression | undefined },
  call: CallExpression,
): readonly ArrayElementView[] | undefined {
  if (views === undefined) return undefined;
  const fn = sourceCallback(mapping.callback);
  if (fn === undefined) return undefined;
  const given = framedArgumentPrefix(call, call.arguments, Infinity);
  if (
    given.unknown ||
    (given.alternatives?.length ?? 0) > 0 ||
    !framedOriginCoowned(mapping.receiver, call) ||
    !quietMapperFunction(fn, call, mapping.receiver, {
      evaluated: given.values,
      writable: (name) => frameBindingOf(name)?.binding.parent === fn,
    })
  )
    return undefined;
  return views.filter((view) => {
    const source = framedGroupByOwnedInput(view.value, view.value);
    return framedOriginCoowned(source, call);
  });
}

/** Whole unchanged const aliases select a written expression callback without guessing a function. */
function sourceCallback(
  expression: Expression | undefined,
): ArrowFunction | FunctionExpression | undefined {
  if (expression === undefined) return undefined;
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected?.keys.length !== 0 ||
      seen.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isArrowFunction(value) || isFunctionExpression(value) ? value : undefined;
}
