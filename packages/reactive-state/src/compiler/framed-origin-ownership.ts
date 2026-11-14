import {
  type Expression,
  type Identifier,
  isCatchClause,
  isIdentifier,
  isParameterDeclaration,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Added native origins do not cross captured object bindings into another execution owner. */

const PRIMITIVES = new Set(['Infinity', 'NaN', 'Symbol.iterator', 'undefined']);
const ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);

interface CoownedSource {
  readonly owned: boolean;
  readonly value?: Expression;
}

/** A selected source keeps only same-owner object bindings, following their whole immutable aliases. */
export function framedOriginCoowned(
  source: Expression,
  consumer: Expression,
  localSource?: (name: Identifier, consumer: Expression) => Expression | undefined,
): boolean {
  const pending: Node[] = [source];
  const seen = new Set<Node>();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (seen.has(node) || isTypeOnly(node)) continue;
    seen.add(node);
    if (isIdentifier(node) && readsBinding(node)) {
      const next = coownedBinding(node, consumer, localSource);
      if (!next.owned) return false;
      if (next.value !== undefined) pending.push(next.value);
      continue;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Primitive and native constructor aliases carry no mutable Error object across an owner boundary. */
function coownedBinding(
  name: Identifier,
  consumer: Expression,
  localSource?: (name: Identifier, consumer: Expression) => Expression | undefined,
): CoownedSource {
  if (
    framedMapKey(name) !== undefined ||
    framedNativeConstructor(name, PRIMITIVES) ||
    framedNativeConstructor(name, ERRORS)
  )
    return { owned: true };
  const selected = frameBindingOf(name);
  if (selected === undefined) return { owned: true };
  const { binding } = selected;
  if (!framedPrefixSameOwner(binding, consumer)) return { owned: false };
  if (isParameterDeclaration(binding) || isCatchClause(binding.parent)) return { owned: true };
  const local = selected.keys.length === 0 ? localSource?.(name, consumer) : undefined;
  if (local !== undefined) return { owned: true, value: local };
  return selected.keys.length === 0 && wholeConstant(binding)
    ? { owned: true, value: binding.initializer }
    : { owned: false };
}

/** Mutable locals and destructured aliases do not establish a new carried-object identity. */
function wholeConstant(binding: FrameBinding): binding is FrameBinding & {
  readonly initializer: Expression;
} {
  return (
    isVariableDeclaration(binding) &&
    isIdentifier(binding.name) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile())) &&
    binding.initializer !== undefined
  );
}
