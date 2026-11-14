import {
  isExpressionWithTypeArguments,
  isHeritageClause,
  isInterfaceDeclaration,
  isTypeNode,
  type Node,
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
