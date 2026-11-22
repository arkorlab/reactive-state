import {
  type BindingElement,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isAsExpression,
  isBindingElement,
  isCallExpression,
  isDoStatement,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isNonNullExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isSourceFile,
  isSpreadElement,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableStatement,
  isVoidExpression,
  isWhileStatement,
  type Node,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, patternKey } from './code-globals.ts';
import { declarationOf } from './framed.ts';
import { readsOf } from './local-module-reads.ts';
import { isTypeOnly } from './scope.ts';

/** Mutable walk state while stepping through destructuring bindings and chosen defaults. */
export interface DefaultWalk {
  chosen: boolean;
  excluded: ReadonlySet<string> | undefined;
  offset: number;
  value: Expression | undefined;
}

/** Built-in calls that lock an object in place without changing its own entry values. */
const LOCKING_CALLS: ReadonlySet<string> = new Set([
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Reflect.preventExtensions',
]);

/** Binding projections in their evaluation order, including defaults at outer pattern levels. */
export function bindingSteps(name: Identifier): readonly BindingElement[] {
  const steps: BindingElement[] = [];
  for (let at: Node = name; !isVariableDeclaration(at); at = at.parent) {
    if (isBindingElement(at)) {
      steps.unshift(at);
    }
  }
  return steps;
}

/** Prepends and shifts every destructuring step of `name` onto `path` from innermost to outermost. */
export function prependBindingPath(name: Identifier, path: (string | undefined)[]): void {
  const steps = bindingSteps(name);
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step !== undefined) {
      prependBindingStep(step, path);
    }
  }
}

/** Applies one destructuring `BindingElement` backward onto `path`. */
function prependBindingStep(step: BindingElement, path: (string | undefined)[]): void {
  if (step.initializer !== undefined) {
    path.unshift(undefined);
    return;
  }
  if (step.dotDotDotToken === undefined) {
    path.unshift(patternName(step));
    return;
  }
  applyRestStep(step, path);
}

/** Shifts an array-rest index or rejects excluded object-rest keys at the front of `path`. */
function applyRestStep(step: BindingElement, path: (string | undefined)[]): void {
  const first = path[0];
  if (isArrayBindingPattern(step.parent)) {
    const restIndex = step.parent.elements.indexOf(step);
    if (first === undefined) {
      path.unshift(undefined);
    } else if (restIndex > 0) {
      path[0] = isNonNegativeIndex(first) ? String(Number(first) + restIndex) : undefined;
    }
    return;
  }
  const excluded = excludedObjectKeys(step);
  if (first === undefined || excluded === undefined || excluded.has(first)) {
    path.unshift(undefined);
  }
}

/** Records array-slice offsets or excluded object keys when `step` is a `...rest` binding element. */
export function advanceRestStep(
  step: BindingElement,
  current: Expression,
  walk: DefaultWalk,
): boolean {
  if (isArrayBindingPattern(step.parent)) {
    if (
      !isArrayLiteralExpression(current) ||
      current.elements.some((each) => isSpreadElement(each))
    ) {
      return false;
    }
    walk.offset += step.parent.elements.indexOf(step);
    walk.value = current;
    return true;
  }
  if (step.name === undefined || !isIdentifier(step.name) || !isObjectLiteralExpression(current)) {
    return false;
  }
  const excluded = excludedObjectKeys(step);
  if (excluded === undefined) {
    return false;
  }
  walk.excluded = excluded;
  walk.value = current;
  return true;
}

/** Shifts an array pattern step's index by any enclosing array-rest offset. */
export function shiftedStepKey(step: BindingElement, offset: number): string | undefined {
  const key = patternName(step);
  if (key === undefined || offset === 0) {
    return key;
  }
  return isNonNegativeIndex(key) ? String(Number(key) + offset) : undefined;
}

/** Validates and shifts `path` when `name` itself binds a rest container inside a chosen default. */
export function finalizeRestPath(
  name: Identifier,
  walk: DefaultWalk,
  path: readonly (string | undefined)[],
): readonly (string | undefined)[] | undefined {
  const rest = isBindingElement(name.parent) && name.parent.dotDotDotToken !== undefined;
  if (!rest) {
    return path;
  }
  const first = path[0];
  if (first === undefined) {
    return undefined;
  }
  if (walk.excluded !== undefined) {
    return walk.excluded.has(first) ? undefined : path;
  }
  if (walk.offset === 0) {
    return path;
  }
  return isNonNegativeIndex(first)
    ? [String(Number(first) + walk.offset), ...path.slice(1)]
    : undefined;
}

/** Whether `key` is a canonical non-negative safe integer index string. */
export function isNonNegativeIndex(key: string): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key;
}

/**
 * Resolves `read`'s initializer only when `read` names a same-function `const` binding in the same
 * loop scope whose only lexical reads are `read` itself, `void`, or discarded locking calls.
 */
export function unchangedLocalInitializer(
  read: Identifier,
  localOwner: Node | undefined,
  ownerOf: (node: Node) => Node | undefined,
): Expression | undefined {
  const declared = declarationOf(read);
  if (
    localOwner === undefined ||
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !validLocalDeclaration(declared, read, localOwner, ownerOf)
  ) {
    return undefined;
  }
  return isIdentifier(declared.name) && !hasUnsafeLocalRead(declared.name, read, localOwner)
    ? declared.initializer
    : undefined;
}

/** Whether `declared` is a pre-evaluated `const` identifier declaration in `localOwner`'s loop scope. */
function validLocalDeclaration(
  declared: VariableDeclaration,
  read: Identifier,
  localOwner: Node,
  ownerOf: (node: Node) => Node | undefined,
): boolean {
  return (
    isIdentifier(declared.name) &&
    declared.initializer !== undefined &&
    read.pos > declared.end &&
    ownerOf(declared) === localOwner &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile())) &&
    !crossesLoop(read, declared)
  );
}

/** Whether any loop body sits between `read` and the block or statement owning `declared`. */
function crossesLoop(read: Identifier, declared: VariableDeclaration): boolean {
  const statement = declared.parent.parent;
  const container: Node = isVariableStatement(statement) ? statement.parent : statement;
  for (let at: Node = read.parent; at !== container && !isSourceFile(at); at = at.parent) {
    if (
      isDoStatement(at) ||
      isForInStatement(at) ||
      isForOfStatement(at) ||
      isForStatement(at) ||
      isWhileStatement(at)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether `owner` contains any lexical read of `binding` other than `activeRead` and harmless locks. */
function hasUnsafeLocalRead(binding: Identifier, activeRead: Identifier, owner: Node): boolean {
  const isRead = readsOf(binding, binding.getSourceFile());
  let unsafe = false;
  const visit = (node: Node): void => {
    if (unsafe || isTypeOnly(node)) {
      return;
    }
    if (
      node !== binding &&
      isIdentifier(node) &&
      isRead(node) &&
      !safeLocalRead(node, activeRead)
    ) {
      unsafe = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(owner);
  return unsafe;
}

/** Whether `node` is `activeRead` itself, discarded via `void`, or passed to a discarded lock call. */
function safeLocalRead(node: Identifier, activeRead: Identifier): boolean {
  if (node === activeRead) {
    return true;
  }
  const top = topExpression(node);
  return isVoidExpression(top.parent) || isDiscardedLockCall(top);
}

/** Whether `argument` is the sole argument of a discarded `Object.freeze`/`seal`/`preventExtensions`. */
function isDiscardedLockCall(argument: Expression): boolean {
  const parent = argument.parent;
  if (
    !isCallExpression(parent) ||
    parent.arguments.length !== 1 ||
    parent.arguments[0] !== argument
  ) {
    return false;
  }
  const path = globalPathOf(unwrapped(parent.expression))?.join('.');
  if (path === undefined || !LOCKING_CALLS.has(path)) {
    return false;
  }
  const callTop = topExpression(parent);
  return isExpressionStatement(callTop.parent) || isVoidExpression(callTop.parent);
}

/** Walks up reference-preserving expression wrappers around `node`. */
function topExpression(node: Expression): Expression {
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

/** An object binding's written key or an array binding's position. */
function patternName(step: BindingElement): string | undefined {
  return isArrayBindingPattern(step.parent)
    ? String(step.parent.elements.indexOf(step))
    : patternKey(step);
}

/** Static sibling property keys excluded before `rest` in an object binding pattern. */
function excludedObjectKeys(rest: BindingElement): ReadonlySet<string> | undefined {
  if (!isObjectBindingPattern(rest.parent)) {
    return undefined;
  }
  const excluded = new Set<string>();
  for (const element of rest.parent.elements) {
    if (element === rest) {
      break;
    }
    const key = patternKey(element);
    if (key === undefined) {
      return undefined;
    }
    excluded.add(key);
  }
  return excluded;
}
