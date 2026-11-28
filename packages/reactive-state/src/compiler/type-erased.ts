import {
  isExpressionWithTypeArguments,
  isHeritageClause,
  isInterfaceDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { isTypeOnly } from './scope.ts';

/**
 * Whether a scan of what runs skips `node`: what `isTypeOnly` holds erased, and a base an interface
 * names or an entry of a class's `implements`, which run nothing. The TypeScript 7.1 AST writes
 * either as a type reference, which `isTypeOnly` holds already; this holds them where an AST writes
 * them as it writes a class's `extends`. That, and an instantiation expression, `f<T>`, run their
 * expression, and a scan reads them.
 */
export function isTypeErased(node: Node): boolean {
  if (isTypeOnly(node)) return true;
  if (!isExpressionWithTypeArguments(node) || !isHeritageClause(node.parent)) return false;
  return (
    node.parent.token === SyntaxKind.ImplementsKeyword || isInterfaceDeclaration(node.parent.parent)
  );
}
