import {
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/**
 * Whether a mention is iterated: spread into a list or into the arguments of a call, or taken apart
 * by an array pattern, in an assignment or in a declaration. A held object, or a literal that holds
 * one, runs the `Symbol.iterator` it has, which is application code that may write the object
 * (`*[Symbol.iterator]() { this.get = undefined; }`). An array and a list are iterated by the
 * language, and what they hold is followed, so a caller asks only for what it does not follow.
 */
export function iterates(at: Node): boolean {
  const { parent } = at;
  if (isSpreadElement(parent)) return true;
  if (isVariableDeclaration(parent)) {
    const initializer: Node | undefined = parent.initializer;
    return initializer === at && isArrayBindingPattern(parent.name);
  }
  if (!isBinaryExpression(parent) || parent.right !== at) return false;
  return (
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    isArrayLiteralExpression(unwrapped(parent.left))
  );
}
