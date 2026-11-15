import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isAsExpression,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isElementAccessExpression,
  isEnumDeclaration,
  isExportDeclaration,
  isExportSpecifier,
  isExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNonNullExpression,
  isNumericLiteral,
  isObjectBindingPattern,
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
  isTypeAssertion,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf, isTakenApart, useOf } from './code-globals.ts';
import { initializerOf } from './framed.ts';
import { targetsOf } from './kept.ts';
import { isTypeOnly, readsBinding } from './scope.ts';
import { writtenBy } from './written.ts';

/** Recorded post-declaration mutations against an object literal's own entries. */
interface ObjectWrites {
  readonly all: boolean;
  readonly keys: ReadonlySet<string>;
}

const EMPTY_WRITES: ObjectWrites = { all: false, keys: new Set() };
const WRITES = new WeakMap<ObjectLiteralExpression, ObjectWrites>();

/** Non-freezing extension locks that keep existing entries safe only when their return is discarded. */
const DISCARDED_LOCKS: ReadonlySet<string> = new Set([
  'Object.preventExtensions',
  'Object.seal',
  'Reflect.preventExtensions',
]);

/** Equality operators that inspect object identity without handing the reference onward. */
const COMPARING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
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
    if (state.all || isSkippedSyntax(node)) {
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

/** Whether `node` is erased at compile time or belongs to a type-only import/export. */
function isSkippedSyntax(node: Node): boolean {
  return (
    isTypeOnly(node) ||
    isImportDeclaration(node) ||
    (isExportDeclaration(node) && node.isTypeOnly) ||
    (isExportSpecifier(node) && node.isTypeOnly)
  );
}

/** Whether `object` stands directly as the receiver of an inline member access (`({ pick() {} }).pick`). */
function isInlineMemberReceiver(object: ObjectLiteralExpression): boolean {
  const { at, parent } = useOf(object);
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  );
}

/** Records writes from `node` into `keys`, returning `true` when all keys of `object` become uncertain. */
function recordsAllWrites(node: Node, object: ObjectLiteralExpression, keys: Set<string>): boolean {
  if (isCallExpression(node) && isSafeLockCall(node)) {
    return false;
  }
  const written = writtenBy(node);
  if (written !== undefined && writesUnknownKey(written, object, keys)) {
    return true;
  }
  return isDirectObjectReference(node, object) && !isSafeDirectUse(node);
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

/** Whether `node` evaluates directly to `object` via literal, lexical alias, or enclosing `this`. */
function isDirectObjectReference(node: Node, object: ObjectLiteralExpression): boolean {
  if (node === object) {
    return true;
  }
  if (node.kind === SyntaxKind.ThisKeyword) {
    return isExpression(node) && enclosingMethodObject(node) === object;
  }
  return (
    isIdentifier(node) &&
    !isDeclaredIdentifier(node) &&
    readsBinding(node) &&
    refersToObject(node, object)
  );
}

/** Whether `node` stands as the declared identifier of a variable, parameter, binding, function, class or enum. */
function isDeclaredIdentifier(node: Identifier): boolean {
  const { parent } = node;
  return (
    (isVariableDeclaration(parent) ||
      isParameterDeclaration(parent) ||
      isBindingElement(parent) ||
      isFunctionDeclaration(parent) ||
      isFunctionExpression(parent) ||
      isClassDeclaration(parent) ||
      isClassExpression(parent) ||
      isEnumDeclaration(parent)) &&
    parent.name === node
  );
}

/** Whether `node` projects, spreads, inspects, locks, or tracks `object` without escaping it. */
function isSafeDirectUse(node: Node): boolean {
  const { at, parent } = useOf(node);
  if (isProjectedOrSpreadUse(at, parent) || isPassiveInspectionUse(at, parent)) {
    return true;
  }
  if (isVariableDeclaration(parent) && parent.initializer === at) {
    return isObjectBindingPattern(parent.name) || isTrackedConstAlias(parent);
  }
  return (
    isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === at &&
    isSafeLockCall(parent)
  );
}

/** Whether `at` stands only as a member-access receiver or an object-literal spread source. */
function isProjectedOrSpreadUse(at: Node, parent: Node): boolean {
  if (isSpreadAssignment(parent)) {
    return !isTakenApart(parent.parent);
  }
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  );
}

/** Whether `at` is discarded or inspected without yielding an untracked reference to `object`. */
function isPassiveInspectionUse(at: Node, parent: Node): boolean {
  if (isExpressionStatement(parent) || isVoidExpression(parent) || isTypeOfExpression(parent)) {
    return true;
  }
  if (!isBinaryExpression(parent)) {
    return false;
  }
  const operator = parent.operatorToken.kind;
  return COMPARING.has(operator) || (operator === SyntaxKind.InKeyword && parent.right === at);
}

/** Whether `declared` is an unexported block/module `const` identifier alias followed by `initializerOf`. */
function isTrackedConstAlias(declared: VariableDeclaration): boolean {
  if (!isIdentifier(declared.name) || !isVariableDeclarationList(declared.parent)) {
    return false;
  }
  const statement = declared.parent.parent;
  return (
    isVariableStatement(statement) &&
    (isBlock(statement.parent) || isSourceFile(statement.parent)) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile())) &&
    statement.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) !== true
  );
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
  const top = isFunctionExpression(callable) ? useOf(callable).at : callable;
  const owner = isPropertyAssignment(top.parent) ? top.parent.parent : top.parent;
  return isObjectLiteralExpression(owner) ? owner : undefined;
}

/** Whether `call` invokes `Object.freeze` or a discarded `seal`/`preventExtensions` on a single target. */
function isSafeLockCall(call: CallExpression): boolean {
  if (call.arguments.length !== 1) {
    return false;
  }
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path === 'Object.freeze') {
    return true;
  }
  if (path === undefined || !DISCARDED_LOCKS.has(path)) {
    return false;
  }
  const { parent } = useOf(call);
  return isExpressionStatement(parent) || isVoidExpression(parent);
}
