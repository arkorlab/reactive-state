import {
  type Expression,
  type GetAccessorDeclaration,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionLikeDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/** What a getter the copy of a spread runs writes into the object it runs on. */

/** Thrown where what a source holds cannot be followed: a getter may change it in a way not written out. */
export class UnfollowableError extends Error {
  override name = 'UnfollowableError';
}

/** The assignments that may give their left the value of their right: `=` and the logical ones. */
const VALUE_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * The values a getter writes through `this`, each a value a field of the object may hold when the
 * copy reaches it: the right of an assignment to a member of `this`. A deletion writes none, and an
 * arithmetic assignment or an increment writes a number or a text, which is no object. None where
 * `this` is given to anything else: a call, a method, a pattern, a list, the result of the getter.
 */
export function getterWrites(getter: GetAccessorDeclaration): readonly Expression[] | undefined {
  const values: Expression[] = [];
  const pending: Node[] = getter.body === undefined ? [] : [getter.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.kind === SyntaxKind.ThisKeyword) {
      const used = use(node);
      if (used === undefined) return undefined;
      values.push(...used);
    }
    const rebinds =
      (isFunctionLikeDeclaration(node) && !isArrowFunction(node)) ||
      isClassDeclaration(node) ||
      isClassExpression(node);
    if (!rebinds)
      node.forEachChild((child) => {
        pending.push(child);
      });
  }
  return values;
}

/** The node that stands for the same value as `node`, through parentheses and assertions. */
function outermost(node: Node): Node {
  let at = node;
  while (isExpression(at.parent) && unwrapped(at.parent) === node) at = at.parent;
  return at;
}

/** What one mention of `this` writes; none where it is given to anything but a member. */
function use(node: Node): readonly Expression[] | undefined {
  const at = outermost(node);
  const { parent } = at;
  if (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) return undefined;
  if (parent.expression !== at) return undefined;
  const member = outermost(parent);
  const user = member.parent;
  if (isTaggedTemplateExpression(user)) return user.tag === member ? undefined : [];
  if ((isCallExpression(user) || isNewExpression(user)) && user.expression === member)
    return undefined;
  if (isDeleteExpression(user)) return [];
  if (isPrefixUnaryExpression(user) || isPostfixUnaryExpression(user)) return [];
  if (isBinaryExpression(user) && user.left === member) {
    const kind = user.operatorToken.kind;
    return VALUE_WRITES.has(kind) ? [user.right] : [];
  }
  return isTarget(member) ? undefined : [];
}

/** Whether a node is a place in a pattern that is assigned, or the head of a loop. */
function isTarget(node: Node): boolean {
  let at = node;
  for (;;) {
    const { parent } = at;
    if (isBinaryExpression(parent)) {
      return parent.left === at && parent.operatorToken.kind === SyntaxKind.EqualsToken;
    }
    if (isForOfStatement(parent) || isForInStatement(parent)) return parent.initializer === at;
    const inside =
      isObjectLiteralExpression(parent) ||
      isArrayLiteralExpression(parent) ||
      isPropertyAssignment(parent) ||
      isShorthandPropertyAssignment(parent) ||
      isSpreadElement(parent) ||
      isSpreadAssignment(parent);
    if (!inside) return false;
    at = parent;
  }
}
