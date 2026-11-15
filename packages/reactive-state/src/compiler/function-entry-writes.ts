import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  isAsExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNonNullExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isTaggedTemplateExpression,
  isTypeAssertion,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { initializerOf } from './framed.ts';
import { targetsOf } from './kept.ts';
import { freeReads, isTypeOnly } from './scope.ts';
import { writtenBy } from './written.ts';

/** Recorded post-declaration mutations against an object literal's own entries. */
interface ObjectWrites {
  readonly all: boolean;
  readonly keys: ReadonlySet<string>;
}

const EMPTY_WRITES: ObjectWrites = { all: false, keys: new Set() };
const WRITES = new WeakMap<ObjectLiteralExpression, ObjectWrites>();

/** Built-in calls that restrict future mutations on their target without replacing existing entries. */
const LOCKING_FUNCTIONS: ReadonlySet<string> = new Set([
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Reflect.preventExtensions',
]);

/** Whether entry `name` of `object` may be replaced or mutated after construction. */
export function entryReplaced(object: ObjectLiteralExpression, name: string): boolean {
  const writes = objectWrites(object);
  return writes.all || writes.keys.has(name);
}

/** Whether any entry of `object` may be replaced or mutated after construction. */
export function anyEntryReplaced(object: ObjectLiteralExpression): boolean {
  const writes = objectWrites(object);
  return writes.all || writes.keys.size > 0;
}

/** Static key of an element access expression, including string, template and numeric literals. */
export function elementEntryKey(node: ElementAccessExpression): string | undefined {
  const name = literalName(node);
  if (name !== undefined) {
    return name;
  }
  const argument = unwrapped(node.argumentExpression);
  return isNumericLiteral(argument) ? String(Number(argument.text)) : undefined;
}

/** Computes and caches post-declaration writes affecting `object` across its source file. */
function objectWrites(object: ObjectLiteralExpression): ObjectWrites {
  const cached = WRITES.get(object);
  if (cached !== undefined) {
    return cached;
  }
  if (isInlineMemberReceiver(object)) {
    WRITES.set(object, EMPTY_WRITES);
    return EMPTY_WRITES;
  }
  const keys = new Set<string>();
  const state = { all: false };
  const visit = (node: Node): void => {
    if (state.all) {
      return;
    }
    if (recordsAllWrites(node, object, keys)) {
      state.all = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(object.getSourceFile());
  const result: ObjectWrites = { all: state.all, keys };
  WRITES.set(object, result);
  return result;
}

/** Whether `object` stands directly as the receiver of an inline member access (`({ pick() {} }).pick`). */
function isInlineMemberReceiver(object: ObjectLiteralExpression): boolean {
  const top = topWrapper(object);
  const parent = top.parent;
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === top
  );
}

/** Records writes from `node` into `keys`, returning `true` when all keys of `object` become uncertain. */
function recordsAllWrites(node: Node, object: ObjectLiteralExpression, keys: Set<string>): boolean {
  if (isCallExpression(node) && isLockingCall(node)) {
    return false;
  }
  const written = writtenBy(node);
  if (written !== undefined && writesUnknownKey(written, object, keys)) {
    return true;
  }
  return escapesObject(node, object);
}

/** Updates `keys` for every assignment or mutation target in `written`; answers `true` for whole/dynamic writes. */
function writesUnknownKey(
  written: Node,
  object: ObjectLiteralExpression,
  keys: Set<string>,
): boolean {
  for (const rawTarget of targetsOf(written)) {
    const target = unwrapTarget(rawTarget);
    if (refersToNode(target, object)) {
      return true;
    }
    if (
      (isPropertyAccessExpression(target) || isElementAccessExpression(target)) &&
      refersToObject(target.expression, object)
    ) {
      const key = isPropertyAccessExpression(target) ? target.name.text : elementEntryKey(target);
      if (key === undefined) {
        return true;
      }
      keys.add(key);
    }
  }
  return false;
}

/** Strips parentheses, casts and non-null assertions from a write target node. */
function unwrapTarget(node: Node): Node {
  let each = node;
  while (
    isParenthesizedExpression(each) ||
    isAsExpression(each) ||
    isSatisfiesExpression(each) ||
    isNonNullExpression(each) ||
    isTypeAssertion(each)
  ) {
    each = each.expression;
  }
  return each;
}

/** Whether `node` hands `object` itself to a call, constructor, tagged template or mutable assignment. */
function escapesObject(node: Node, object: ObjectLiteralExpression): boolean {
  if (isCallExpression(node) || isNewExpression(node)) {
    return node.arguments?.some((argument) => containsDirectRead(argument, object)) === true;
  }
  if (isTaggedTemplateExpression(node)) {
    return containsDirectRead(node.template, object);
  }
  return (
    isBinaryExpression(node) &&
    node.operatorToken.kind === SyntaxKind.EqualsToken &&
    containsDirectRead(node.right, object)
  );
}

/** Whether `node` contains a direct reference to `object` rather than a member projection or object spread. */
function containsDirectRead(node: Node, object: ObjectLiteralExpression): boolean {
  for (const read of freeReads(node)) {
    if (!isProjectedHolder(read) && refersToObject(read, object)) {
      return true;
    }
  }
  return containsDirectThisRead(node, object);
}

/** Whether `node` hands an unprojected `this` bound to `object` into an expression. */
function containsDirectThisRead(node: Node, object: ObjectLiteralExpression): boolean {
  let found = false;
  const visit = (current: Node): void => {
    if (found || isTypeOnly(current)) {
      return;
    }
    if (current.kind === SyntaxKind.ThisKeyword && isExpression(current)) {
      found = !isProjectedHolder(current) && enclosingMethodObject(current) === object;
      return;
    }
    current.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** Whether `read` is only used as the receiver of a property/element access or an object spread source. */
function isProjectedHolder(read: Expression): boolean {
  const top = topWrapper(read);
  const parent = top.parent;
  if (isSpreadAssignment(parent)) {
    return true;
  }
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === top
  );
}

/** Walks up reference-preserving expression wrappers around `node`. */
function topWrapper(node: Expression): Expression {
  let at = node;
  while (
    isParenthesizedExpression(at.parent) ||
    isNonNullExpression(at.parent) ||
    isAsExpression(at.parent) ||
    isSatisfiesExpression(at.parent) ||
    isTypeAssertion(at.parent)
  ) {
    at = at.parent;
  }
  return at;
}

/** Narrowing wrapper around `refersToObject` for arbitrary write target syntax nodes. */
function refersToNode(node: Node, object: ObjectLiteralExpression): boolean {
  if (node === object) {
    return true;
  }
  if (node.kind === SyntaxKind.ThisKeyword) {
    return enclosingMethodObject(node) === object;
  }
  return isIdentifier(node) && refersToObject(node, object);
}

/** Whether `node` resolves to `object` through lexical initializers or an enclosing object method's `this`. */
function refersToObject(node: Expression, object: ObjectLiteralExpression): boolean {
  const seen = new Set<Expression>();
  let held = unwrapped(node);
  while (!seen.has(held)) {
    if (held === object) {
      return true;
    }
    if (held.kind === SyntaxKind.ThisKeyword) {
      return enclosingMethodObject(held) === object;
    }
    seen.add(held);
    if (!isIdentifier(held)) {
      return false;
    }
    const initializer = initializerOf(held);
    if (initializer === undefined) {
      return false;
    }
    held = unwrapped(initializer);
  }
  return false;
}

/** Object literal owning the nearest non-arrow `this`-binding callable around `node`, if any. */
function enclosingMethodObject(node: Node): ObjectLiteralExpression | undefined {
  for (
    let at: Node = node.parent, within: Node = node;
    !isSourceFile(at);
    within = at, at = at.parent
  ) {
    if (bindsOwnThis(at, within)) {
      return callableOwnerObject(at);
    }
  }
  return undefined;
}

/** Whether `at` introduces its own non-arrow `this` binding around child `within`. */
function bindsOwnThis(at: Node, within: Node): boolean {
  if (isFunctionDeclaration(at) || isFunctionExpression(at) || isClassStaticBlockDeclaration(at)) {
    return true;
  }
  if (isPropertyDeclaration(at)) {
    return isExpression(within) && within === at.initializer;
  }
  return (
    (isMethodDeclaration(at) ||
      isGetAccessorDeclaration(at) ||
      isSetAccessorDeclaration(at) ||
      isConstructorDeclaration(at)) &&
    ((isBlock(within) && within === at.body) || isParameterDeclaration(within))
  );
}

/** Object literal directly owning a method, accessor or function-expression property `callable`. */
function callableOwnerObject(callable: Node): ObjectLiteralExpression | undefined {
  const top = isFunctionExpression(callable) ? topWrapper(callable) : callable;
  const owner = isPropertyAssignment(top.parent) ? top.parent.parent : top.parent;
  return isObjectLiteralExpression(owner) ? owner : undefined;
}

/** Whether `call` invokes a locking global (`Object.freeze`, `Object.seal`, `preventExtensions`). */
function isLockingCall(call: CallExpression): boolean {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  return path !== undefined && LOCKING_FUNCTIONS.has(path);
}
