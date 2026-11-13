import {
  isArrowFunction,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isTypeNode,
  type Node,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

/**
 * A function that names `this`, anywhere in its body. Stored on an array as a method, a getter or a
 * setter, it runs with the array as `this` where a native reads, converts or iterates the array, and
 * may write the array through it: no name of the array is mentioned that a reader could follow.
 */
export function namesThis(fn: Node): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (node.kind === SyntaxKind.ThisKeyword) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether a field of a literal is a function that names `this`: a method, an accessor, or a function expression. */
export function fieldNamesThis(field: ObjectLiteralElementLike): boolean {
  if (
    isMethodDeclaration(field) ||
    isGetAccessorDeclaration(field) ||
    isSetAccessorDeclaration(field)
  )
    return namesThis(field);
  if (!isPropertyAssignment(field)) return false;
  const value = field.initializer;
  return isFunctionExpression(value) && !isArrowFunction(value) && namesThis(value);
}
