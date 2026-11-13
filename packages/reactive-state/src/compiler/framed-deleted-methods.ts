import {
  type Expression,
  isDeleteExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  type SourceFile,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { arrayIdentity } from './framed-array-identity.ts';
import {
  type ArrayMethodOverride,
  afterPossibleWrite,
  afterSureWrite,
} from './framed-array-own-methods.ts';
import { frameMemberName, type FrameBinding } from './framed-bindings.ts';

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
