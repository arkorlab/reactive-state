import {
  type Expression,
  isIdentifier,
  isStringLiteral,
  type Node,
  type SourceFile,
} from 'typescript/ast';

import { arrayIdentity } from './framed-array-identity.ts';
import type { ArrayMethodOverride } from './framed-array-own-methods.ts';
import type { FrameBinding } from './framed-bindings.ts';

/**
 * What a deletion leaves: the inherited method, where it deletes from the array itself a property it can
 * (one nothing wrote, one assigned or defined configurable, or one an earlier deletion left inherited)
 * and nothing in the file may give the array another prototype, whose method is not the native one.
 */
export function deletedFrom(
  receiver: Expression,
  root: FrameBinding,
  before: ArrayMethodOverride | undefined,
): ArrayMethodOverride {
  const deletable =
    before === undefined || before.configurable === true || before.inherited === true;
  const gone =
    arrayIdentity(receiver) === root && deletable && !prototypeMayChange(root.getSourceFile());
  return gone ? { own: false, inherited: true } : { own: false };
}

const PROTOTYPE_CHANGES = new WeakMap<SourceFile, boolean>();

/** Whether a file may give an array another prototype: it names `__proto__` or `setPrototypeOf`. */
function prototypeMayChange(file: SourceFile): boolean {
  const known = PROTOTYPE_CHANGES.get(file);
  if (known !== undefined) return known;
  let found = false;
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined && !found; node = pending.pop()) {
    const name = isIdentifier(node) || isStringLiteral(node) ? node.text : undefined;
    found = name === '__proto__' || name === 'setPrototypeOf';
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  PROTOTYPE_CHANGES.set(file, found);
  return found;
}
