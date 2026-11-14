import {
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Whether a constant object may have changed where code copies it: any mention but a read says so. */

/** The answers for each constant, read once. */
const CHANGED = new WeakMap<VariableDeclaration, boolean>();

/** Whether a variable is declared whole with `const`, which nothing assigns anew. */
export function isConstantDeclaration(declared: VariableDeclaration): boolean {
  return (
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/**
 * Whether the object a constant holds may be other than its literal wrote where it is copied. A
 * member write, a deletion, a loop head or a pattern that targets one of its members, a call of one
 * of its members, a call that is handed it, a variable that names it, a literal or a return that
 * holds it: any mention of it, or of a constant that names it, in the module, wherever it stands,
 * but a read of a member, a spread of it, a constant that names it, and a source of `Object.assign`.
 */
export function sourceChanged(holder: VariableDeclaration): boolean {
  const known = CHANGED.get(holder);
  if (known !== undefined) return known;
  const changed = mentionsChange(holder);
  CHANGED.set(holder, changed);
  return changed;
}

/** Whether a mention of the constant, or of a constant that names it, may change it. */
function mentionsChange(holder: VariableDeclaration): boolean {
  const { name } = holder;
  if (!isIdentifier(name)) return true;
  const mentions: Identifier[] = [];
  const declarations: VariableDeclaration[] = [];
  const pending: Node[] = [holder.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && readsBinding(node)) mentions.push(node);
    if (isVariableDeclaration(node)) declarations.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const names = namesOf(name.text, declarations);
  return mentions.some((mention) => names.has(mention.text) && touches(mention));
}

/** The names of a constant, and of each variable declared as another of them, by their text. */
function namesOf(first: string, declarations: readonly VariableDeclaration[]): ReadonlySet<string> {
  const names = new Set([first]);
  for (let grown = true; grown;) {
    const named = declarations.filter((each) => namesAnother(each, names));
    for (const each of named) names.add((each.name as Identifier).text);
    grown = named.length > 0;
  }
  return names;
}

/** Whether a declaration gives a new name to a variable of the set. */
function namesAnother(declaration: VariableDeclaration, names: ReadonlySet<string>): boolean {
  const { name, initializer } = declaration;
  if (initializer === undefined || !isIdentifier(name) || names.has(name.text)) return false;
  const value = unwrapped(initializer);
  return isIdentifier(value) && names.has(value.text);
}

/** Whether a mention may change the object, or hand it to code that may: no read is such a use. */
function touches(mention: Identifier): boolean {
  if (isVariableDeclaration(mention.parent) && mention.parent.name === mention) return false;
  let node: Node = mention;
  while (transparent(node.parent)) node = node.parent;
  if (!memberReceiver(node)) return !readAsWhole(node);
  while (memberReceiver(node)) {
    node = node.parent;
    while (transparent(node.parent)) node = node.parent;
  }
  return writtenTarget(node) || called(node);
}

/** Uses of the object as a whole that change nothing: a spread, a constant alias, a copy's source. */
function readAsWhole(node: Node): boolean {
  const { parent } = node;
  if (isSpreadAssignment(parent)) return true;
  if (isVariableDeclaration(parent)) {
    const { initializer } = parent;
    return initializer !== undefined && initializer === node && isConstantAlias(parent);
  }
  if (!isCallExpression(parent)) return false;
  const copies = globalPathOf(unwrapped(parent.expression))?.join('.') === 'Object.assign';
  return copies && parent.arguments.some((each, index) => index > 0 && each === node);
}

/** Whether a member chain is called, as a method, a constructor or a tag, with the object as `this`. */
function called(node: Node): boolean {
  const { parent } = node;
  return (
    ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === node) ||
    (isTaggedTemplateExpression(parent) && parent.tag === node)
  );
}

/** Whether a chain is the target of an assignment of any kind, a pattern, a loop head or a deletion. */
function writtenTarget(node: Node): boolean {
  let target = node;
  while (patternPart(target)) target = target.parent;
  const { parent } = target;
  if (isBinaryExpression(parent) && parent.left === target) {
    const kind = parent.operatorToken.kind;
    return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
  }
  if (isForInStatement(parent) || isForOfStatement(parent)) return parent.initializer === target;
  if (isDeleteExpression(parent)) return true;
  return (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  );
}

/** Syntax an assignment pattern is made of, around the member it targets. */
function patternPart(target: Node): boolean {
  const { parent } = target;
  return (
    transparent(parent) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === target) ||
    (isShorthandPropertyAssignment(parent) && parent.name === target)
  );
}

/** Whether a declaration names a constant of its own, the name an alias is read by. */
function isConstantAlias(declaration: VariableDeclaration): boolean {
  return isIdentifier(declaration.name) && isConstantDeclaration(declaration);
}

/** Whether a node is a member read of its expression, `object.name` or `object[key]`. */
function memberReceiver(node: Node): boolean {
  const { parent } = node;
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

/** Syntax that keeps the identity of the expression it wraps. */
function transparent(node: Node): boolean {
  return (
    isAsExpression(node) ||
    isTypeAssertion(node) ||
    isParenthesizedExpression(node) ||
    isNonNullExpression(node) ||
    isSatisfiesExpression(node)
  );
}
