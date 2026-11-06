import {
  isArrowFunction,
  isClassExpression,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isSetAccessorDeclaration,
  type Node,
} from 'typescript/ast';

/** Whether `node` runs where it is called, not where the code writes it: a function, a class. */
export function runsLater(node: Node): boolean {
  return (
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isClassExpression(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  );
}
