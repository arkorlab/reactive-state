import { type Identifier, type Node, isIdentifier } from 'typescript/ast';

import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** The reads of each parameter and variable of a file, found once for every question asked of it. */
const USES = new WeakMap<Node, ReadonlyMap<FrameBinding, readonly Identifier[]>>();

/**
 * The identifiers of the file `root` that read a parameter or variable, each name but the one that
 * declares it, and none in a type. A question about the uses of one binding reads those of it, not
 * the file again: a file with a binding for each of n arrays, each asked of, is read once and not n
 * times.
 */
export function bindingUses(root: Node, binding: FrameBinding): readonly Identifier[] {
  let uses = USES.get(root);
  if (uses === undefined) {
    uses = usesOfBindings(root);
    USES.set(root, uses);
  }
  return uses.get(binding) ?? [];
}

function usesOfBindings(root: Node): ReadonlyMap<FrameBinding, readonly Identifier[]> {
  const uses = new Map<FrameBinding, Identifier[]>();
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node)) noteUse(uses, node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return uses;
}

/** A name that reads a binding other than the one it declares is a use of it. */
function noteUse(uses: Map<FrameBinding, Identifier[]>, name: Identifier): void {
  const selected = readsBinding(name) ? frameBindingOf(name) : undefined;
  if (selected === undefined || name === selected.binding.name) return;
  const held = uses.get(selected.binding);
  if (held === undefined) uses.set(selected.binding, [name]);
  else held.push(name);
}
