import {
  isExpressionWithTypeArguments,
  isHeritageClause,
  isInterfaceDeclaration,
  isTypeNode,
  type Node,
  NodeFlags,
  SyntaxKind,
} from 'typescript/ast';

/**
 * Whether `node` is a type, and no value: a type — but `f<T>`, an instantiation expression, and a
 * class's `extends`, which TypeScript counts among the type nodes (`ExpressionWithTypeArguments`)
 * but which read their expression where they stand. An `implements` clause and an interface's
 * `extends` name types alone: the parser keeps a name there as a type reference, and what is no name
 * (`make()`, `this.Base`) as an expression with type arguments, which nothing runs.
 */
export function isTypeSyntax(node: Node): boolean {
  if (!isTypeNode(node)) return false;
  if (!isExpressionWithTypeArguments(node)) return true;
  const clause = node.parent;
  return (
    isHeritageClause(clause) &&
    (clause.token === SyntaxKind.ImplementsKeyword || isInterfaceDeclaration(clause.parent))
  );
}

/**
 * Whether `node` is ambient: it says `declare`, stands within a declaration that does — `declare
 * namespace`, `declare global`, `declare module 'x'` — or is written in a declaration file.
 * TypeScript emits nothing for what is ambient, so no name it gives is a binding that runs: a read
 * of that name is the global's, or the enclosing scope's. A name is a binding where the code emits one.
 */
export function isAmbient(node: Node): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript exposes ambient declarations through this flag.
  return (node.flags & NodeFlags.Ambient) !== 0;
}
