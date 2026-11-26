/**
 * Whether a class that extends a native collection keeps the collection's prototype to itself. A
 * subclass reaches it through `Sub.prototype.__proto__` or `Object.getPrototypeOf`, which the
 * prototype scan reads wherever they are written, or through `super` in the subclass's own body.
 */

import {
  type ExpressionWithTypeArguments,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isHeritageClause,
  isPropertyAccessExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

/** The `super` members a call may name without reaching the collection's constructor. */
const REACHING = new Set(['__proto__', 'constructor']);

/**
 * Whether a class's `extends` entry that names a collection constructor hands it to nothing: the
 * class's body uses `super` only to call the constructor, `super(…)`, or a method it names,
 * `super.get(key)`, never `super.constructor` or `super` itself as a value, through which a static
 * member reaches the collection's prototype too (`super.prototype`).
 */
export function framedHeritageKept(entry: ExpressionWithTypeArguments): boolean {
  const clause = entry.parent;
  if (!isHeritageClause(clause) || clause.token !== SyntaxKind.ExtendsKeyword) return false;
  const owner = clause.parent;
  if (!isClassDeclaration(owner) && !isClassExpression(owner)) return false;
  return owner.members.every((member) => !looseSuper(member));
}

/** Whether a member uses `super` other than to call the constructor or a method it names. */
function looseSuper(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.kind === SyntaxKind.SuperKeyword && !calledSuper(node)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** `super(…)`, or a call of a method `super` names but `constructor`: `super.get(key)`. */
function calledSuper(node: Node): boolean {
  const { parent } = node;
  if (isCallExpression(parent) && parent.expression === node) return true;
  if (!isPropertyAccessExpression(parent) || parent.expression !== node) return false;
  if (REACHING.has(parent.name.text)) return false;
  const call = parent.parent;
  return isCallExpression(call) && call.expression === parent;
}
