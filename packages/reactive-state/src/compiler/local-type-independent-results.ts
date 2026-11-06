import {
  isIdentifier,
  isTypeQueryNode,
  isTypeReferenceNode,
  type Node,
  type SignatureDeclaration,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';

/** Source-written generic results retain only types independent of their own signature binders. */

/** A value query can hide a dependency through a signature parameter's annotation. */
export function independentSignatureResult(signature: SignatureDeclaration): boolean {
  if (signature.type === undefined) return false;
  const parameters = new Set<Node>(signature.typeParameters);
  if (parameters.size === 0) return true;
  const pending: Node[] = [signature.type];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeQueryNode(node)) return false;
    if (isTypeReferenceNode(node) && isIdentifier(node.typeName)) {
      const binding = localTypeBinding(node.typeName);
      if (binding !== undefined && binding !== null && parameters.has(binding)) return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}
