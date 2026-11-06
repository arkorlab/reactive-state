import {
  type CallExpression,
  type Expression,
  type Identifier,
  isIdentifier,
  isParameterDeclaration,
  isTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedAssignedValues, framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { readsBinding } from './scope.ts';

/** Native iterator slots preserve carried bindings only before their fields can be exposed. */

/** Earlier uses of a carried source keep the old opaque projection rather than losing written fields. */
export function iteratorCarriedUnexposed(
  roots: readonly Expression[],
  selected: readonly { readonly value: Expression }[],
  capture: CallExpression,
): boolean {
  const bindings = carriedBindings(selected);
  if (bindings === undefined) return false;
  if (bindings.size === 0) return true;
  const modeled = [...roots, ...selected.map(({ value }) => value)];
  const pending: Node[] = [capture.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && exposedUse(node, modeled, capture, bindings)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Selected literal shapes retain lexical parameters and whole constant source aliases. */
function carriedBindings(
  selected: readonly { readonly value: Expression }[],
): ReadonlySet<FrameBinding> | undefined {
  const bindings = new Set<FrameBinding>();
  const pending: Node[] = selected.map(({ value }) => value);
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && readsBinding(node) && !addBinding(node, bindings)) return undefined;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return bindings;
}

/** Whole immutable aliases preserve their original binding without treating a call result as primitive. */
function addBinding(name: Identifier, bindings: Set<FrameBinding>): boolean {
  let value: Expression = name;
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined) return true;
    const { binding } = selected;
    if (selected.keys.length > 0 || seen.has(binding) || framedAssignedValues(value).length > 0)
      return false;
    seen.add(binding);
    bindings.add(binding);
    if (isParameterDeclaration(binding)) return true;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return false;
    value = unwrapped(binding.initializer);
  }
  return false;
}

/** Quiet source fields and their own getters are modeled reads; other earlier uses may write a field. */
function exposedUse(
  name: Identifier,
  modeled: readonly Expression[],
  capture: CallExpression,
  bindings: ReadonlySet<FrameBinding>,
): boolean {
  if (
    !readsBinding(name) ||
    modeled.some((value) => name.pos >= value.pos && name.end <= value.end)
  )
    return false;
  const selected = frameBindingOf(name);
  if (selected === undefined || name === selected.binding.name || !bindings.has(selected.binding))
    return false;
  const { parent } = useOf(name);
  if (
    isVariableDeclaration(parent) &&
    parent.initializer !== undefined &&
    unwrapped(parent.initializer) === name &&
    bindings.has(parent)
  )
    return false;
  const owner = executionOwner(capture);
  const other = executionOwner(name);
  if (other === owner) {
    if (
      (name.pos >= capture.pos || destructuredFirst(capture, name)) &&
      !repeatedFrameRead(name, capture, selected.binding, owner)
    )
      return false;
  } else if (unreferencedLocalFunction(other, owner)) return false;
  return framedPossibleBranch(name);
}
