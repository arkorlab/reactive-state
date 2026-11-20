import {
  type Expression,
  type Identifier,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { memberPath } from './exported-values.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedDescriptorValue } from './framed-descriptors.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietInputs, framedQuietSource } from './framed-native-evaluation.ts';
import { framedReflectRead } from './framed-reflect-reads.ts';
import { targetsOf } from './kept.ts';
import { writtenBy } from './written.ts';

/** A native reflective read retains only the explicitly selected own data path of its target. */
export function middlewareReflection(
  expression: Expression,
):
  | { readonly of: Expression; readonly keys: readonly string[]; readonly quiet: boolean }
  | undefined {
  const keys: string[] = [];
  let value = unwrapped(expression);
  for (;;) {
    const descriptor = framedDescriptorValue(value);
    if (descriptor !== undefined) {
      const container = descriptorContainer(value);
      if (container === undefined || !unchangedDescriptor(container)) return undefined;
      return singleSelection(descriptor, keys, quietReflection(container));
    }
    const reflected = framedReflectRead(value);
    if (reflected !== undefined) return singleSelection(reflected, keys, quietReflection(value));
    if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return undefined;
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    keys.unshift(key);
    value = unwrapped(value.expression);
  }
}

/** Unknown keys, argument alternatives and trap results do not establish one literal data identity. */
function singleSelection(
  selected: {
    readonly of: Expression;
    readonly names: readonly string[] | undefined;
    readonly alternatives?: readonly Expression[] | undefined;
  },
  keys: readonly string[],
  quiet: boolean,
): ReturnType<typeof middlewareReflection> {
  const name = selected.names?.[0];
  return name === undefined ||
    name === '__proto__' ||
    selected.names?.length !== 1 ||
    (selected.alternatives?.length ?? 0) > 0
    ? undefined
    : { of: selected.of, keys: [name, ...keys], quiet };
}

/** Only the descriptor data value exposes its target; the descriptor and metadata are fresh copies. */
function descriptorContainer(expression: Expression): Expression | undefined {
  if (isPropertyAccessExpression(expression) || isElementAccessExpression(expression))
    return frameMemberName(expression) === 'value' ? expression.expression : undefined;
  if (!isCallExpression(expression)) return undefined;
  return framedArgumentPrefix(expression).values[0];
}

/** Whole constant aliases retain a fresh descriptor until its value or selected map entry may change. */
function unchangedDescriptor(expression: Expression): boolean {
  const seen = new Set<Node>();
  let current = expression;
  let keys = ['value'];
  for (;;) {
    const path = memberPath(current);
    keys = [...path.keys, ...keys];
    if (!isIdentifier(path.root)) return true;
    const source = descriptorAliasSource(path.root, seen);
    if (source === undefined) return false;
    const capturedKeys = keys;
    if (
      argumentArrayExposed(path.root, source.aliases, (reference) =>
        descriptorRead(reference, capturedKeys),
      )
    )
      return false;
    current = source.value;
  }
}

/** Each member alias captures its source before later writes to the original descriptor map. */
function descriptorAliasSource(
  reference: Identifier,
  seen: Set<Node>,
): { readonly aliases: ReadonlySet<FrameBinding>; readonly value: Expression } | undefined {
  const aliases = new Set<FrameBinding>();
  let value: Expression = reference;
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
    aliases.add(binding);
    value = unwrapped(binding.initializer);
  }
  return { aliases, value };
}

/** Payload reads and harmless descriptor metadata reads do not replace the retained data value. */
function descriptorRead(reference: Identifier, keys: readonly string[]): boolean {
  let current: Expression = reference;
  for (const expected of keys) {
    const used = useOf(current);
    const parent = used.parent;
    if (
      (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
      unwrapped(parent.expression) !== unwrapped(current)
    )
      return false;
    const key = frameMemberName(parent);
    if (key === undefined) return false;
    if (key !== expected) return !isCallExpression(useOf(parent).parent);
    current = parent;
  }
  const write = writtenBy(useOf(current).parent);
  return (
    write === undefined ||
    targetsOf(write).every((target) => unwrapped(target as Expression) !== current)
  );
}

/** A copied primitive is proven only when the full original reflective call evaluates quietly. */
function quietReflection(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  if (value === undefined || !isCallExpression(value)) return false;
  const prefix = framedArgumentPrefix(value, value.arguments, Infinity);
  return (
    !prefix.unknown &&
    (prefix.alternatives?.length ?? 0) === 0 &&
    framedQuietInputs(prefix.values, new Set())
  );
}
