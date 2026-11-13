import {
  type BinaryExpression,
  type ElementAccessExpression,
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
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';

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

/** A value a getter writes to a member of `this`, and the name of the member, none where it is computed. */
export interface GetterWrite {
  readonly name: string | undefined;
  readonly value: Expression;
}

/**
 * The values a getter writes through `this`, each a value a field of the object may hold when the
 * copy reaches it: the right of an assignment to a member of `this`, under the name of the member.
 * A deletion writes none, and an arithmetic assignment or an increment writes a number or a text,
 * which is no object. None where `this` is given to anything else: a call, a method, a pattern, a
 * loop head, a list, the result of the getter.
 */
export function getterWrites(getter: {
  readonly body?: Node | undefined;
}): readonly GetterWrite[] | undefined {
  const writes: GetterWrite[] = [];
  const pending: Node[] = getter.body === undefined ? [] : [getter.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.kind === SyntaxKind.ThisKeyword) {
      const used = use(node);
      if (used === undefined) return undefined;
      writes.push(...used);
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
  return writes;
}

/** The name a field of a written object is set under, none where it is computed. */
function accessorName(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name))
    return name.text;
  return isNumericLiteral(name) ? String(Number(name.text)) : undefined;
}

/**
 * What running a getter of a written object writes into it: its own writes, and those of the
 * setters of the object that its writes run, and of the setters those run in turn. A write that
 * may name any field runs every setter. None where any of them gives `this` on.
 */
export function accessorWrites(
  object: ObjectLiteralExpression,
  getter: GetAccessorDeclaration,
): readonly GetterWrite[] | undefined {
  const setters = object.properties.filter((each) => isSetAccessorDeclaration(each));
  const found: GetterWrite[] = [];
  const run = new Set<Node>([getter]);
  const pending: { readonly body?: Node | undefined }[] = [getter];
  for (let accessor = pending.pop(); accessor !== undefined; accessor = pending.pop()) {
    const writes = getterWrites(accessor);
    if (writes === undefined) return undefined;
    found.push(...writes);
    for (const setter of setters) {
      const name = accessorName(setter.name);
      const invoked = writes.some(
        (each) => each.name === undefined || name === undefined || each.name === name,
      );
      if (invoked && !run.has(setter)) {
        run.add(setter);
        pending.push(setter);
      }
    }
  }
  return found;
}

/** The node that stands for the same value as `node`, through parentheses and assertions. */
function outermost(node: Node): Node {
  let at = node;
  while (isExpression(at.parent) && unwrapped(at.parent) === node) at = at.parent;
  return at;
}

/** What one mention of `this` writes; none where it is given to anything but a member. */
function use(node: Node): readonly GetterWrite[] | undefined {
  const at = outermost(node);
  const { parent } = at;
  const member = isPropertyAccessExpression(parent) || isElementAccessExpression(parent);
  if (!member || parent.expression !== at) return undefined;
  return memberUse(outermost(parent), parent);
}

/** What a member of `this` is used for: a call runs it, a deletion or an assignment changes it. */
function memberUse(
  member: Node,
  access: PropertyAccessExpression | ElementAccessExpression,
): readonly GetterWrite[] | undefined {
  const user = member.parent;
  if (isTaggedTemplateExpression(user)) return user.tag === member ? undefined : [];
  if ((isCallExpression(user) || isNewExpression(user)) && user.expression === member)
    return undefined;
  if (isDeleteExpression(user) || isPrefixUnaryExpression(user) || isPostfixUnaryExpression(user))
    return [];
  if (isBinaryExpression(user) && user.left === member) return assignment(user, access);
  return isTarget(member) ? undefined : [];
}

/** What an assignment to a member of `this` writes; none where it takes a pattern's place. */
function assignment(
  user: BinaryExpression,
  access: PropertyAccessExpression | ElementAccessExpression,
): readonly GetterWrite[] | undefined {
  if (isTarget(user)) return undefined;
  return VALUE_WRITES.has(user.operatorToken.kind)
    ? [{ name: frameMemberName(access), value: user.right }]
    : [];
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
