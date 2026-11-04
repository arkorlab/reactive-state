import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedDefinitionDataWrite } from './framed-definition-data-writes.ts';
import { isTypeOnly } from './scope.ts';

/** Saved definition results retain each member projection only before its source can be exposed. */

interface Projection {
  readonly keys: readonly string[];
  readonly value: Expression;
  readonly aliases: ReadonlySet<FrameBinding>;
}

interface Definition {
  readonly call: CallExpression;
  readonly keys: readonly string[];
  readonly aliases: ReadonlySet<FrameBinding>;
  readonly projections: readonly Projection[];
}

/** Literal member paths and whole const aliases preserve each original projection's capture point. */
export function framedDefinedReceiver(
  node: Expression,
  keys: readonly string[],
): Definition | undefined {
  let value = unwrapped(node);
  let path = keys;
  let capture = node;
  let current = new Set<FrameBinding>();
  const aliases = new Set<FrameBinding>();
  const projections: Projection[] = [];
  const seen = new Set<Node>();
  while (!seen.has(value)) {
    seen.add(value);
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      const key = frameMemberName(value);
      if (key === undefined) return undefined;
      if (current.size > 0) {
        projections.push({ keys: path, value: capture, aliases: current });
        current = new Set();
        capture = value;
      }
      path = [key, ...path];
      value = unwrapped(value.expression);
      continue;
    }
    const alias = constantSource(value);
    if (alias !== undefined) {
      aliases.add(alias.binding);
      current.add(alias.binding);
      value = unwrapped(alias.value);
      continue;
    }
    projections.push({ keys: path, value: capture, aliases: current });
    return isCallExpression(value) ? { call: value, keys: path, aliases, projections } : undefined;
  }
  return undefined;
}

/** Later target replacements do not alter a value that an earlier constant projection captured. */
export function framedDefinitionUnchanged(definition: Definition): boolean {
  return definition.projections.every((each) => {
    return !argumentArrayExposed(
      each.value,
      projectionAliases(each, definition),
      (name) =>
        nativeTargetUse(name, definition) || framedDefinitionDataWrite(name, each, definition),
    );
  });
}

/** The returned native target and its original whole binding name the same object. */
function projectionAliases(
  projection: Projection,
  definition: Definition,
): ReadonlySet<FrameBinding> {
  const aliases = new Set(projection.aliases);
  if (projection.keys === definition.keys) {
    const target = definition.call.arguments[0];
    let value = target === undefined ? undefined : unwrapped(target);
    while (value !== undefined && isIdentifier(value)) {
      const selected = frameBindingOf(value);
      if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
        break;
      aliases.add(selected.binding);
      const source = constantSource(value);
      value = source === undefined ? undefined : unwrapped(source.value);
    }
  }
  return wholeAliases({ ...projection, aliases });
}

/** Passing the target to its own defining native call precedes the installed-value snapshot. */
function nativeTargetUse(name: Expression, definition: Definition): boolean {
  const { at, parent } = useOf(name);
  return isExpression(at) && parent === definition.call && definition.call.arguments[0] === at;
}

/** Only whole immutable aliases retain a native definition result's source identity. */
function constantSource(
  name: Expression,
): { readonly binding: FrameBinding; readonly value: Expression } | undefined {
  if (!isIdentifier(name)) return undefined;
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  if (
    binding === undefined ||
    selected?.keys.length !== 0 ||
    !isVariableDeclaration(binding) ||
    !isVariableDeclarationList(binding.parent) ||
    !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
    binding.initializer === undefined
  )
    return undefined;
  return { binding, value: binding.initializer };
}

/** Additional whole const aliases neither expose a projection nor hide later writes through them. */
function wholeAliases(projection: Projection): ReadonlySet<FrameBinding> {
  const aliases = new Set(projection.aliases);
  if (aliases.size === 0) return aliases;
  const names = constantNames(projection.value);
  let count = -1;
  while (count !== aliases.size) {
    count = aliases.size;
    for (const name of names) {
      const selected = constantSource(name);
      if (selected === undefined) continue;
      const value = unwrapped(selected.value);
      if (!isIdentifier(value)) continue;
      const source = frameBindingOf(value);
      if (source?.keys.length === 0 && aliases.has(source.binding)) aliases.add(selected.binding);
    }
  }
  return aliases;
}

/** Constant binding names retain lexical identity without following runtime member accesses. */
function constantNames(value: Expression): readonly Expression[] {
  const names: Expression[] = [];
  const pending: Node[] = [value.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isVariableDeclaration(node) && isIdentifier(node.name)) names.push(node.name);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return names;
}
