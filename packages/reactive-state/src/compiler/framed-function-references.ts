import {
  type FunctionDeclaration,
  isClassStaticBlockDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isSourceFile,
  type Node,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { frameDeclarationOf } from './framed-bindings.ts';

/** Whether a named nested function has no lexical references in its owning body. */

const REFERENCES = new WeakMap<FunctionDeclaration, boolean>();

/** Only an unreferenced declaration directly owned by this body proves its writes cannot run. */
export function unreferencedLocalFunction(owner: Node, scope: Node): boolean {
  if (!isFunctionDeclaration(owner) || owner.name === undefined || isSourceFile(scope))
    return false;
  if (frameDeclarationOf(owner.name) !== owner) return false;
  for (let at = owner.parent; at !== scope; at = at.parent) {
    if (isAnswering(at) || isClassStaticBlockDeclaration(at) || isSourceFile(at)) return false;
  }
  const cached = REFERENCES.get(owner);
  if (cached !== undefined) return !cached;
  const pending: Node[] = [scope];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isIdentifier(node) &&
      node !== owner.name &&
      node.text === owner.name.text &&
      frameDeclarationOf(node) === owner
    ) {
      REFERENCES.set(owner, true);
      return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  REFERENCES.set(owner, false);
  return true;
}
