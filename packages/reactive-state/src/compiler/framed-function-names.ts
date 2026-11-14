import {
  isArrowFunction,
  isAsExpression,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isTypeAssertion,
  type Node,
} from 'typescript/ast';

/** The node that holds a function, and which nodes are functions. */

/** Whether a node only gives its operand a type: a parenthesis, `as`, `satisfies`, `!`, `<T>`. */
function isWrapper(node: Node): node is Node & { readonly expression: Node } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node) ||
    isTypeAssertion(node)
  );
}

/** The node that holds a function expression or an arrow, past parentheses and type wrappers. */
export function holderOf(fn: Node): Node {
  let at = fn;
  while (isWrapper(at.parent) && at.parent.expression === at) at = at.parent;
  return at;
}

/** Whether a node is a function, a method, an accessor or a constructor: code that runs when called. */
export function isFunctionCode(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node)
  );
}
