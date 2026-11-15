import {
  type BindingName,
  type Expression,
  type Identifier,
  isArrowFunction,
  isAsExpression,
  isCallExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  isVariableDeclaration,
  type Node,
  type PropertyDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { startupField } from './kept-fields.ts';
import { bindingIdentifiers, freeReads, hoistedIn } from './scope.ts';

/** Lexical scope, startup-call and wrapper helpers for module-kept state analysis. */

const FREE_READS = new WeakMap<Node, ReadonlySet<Identifier>>();

/** Whether `node` runs anew for a call or instance: a function or an instance field's initializer. */
export function isFunctionCode(node: Node): boolean {
  return (
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isInstanceField(node)
  );
}

/** Whether `child` belongs to deferred code rather than the field's class-definition expressions. */
export function isCodeAt(node: Node, child: Node): boolean {
  return (
    isFunctionCode(node) &&
    (!isPropertyDeclaration(node) || (Object.is(node.initializer, child) && !startupField(node)))
  );
}

/** Parentheses, type assertions and `!` preserve the runtime expression they wrap. */
export function isTypeWrapper(node: Node): node is Node & { readonly expression: Expression } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node)
  );
}

/** Whether `fn`, a function, is called where it is written, once: `(() => { … })()`. */
export function isCalledInPlace(fn: Node): boolean {
  let at = fn;
  while (isTypeWrapper(at.parent)) at = at.parent;
  const call = at.parent;
  return isCallExpression(call) && call.expression === at;
}

/** Whether `node` stands within `fn`. */
export function isWithin(node: Node, fn: Node): boolean {
  for (let at: Node = node.parent; !isSourceFile(at); at = at.parent) {
    if (at === fn) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the module calls `fn` by its name as it loads, `const next = makeCounter()` — of the name
 * it is declared by, or a variable's it is the value of, where nothing between declares it again.
 */
export function isCalledAsLoads(fn: Node): boolean {
  const name = nameOf(fn);
  if (name === undefined) {
    return false;
  }
  const holder = holderOf(name);
  let found = false;
  const visit = (node: Node): void => {
    // A function's code, but one called in place, runs as it is called, not as the module loads.
    if (found) {
      return;
    }
    if (isInstanceField(node)) {
      if (isComputedPropertyName(node.name)) {
        visit(node.name.expression);
      }
      if (startupField(node) && node.initializer !== undefined) {
        visit(node.initializer);
      }
      return;
    }
    if (isFunctionCode(node) && !isCalledInPlace(node)) {
      return;
    }
    const callee = isCallExpression(node) ? unwrapped(node.expression) : undefined;
    found =
      callee !== undefined &&
      isIdentifier(callee) &&
      callee.text === name.text &&
      holderOf(callee) === holder;
    if (!found) {
      node.forEachChild(visit);
    }
  };
  let file: Node = fn;
  while (!isSourceFile(file)) {
    file = file.parent;
  }
  file.forEachChild(visit);
  return found;
}

/** Whether this identifier resolves within `fn`, using its actual block, loop and catch scopes. */
export function declares(fn: Node, name: Identifier): boolean {
  if ((isFunctionDeclaration(fn) && fn.name === name) || readsFunctionObject(fn, name)) {
    return false;
  }
  return !freeWithin(fn).has(name);
}

/** An instance field's initializer runs at construction; its computed key runs at class definition. */
function isInstanceField(node: Node): node is PropertyDeclaration {
  return (
    isPropertyDeclaration(node) &&
    node.initializer !== undefined &&
    node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) !== true
  );
}

/** The name `fn` is called by: the one it is declared by, or a variable's it is the value of. */
function nameOf(fn: Node): Identifier | undefined {
  if (isFunctionDeclaration(fn)) {
    return fn.name;
  }
  let at = fn.parent;
  while (isTypeWrapper(at)) at = at.parent;
  return isVariableDeclaration(at) && isIdentifier(at.name) ? at.name : undefined;
}

/** What declares `name` where it stands, of its own (`declares`): a function around it, or the module. */
function holderOf(name: Identifier): Node {
  let child: Node = name;
  let at: Node = name.parent;
  while (!isSourceFile(at) && !(isCodeAt(at, child) && declares(at, name))) {
    child = at;
    at = at.parent;
  }
  return at;
}

/** The free identifier nodes of one immutable syntax tree, preserving block binding identities. */
function freeWithin(fn: Node): ReadonlySet<Identifier> {
  let free = FREE_READS.get(fn);
  if (free === undefined) {
    free = new Set(freeReads(fn));
    FREE_READS.set(fn, free);
  }
  return free;
}

/** A named expression's self reference reaches the function object allocated by its outer frame. */
function readsFunctionObject(fn: Node, name: Identifier): boolean {
  if (!isFunctionExpression(fn) || fn.name?.text !== name.text) {
    return false;
  }
  const bound = (declaration: { readonly name: BindingName }): boolean =>
    bindingIdentifiers(declaration.name).some((each) => each.text === name.text);
  if (fn.parameters.some((parameter) => bound(parameter))) {
    return false;
  }
  if (!isWithin(name, fn.body)) {
    return true;
  }
  return (
    hoistedIn([fn.body]).every((declaration) => !bound(declaration)) &&
    freeWithin(fn.body).has(name)
  );
}
