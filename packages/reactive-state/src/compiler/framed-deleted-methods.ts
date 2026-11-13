import type { Expression } from 'typescript/ast';

import { arrayIdentity } from './framed-array-identity.ts';
import type { ArrayMethodOverride } from './framed-array-own-methods.ts';
import type { FrameBinding } from './framed-bindings.ts';
import { prototypeMayChange } from './framed-prototype-changes.ts';

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
