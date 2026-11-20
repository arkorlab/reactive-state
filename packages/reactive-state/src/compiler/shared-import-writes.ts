import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, literalName, unwrapped } from './bounded.ts';
import { INCREMENTS, MUTATORS, OBJECT_MUTATORS } from './computed.ts';

/**
 * Whether `identifier`, an import of a shared module's, is written where it stands: itself or a
 * member of it assigned, incremented or deleted, a method of the language's arrays that changes what
 * it is called on called on it, or it the target of `Object.assign` and its kin. Not one it is handed
 * to a call, or copies: what a function does with an argument is that function's, and a copy is the
 * code's own.
 */
export function isWrittenAt(identifier: Identifier): boolean {
  const node = outermost(identifier);
  const { parent } = node;
  if (isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return (
      parent.left === node &&
      operator >= SyntaxKind.FirstAssignment &&
      operator <= SyntaxKind.LastAssignment
    );
  }
  if (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) {
    return INCREMENTS.has(parent.operator);
  }
  if (isDeleteExpression(parent)) {
    return true;
  }
  return isCallExpression(parent) && isChangedBy(parent, node);
}

/** The expression `identifier` is the root of, through the members and the wrappers around it. */
function outermost(identifier: Identifier): Expression {
  let node: Expression = identifier;
  for (;;) {
    const { parent } = node;
    if (
      isParenthesizedExpression(parent) ||
      isNonNullExpression(parent) ||
      ((isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
        parent.expression === node)
    ) {
      node = parent;
    } else {
      return node;
    }
  }
}

/** Whether `call` changes `node`: a method of arrays called on it, or `Object.assign` of it. */
function isChangedBy(call: CallExpression, node: Expression): boolean {
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return false;
  }
  const name = isPropertyAccessExpression(callee) ? callee.name.text : literalName(callee);
  if (name === undefined) {
    return false;
  }
  return globalOf(unwrapped(callee.expression)) === 'Object'
    ? OBJECT_MUTATORS.has(name) && call.arguments[0] === node
    : MUTATORS.has(name) && callee === unwrapped(node);
}
