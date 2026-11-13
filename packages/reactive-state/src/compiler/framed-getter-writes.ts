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
  isGetAccessorDeclaration,
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
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyName,
  type SetAccessorDeclaration,
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
 * which is no object (it runs a setter all the same: `accessorWrites` counts the names). None where `this` is given to anything else: a call, a method, a pattern, a
 * loop head, a list, the result of the getter.
 */
export function getterWrites(getter: {
  readonly body?: Node | undefined;
}): readonly GetterWrite[] | undefined {
  return thisUses(getter)?.writes;
}

/** What a body does with `this`: the values it writes, and every name it assigns to, which runs a setter. */
interface ThisUses {
  readonly writes: readonly GetterWrite[];
  readonly named: readonly (string | undefined)[];
}

const NOTHING: ThisUses = { writes: [], named: [] };

/** What the mentions of `this` in a body come to; none where `this` is given on. */
function thisUses(getter: { readonly body?: Node | undefined }): ThisUses | undefined {
  const writes: GetterWrite[] = [];
  const named: (string | undefined)[] = [];
  const pending: Node[] = getter.body === undefined ? [] : [getter.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.kind === SyntaxKind.ThisKeyword) {
      const used = use(node);
      if (used === undefined) return undefined;
      writes.push(...used.writes);
      named.push(...used.named);
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
  return { writes, named };
}

/** The name a field of a written object is set under, none where it is computed. */
function accessorName(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name))
    return name.text;
  return isNumericLiteral(name) ? String(Number(name.text)) : undefined;
}

/**
 * What running a getter of a written object writes into it: its own writes, and those of the
 * setters of the object that its writes run, and of the setters those run in turn. Any assignment
 * to a member of `this` runs a setter: `=`, an arithmetic or a logical one, an increment. A write
 * that may name any field runs every setter. The setters of the objects a getter that is inherited
 * runs on are `receiving`; a write the object does not hold itself may run a setter of the
 * prototype it sets. None where any of them gives `this` on, or where a setter that cannot be
 * read may run.
 */
export function accessorWrites(
  object: ObjectLiteralExpression,
  getter: GetAccessorDeclaration,
  receiving: readonly SetAccessorDeclaration[] = [],
): readonly GetterWrite[] | undefined {
  const setters = [
    ...object.properties.filter((each, at, all) => isLiveSetter(each, all.slice(at + 1))),
    ...receiving,
  ].filter((each) => isSetAccessorDeclaration(each));
  const found: GetterWrite[] = [];
  const run = new Set<Node>([getter]);
  const pending: { readonly body?: Node | undefined }[] = [getter];
  for (let accessor = pending.pop(); accessor !== undefined; accessor = pending.pop()) {
    const uses = thisUses(accessor);
    if (uses === undefined || runsPrototypeSetter(object, uses.named)) return undefined;
    found.push(...uses.writes);
    for (const setter of setters) {
      const name = accessorName(setter.name);
      const invoked = uses.named.some(
        (each) => each === undefined || name === undefined || each === name,
      );
      if (invoked && !run.has(setter)) {
        run.add(setter);
        pending.push(setter);
      }
    }
  }
  return found;
}

/** Whether a field is a setter that no field after it replaces with a value or a method. */
function isLiveSetter(
  property: ObjectLiteralElementLike,
  after: readonly ObjectLiteralElementLike[],
): boolean {
  if (!isSetAccessorDeclaration(property)) return false;
  const name = accessorName(property.name);
  return name === undefined || after.every((each) => !replaces(each, name));
}

/** Whether a field gives the name a value that is no accessor: a field, a method, a spread that holds it. */
function replaces(property: ObjectLiteralElementLike, name: string): boolean {
  if (isSpreadAssignment(property)) {
    const value = unwrapped(property.expression);
    return (
      isObjectLiteralExpression(value) && value.properties.some((each) => replaces(each, name))
    );
  }
  if (isGetAccessorDeclaration(property) || isSetAccessorDeclaration(property)) return false;
  return accessorName(property.name) === name;
}

/** Whether a write the object does not hold may reach a setter of the prototype the object sets. */
function runsPrototypeSetter(
  object: ObjectLiteralExpression,
  named: readonly (string | undefined)[],
): boolean {
  const sets = object.properties.some((each) => {
    if (!isPropertyAssignment(each)) return false;
    return (
      (isIdentifier(each.name) || isStringLiteral(each.name)) && each.name.text === '__proto__'
    );
  });
  if (!sets) return false;
  const own = new Set(
    object.properties.flatMap((each) => {
      const name = isSpreadAssignment(each) ? undefined : accessorName(each.name);
      return name === undefined ? [] : [name];
    }),
  );
  return named.some((each) => each === undefined || !own.has(each));
}

/** The node that stands for the same value as `node`, through parentheses and assertions. */
function outermost(node: Node): Node {
  let at = node;
  while (isExpression(at.parent) && unwrapped(at.parent) === node) at = at.parent;
  return at;
}

/** What one mention of `this` does; none where it is given to anything but a member. */
function use(node: Node): ThisUses | undefined {
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
): ThisUses | undefined {
  const user = member.parent;
  if (isTaggedTemplateExpression(user)) return user.tag === member ? undefined : NOTHING;
  if ((isCallExpression(user) || isNewExpression(user)) && user.expression === member)
    return undefined;
  if (isDeleteExpression(user)) return NOTHING;
  if (isPrefixUnaryExpression(user) || isPostfixUnaryExpression(user))
    return changes(user.operator) ? { writes: [], named: [frameMemberName(access)] } : NOTHING;
  if (isBinaryExpression(user) && user.left === member) return assignment(user, access);
  return isTarget(member) ? undefined : NOTHING;
}

/** Whether a unary operator assigns to its operand. */
function changes(operator: SyntaxKind): boolean {
  return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken;
}

/** What an assignment to a member of `this` writes; none where it takes a pattern's place. */
function assignment(
  user: BinaryExpression,
  access: PropertyAccessExpression | ElementAccessExpression,
): ThisUses | undefined {
  if (isTarget(user)) return undefined;
  const { kind } = user.operatorToken;
  if (kind < SyntaxKind.FirstAssignment || kind > SyntaxKind.LastAssignment) return NOTHING;
  const name = frameMemberName(access);
  return VALUE_WRITES.has(kind)
    ? { writes: [{ name, value: user.right }], named: [name] }
    : { writes: [], named: [name] };
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
