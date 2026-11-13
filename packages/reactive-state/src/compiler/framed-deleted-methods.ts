import {
  type Expression,
  isDeleteExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { arrayIdentity, mayBeArray } from './framed-array-identity.ts';
import {
  type ArrayMethodOverride,
  afterPossibleWrite,
  afterSureWrite,
  forgetMethods,
  OWN_METHODS,
  type OwnMethods,
} from './framed-array-own-methods.ts';
import { frameMemberName, type FrameBinding } from './framed-bindings.ts';
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

/** The array a deletion that names its method deletes from, none where the key is not written out. */
export function deletedReceiver(node: Node): Expression | undefined {
  if (!isDeleteExpression(node)) return undefined;
  const member = unwrapped(node.expression);
  const named = isPropertyAccessExpression(member) || isElementAccessExpression(member);
  return named && frameMemberName(member) !== undefined ? member.expression : undefined;
}

/**
 * What a deletion that is part of another expression leaves of a method. One that runs gives the
 * inherited method back where it deletes a property it can, as a statement of its own does; one that
 * may not run leaves it as it was where nothing wrote it or it already was inherited, and unproven
 * where a custom one may stay.
 */
export function afterDeletion(
  how: { readonly sure: boolean; readonly deleted: Expression | undefined },
  previous: ArrayMethodOverride | undefined,
  root: FrameBinding,
): ArrayMethodOverride {
  const gone = how.deleted === undefined ? undefined : deletedFrom(how.deleted, root, previous);
  const known = how.sure || previous === undefined || previous.inherited === true;
  if (known && gone?.inherited === true) return gone;
  return how.sure ? afterSureWrite(undefined) : afterPossibleWrite(previous, undefined);
}

/**
 * A completed deletion reveals an inherited method; an opaque key may remove either proof. It
 * deletes from what may be the array unless `exact` asks for the array itself.
 */
export function deletedMethod(
  node: Expression,
  root: FrameBinding,
  own: OwnMethods,
  { exact = false, prior = own }: { readonly exact?: boolean; readonly prior?: OwnMethods } = {},
): void {
  if (!isDeleteExpression(node)) return;
  const member = unwrapped(node.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return;
  if (!(exact ? arrayIdentity(member.expression) === root : mayBeArray(member.expression, root)))
    return;
  const key = frameMemberName(member);
  if (key === undefined) forgetMethods(own);
  else if (OWN_METHODS.has(key)) own.set(key, deletedFrom(member.expression, root, prior.get(key)));
}
