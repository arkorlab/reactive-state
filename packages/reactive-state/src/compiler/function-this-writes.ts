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
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
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
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf, isTakenApart, useOf } from './code-globals.ts';
import { initializerOf } from './framed.ts';
import { targetsOf } from './kept.ts';
import { isTypeOnly, readsBinding } from './scope.ts';
import { writtenBy } from './written.ts';

/** Recorded post-declaration or receiver mutations against an object literal's entries. */
export interface ObjectWrites {
  readonly all: boolean;
  readonly keys: ReadonlySet<string>;
}

/** Cached `this`-writes inside a single callable together with any `this.prop = rhs` expressions. */
interface RawCallableWrites {
  readonly all: boolean;
  readonly installed: readonly Expression[];
  readonly keys: ReadonlySet<string>;
}

export const EMPTY_WRITES: ObjectWrites = { all: false, keys: new Set() };
const RAW_CALLABLE_WRITES = new WeakMap<Node, RawCallableWrites>();

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

/** Assignment operators that can install a new property value on a receiver. */
export const VALUE_ASSIGNING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Static key of an element access expression, including string, template and numeric literals. */
export function staticElementKey(node: ElementAccessExpression): string | undefined {
  const name = literalName(node);
  if (name !== undefined) {
    return name;
  }
  const argument = unwrapped(node.argumentExpression);
  return isNumericLiteral(argument) ? String(Number(argument.text)) : undefined;
}

/** Whether `node` is erased at compile time or belongs to a type-only import/export. */
export function isSkippedSyntax(node: Node): boolean {
  return (
    isTypeOnly(node) ||
    isImportDeclaration(node) ||
    (isExportDeclaration(node) && node.isTypeOnly) ||
    (isExportSpecifier(node) && node.isTypeOnly)
  );
}

/** Strips parentheses, casts and non-null assertions from a write target node. */
export function unwrapTarget(node: Node): Node {
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

/** Whether `node` stands as the declared identifier of a variable, parameter, binding, function, class or enum. */
export function isDeclaredIdentifier(node: Identifier): boolean {
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

/** Whether `node` projects, spreads, inspects, locks, or tracks an object without escaping it. */
export function isSafeDirectUse(node: Node): boolean {
  const { at, parent } = useOf(node);
  if (isProjectedOrSpreadUse(at, parent) || isPassiveInspectionUse(at, parent)) {
    return true;
  }
  if ((isVariableDeclaration(parent) || isBindingElement(parent)) && parent.initializer === at) {
    return (
      isObjectBindingPattern(parent.name) ||
      (isVariableDeclaration(parent) && isTrackedConstAlias(parent))
    );
  }
  return (
    isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === at &&
    isSafeLockCall(parent)
  );
}

/** Whether `call` invokes `Object.freeze` or a discarded `seal`/`preventExtensions` on a single target. */
export function isSafeLockCall(call: CallExpression): boolean {
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

/** Returns receiver writes and escapes performed by `callable` against its own `this` binding. */
export function callableThisWrites(
  callable: Node,
  resolveCallables: (value: Expression) => readonly Node[],
  seenCallables: Set<Node>,
): ObjectWrites {
  if (seenCallables.has(callable)) {
    return EMPTY_WRITES;
  }
  seenCallables.add(callable);
  const raw = rawCallableWrites(callable);
  if (raw.all || raw.installed.length === 0) {
    return raw.all ? { all: true, keys: raw.keys } : raw;
  }
  const keys = new Set(raw.keys);
  for (const value of raw.installed) {
    for (const next of resolveCallables(value)) {
      const nested = callableThisWrites(next, resolveCallables, seenCallables);
      if (nested.all) {
        return { all: true, keys };
      }
      for (const key of nested.keys) {
        keys.add(key);
      }
    }
  }
  return { all: false, keys };
}

/** Computes and caches direct `this`-receiver writes and escapes inside `callable`. */
function rawCallableWrites(callable: Node): RawCallableWrites {
  const cached = RAW_CALLABLE_WRITES.get(callable);
  if (cached !== undefined) {
    return cached;
  }
  const keys = new Set<string>();
  const installed: Expression[] = [];
  const state = { all: false };
  const visit = (node: Node): void => {
    if (state.all || isSkippedSyntax(node)) {
      return;
    }
    if (recordsCallableThisWrites(node, callable, keys, installed)) {
      state.all = true;
      return;
    }
    node.forEachChild(visit);
  };
  visitCallableScope(callable, visit);
  const result: RawCallableWrites = { all: state.all, installed, keys };
  RAW_CALLABLE_WRITES.set(callable, result);
  return result;
}

/** Walks only the parameter and body subtrees governed by `callable`'s own `this` binding. */
function visitCallableScope(callable: Node, visit: (node: Node) => void): void {
  if (
    !isFunctionDeclaration(callable) &&
    !isFunctionExpression(callable) &&
    !isMethodDeclaration(callable) &&
    !isGetAccessorDeclaration(callable) &&
    !isSetAccessorDeclaration(callable)
  ) {
    return;
  }
  for (const parameter of callable.parameters) {
    visit(parameter);
  }
  if (callable.body !== undefined) {
    visit(callable.body);
  }
}

/** Records `this` writes/escapes at `node`, answering `true` when all receiver keys become uncertain. */
function recordsCallableThisWrites(
  node: Node,
  callable: Node,
  keys: Set<string>,
  installed: Expression[],
): boolean {
  if (isCallExpression(node) && isSafeLockCall(node)) {
    return false;
  }
  if (isBinaryExpression(node) && VALUE_ASSIGNING.has(node.operatorToken.kind)) {
    const target = unwrapTarget(node.left);
    if (
      (isPropertyAccessExpression(target) || isElementAccessExpression(target)) &&
      refersToCallableThis(target.expression, callable)
    ) {
      installed.push(unwrapped(node.right));
    }
  }
  const written = writtenBy(node);
  if (written !== undefined && writesUnknownThisKey(written, callable, keys)) {
    return true;
  }
  return isDirectCallableThisReference(node, callable) && !isSafeDirectUse(node);
}

/** Updates `keys` for `written` targets on `callable`'s `this`; answers `true` for whole/dynamic writes. */
function writesUnknownThisKey(written: Node, callable: Node, keys: Set<string>): boolean {
  for (const rawTarget of targetsOf(written)) {
    const target = unwrapTarget(rawTarget);
    if (refersToCallableThisNode(target, callable)) {
      return true;
    }
    if (
      (isPropertyAccessExpression(target) || isElementAccessExpression(target)) &&
      refersToCallableThis(target.expression, callable)
    ) {
      const key = isPropertyAccessExpression(target) ? target.name.text : staticElementKey(target);
      if (key === undefined) {
        return true;
      }
      keys.add(key);
    }
  }
  return false;
}

/** Whether `node` directly evaluates to `callable`'s `this` binding or a lexical `const` alias of it. */
function isDirectCallableThisReference(node: Node, callable: Node): boolean {
  if (node.kind === SyntaxKind.ThisKeyword) {
    return isExpression(node) && enclosingThisBinder(node) === callable;
  }
  return (
    isIdentifier(node) &&
    !isDeclaredIdentifier(node) &&
    readsBinding(node) &&
    refersToCallableThis(node, callable)
  );
}

/** Narrowing wrapper around `refersToCallableThis` for arbitrary write target syntax nodes. */
function refersToCallableThisNode(node: Node, callable: Node): boolean {
  if (node.kind === SyntaxKind.ThisKeyword) {
    return enclosingThisBinder(node) === callable;
  }
  return isIdentifier(node) && refersToCallableThis(node, callable);
}

/** Whether `node` resolves to `callable`'s own `this` through lexical initializers. */
function refersToCallableThis(node: Expression, callable: Node): boolean {
  const seen = new Set<Expression>();
  let held = unwrapped(node);
  while (!seen.has(held)) {
    if (held.kind === SyntaxKind.ThisKeyword) {
      return enclosingThisBinder(held) === callable;
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

/** Nearest non-arrow `this`-binding syntax node enclosing `node`, if any. */
function enclosingThisBinder(node: Node): Node | undefined {
  for (
    let at: Node = node.parent, within: Node = node;
    !isSourceFile(at);
    within = at, at = at.parent
  ) {
    if (bindsOwnThis(at, within)) {
      return at;
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

/** Whether `at` is discarded or inspected without yielding an untracked reference. */
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
