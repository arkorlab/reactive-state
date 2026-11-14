import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  isBindingElement,
  isAssertionExpression,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isExpressionWithTypeArguments,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isQualifiedName,
  isSatisfiesExpression,
  isSourceFile,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  isVariableDeclaration,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedKeyNames } from './framed-keys.ts';
import { isTypeOnly } from './framed-references.ts';
import { isWrittenMember } from './framed-written-members.ts';
import { constantValue } from './numbers.ts';

const PROTOTYPE_CHANGES = new WeakMap<SourceFile, boolean>();

/** The names that give an object another prototype: the accessor and the function. */
const NAMES: ReadonlySet<string> = new Set(['__proto__', 'setPrototypeOf']);

/**
 * The objects that hold those functions, and the global object that holds them: a member of one by a
 * name the code does not write, or one given to code that does, may be `setPrototypeOf`. `Array` and
 * `Function` hold the prototypes of the arrays and the functions, which a member by a name the code does
 * not write, or one given to code, may reach.
 */
const HOLDERS: ReadonlySet<string> = new Set([
  'Array',
  'Function',
  'global',
  'globalThis',
  'Object',
  'Reflect',
  'self',
  'window',
]);

/** The prototypes of the language's own objects, which a definition may give a setter. */
const PROTOTYPES: ReadonlySet<string> = new Set([
  'Array.prototype',
  'Function.prototype',
  'Object.prototype',
]);

/**
 * Whether a file may give an array another prototype, whose setter an assignment then meets: it
 * names `__proto__` or `setPrototypeOf` as an identifier, a text or a template, or as text the code
 * computes; it reads a member of `Object`, `Reflect` or the global object by a name it does not
 * write; it gives one of them to anything but a member read or a call, or the prototype of a native
 * to a call. A name that cannot be read is one that may be either.
 */
export function prototypeMayChange(file: SourceFile): boolean {
  const known = PROTOTYPE_CHANGES.get(file);
  if (known !== undefined) return known;
  let found = false;
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined && !found; node = pending.pop()) {
    found = names(node) || holds(node) || computesName(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  PROTOTYPE_CHANGES.set(file, found);
  return found;
}

/** Whether a node writes one of the names as an identifier, a text or a template without substitutions. */
function names(node: Node): boolean {
  const written =
    isIdentifier(node) || isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);
  return written && NAMES.has(node.text);
}

/** Whether an expression the code builds as text, by a template or a sum, is one of the names. */
function computesName(node: Node): boolean {
  if (
    !isTemplateExpression(node) &&
    !(isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken)
  )
    return false;
  const value = constantValue(node);
  return typeof value === 'string' && NAMES.has(value);
}

/** The names a key may be, none where the code does not tell. */
function keyNames(key: Expression): readonly string[] | undefined {
  const value = constantValue(unwrapped(key));
  return typeof value === 'string' ? [value] : framedKeyNames(key);
}

/** Whether a key that may be one of the names, or may be any, is written for a holder of them. */
function mayBeName(key: Expression): boolean {
  const known = keyNames(key);
  return known === undefined || known.some((each) => NAMES.has(each));
}

/** Whether a node reads one of the holders as a global, by its name or past the global object. */
function isHolder(node: Node): boolean {
  if (!isIdentifier(node) && !isPropertyAccessExpression(node) && !isElementAccessExpression(node))
    return false;
  const path = globalPathOf(node);
  return path?.length === 1 && HOLDERS.has(path[0] ?? '');
}

/** The initializer of the declaration whose object pattern holds a binding element. */
function sourceOf(element: Node): Expression | undefined {
  const pattern = element.parent;
  const declaration = isObjectBindingPattern(pattern) ? pattern.parent : undefined;
  return declaration !== undefined && isVariableDeclaration(declaration)
    ? declaration.initializer
    : undefined;
}

/**
 * Whether a node reads a member of a holder by a name that may be one of the names, takes the
 * member of a holder out by one, gives a holder away, or gives the prototype of a native to a call.
 */
function holds(node: Node): boolean {
  if (isSourceFile(node) || readByType(node)) return false;
  if (
    isElementAccessExpression(node) &&
    isHolder(unwrapped(node.expression)) &&
    mayBeName(node.argumentExpression)
  )
    return true;
  if (isBindingElement(node) && node.propertyName !== undefined) {
    const source = sourceOf(node);
    return (
      isComputedPropertyName(node.propertyName) &&
      source !== undefined &&
      isHolder(unwrapped(source)) &&
      mayBeName(node.propertyName.expression)
    );
  }
  if (isHolder(node) && gaveAway(node)) return true;
  return writesPrototype(node);
}

/** Whether a name is read by a type only: `Array<string>`, `typeof Object`: a type names no value. */
function readByType(node: Node): boolean {
  let at = node.parent;
  while (isQualifiedName(at)) at = at.parent;
  return isTypeOnly(at);
}

/** Whether a node is the prototype of one of the language's own objects. */
function isNativePrototype(node: Node): boolean {
  const named = isPropertyAccessExpression(node) || isElementAccessExpression(node);
  const path = named ? globalPathOf(node)?.join('.') : undefined;
  return path !== undefined && PROTOTYPES.has(path);
}

/**
 * Whether a node reaches a prototype without naming a native one: `Object.getPrototypeOf(a)`, or the
 * `prototype` of a `constructor` (`a.constructor.prototype`), by a name or a text.
 */
function isReachedPrototype(node: Node): boolean {
  if (isCallExpression(node)) {
    const callee = unwrapped(node.expression);
    return isMemberAccess(callee) && frameMemberName(callee) === 'getPrototypeOf';
  }
  if (!isMemberAccess(node) || frameMemberName(node) !== 'prototype') return false;
  const object = unwrapped(node.expression);
  return isMemberAccess(object) && frameMemberName(object) === 'constructor';
}

/** Whether a node is a member read by a name or a key. */
function isMemberAccess(node: Node): node is PropertyAccessExpression | ElementAccessExpression {
  return isPropertyAccessExpression(node) || isElementAccessExpression(node);
}

/** Whether an expression reads the prototype an object has: its `prototype`, or `Object.getPrototypeOf(it)`. */
function isPrototypeOf(node: Expression): boolean {
  const value = unwrapped(node);
  const callee = isCallExpression(value) ? unwrapped(value.expression) : value;
  return (
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
    ['getPrototypeOf', 'prototype'].includes(frameMemberName(callee) ?? '')
  );
}

/** Whether a member access is assigned, in a pattern or a loop head, deleted, or stepped. */
function changed(member: Node): boolean {
  const { parent } = member;
  return (
    isWrittenMember(member) ||
    isDeleteExpression(parent) ||
    isPrefixUnaryExpression(parent) ||
    isPostfixUnaryExpression(parent)
  );
}

/** The operators that compare what they are given and do nothing with it. */
const COMPARISONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** Whether a prototype is given away, compared with no more than its identity, or has a member written. */
function usedOtherwiseThanRead(node: Node): boolean {
  let at: Node = node;
  while (passes(at.parent, at)) at = at.parent;
  const { parent } = at;
  if (isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return false;
  return !isMemberAccess(parent) || parent.expression !== at || changed(parent);
}

/**
 * Whether a node is a prototype of one of the language's own objects, or one an object has, whose
 * member is written or deleted, or which is given away, kept in a variable or a list: a read of a
 * member by a name written out does not change it.
 */
function writesPrototype(node: Node): boolean {
  if (isNativePrototype(node) || isReachedPrototype(node)) return usedOtherwiseThanRead(node);
  const member = isPropertyAccessExpression(node) || isElementAccessExpression(node);
  return member && isPrototypeOf(node.expression) && changed(node);
}

/** Whether an expression gives the value of an operand as its own: parentheses, a cast, a comma's last. */
function passes(parent: Node, at: Node): boolean {
  if (isBinaryExpression(parent))
    return parent.operatorToken.kind === SyntaxKind.CommaToken && parent.right === at;
  return (
    isParenthesizedExpression(parent) ||
    isAssertionExpression(parent) ||
    isNonNullExpression(parent) ||
    isSatisfiesExpression(parent)
  );
}

/** Whether a node is the `this` a call of `call`, `apply` or `bind` gives, which a native does not read members of. */
function isThisArgument(call: CallExpression, at: Node): boolean {
  const callee = unwrapped(call.expression);
  return (
    isPropertyAccessExpression(callee) &&
    ['apply', 'bind', 'call'].includes(callee.name.text) &&
    isExpression(at) &&
    call.arguments[0] === at
  );
}

/**
 * Whether a holder is used otherwise than as the object of a member read, a callee, the base of a
 * class, the `this` of a call of a function, or a test of what it is.
 */
function gaveAway(node: Node): boolean {
  let at: Node = node;
  while (passes(at.parent, at)) at = at.parent;
  const { parent } = at;
  if (isPropertyAccessExpression(parent) || isElementAccessExpression(parent))
    return parent.expression !== at;
  if (isCallExpression(parent)) return parent.expression !== at && !isThisArgument(parent, at);
  if (isNewExpression(parent)) return parent.expression !== at;
  if (isTypeOfExpression(parent) || isExpressionWithTypeArguments(parent)) return false;
  return !(
    isBinaryExpression(parent) &&
    (parent.operatorToken.kind === SyntaxKind.InstanceOfKeyword ||
      COMPARISONS.has(parent.operatorToken.kind))
  );
}
