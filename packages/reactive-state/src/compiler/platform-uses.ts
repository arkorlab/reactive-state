import {
  type CallExpression,
  type Expression,
  type Identifier,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableStatement,
  isVoidExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { declarationOf } from './framed.ts';
import { metadataCallee } from './input-callees.ts';
import { isTypeOnly, withinFunction } from './scope.ts';

/** Platform constructors that read input options without storing or returning an alias to them. */
const SAFE_PLATFORM_NEW: ReadonlySet<string> = new Set([
  'Blob',
  'CustomEvent',
  'Event',
  'File',
  'FormData',
  'Headers',
  'Request',
  'Response',
  'URL',
  'URLSearchParams',
]);

/** Built-in calls that neither mutate an argument object nor return a mutable alias to it. */
const SAFE_PLATFORM_CALL: ReadonlySet<string> = new Set([
  'Boolean',
  'Object.hasOwn',
  'Object.is',
  'Reflect.has',
  'Response.redirect',
]);

/** Equality operators that compare identity without coercing or retaining an object reference. */
const EQUALITY_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** Source ranges of nodes in one syntax tree preserve ancestry for the loop's work. */
export function contains(outer: Node, inner: Node): boolean {
  return (
    outer.getSourceFile() === inner.getSourceFile() &&
    outer.pos <= inner.pos &&
    inner.end <= outer.end
  );
}

/** Whether `node` executes during `owner`'s own top-down evaluation rather than a later call. */
export function runsInOwner(node: Node, owner: Node): boolean {
  if (node === owner || !contains(owner, node)) {
    return false;
  }
  for (let child = node; child.parent !== owner; child = child.parent) {
    if (defersEvaluation(child.parent, child)) {
      return false;
    }
  }
  return true;
}

/** Whether `parent` defers evaluating `child` until a separate call or construction runs. */
function defersEvaluation(parent: Node, child: Node): boolean {
  if (isFunctionLikeDeclaration(parent)) {
    return parent.name !== child;
  }
  return (
    isPropertyDeclaration(parent) &&
    parent.initializer === child &&
    parent.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) !== true
  );
}

/** A nested source body reads captured inputs when its known direct callers execute. */
export function readPoints(before: Node, owner: Node): readonly Node[] | undefined {
  if (!contains(owner, before)) {
    return undefined;
  }
  for (let child = before; child !== owner && !isSourceFile(child); child = child.parent) {
    const fn = child.parent;
    const body: Node | undefined = isAnswering(fn) ? fn.body : undefined;
    if (fn !== owner && body === child && isAnswering(fn)) {
      return invocationPoints(fn, owner);
    }
  }
  return [before];
}

/** Immediate calls and unchanged lexical callable bindings, without following callbacks or escapes. */
function invocationPoints(fn: Answering, owner: Node): readonly Node[] | undefined {
  let value: Node = fn;
  while (wrappedBy(value.parent)) {
    value = value.parent;
  }
  const immediate = directCall(value, owner);
  if (immediate !== undefined) {
    return answersLater(fn) ? undefined : [immediate];
  }
  const declaration = isVariableDeclaration(value.parent) ? value.parent : fn;
  if (!isVariableDeclaration(declaration) && !isFunctionDeclaration(declaration)) {
    return undefined;
  }
  const { name } = declaration;
  if (name === undefined || !isIdentifier(name)) {
    return undefined;
  }
  const state = { points: [] as Node[], unknown: false };
  const visit = (node: Node): void => {
    if (state.unknown || isTypeOnly(node)) {
      return;
    }
    if (node !== name && isIdentifier(node) && declarationOf(node) === declaration) {
      const call = directCall(node, owner);
      if (call === undefined || sourceFunction(call.expression) !== fn || answersLater(fn)) {
        state.unknown = true;
      } else {
        state.points.push(call);
      }
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  return state.unknown ? undefined : state.points;
}

/** A direct invocation in the binding owner's execution, excluding deferred caller bodies. */
function directCall(node: Node, owner: Node): CallExpression | NewExpression | undefined {
  let value = node;
  while (wrappedBy(value.parent)) {
    value = value.parent;
  }
  const call = value.parent;
  return (isCallExpression(call) || isNewExpression(call)) &&
    call.expression === value &&
    !withinFunction(call, owner)
    ? call
    : undefined;
}

/** A binding or mutable member assignment, including destructuring targets. */
export function bindsTarget(
  node: Node,
  isRead: (node: Node) => node is Identifier,
  mutable: boolean,
): boolean {
  let target = node;
  for (;;) {
    if (wrappedBy(target)) {
      target = (target as Expression & { readonly expression: Expression }).expression;
    } else if (isPropertyAssignment(target)) {
      target = target.initializer;
    } else if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      if (!mutable) {
        return false;
      }
      target = target.expression;
    } else {
      break;
    }
  }
  if (isIdentifier(target)) {
    return isRead(target);
  }
  if (isShorthandPropertyAssignment(target)) {
    return isRead(target.name);
  }
  return (
    target.forEachChild((child) => (bindsTarget(child, isRead, mutable) ? true : undefined)) ===
    true
  );
}

/** Whether `parent` inspects `node` without storing, returning, or invoking methods on it. */
export function isPassiveUse(
  node: Expression,
  parent: Node,
  held: Expression | undefined,
): boolean {
  if (isSpreadAssignment(parent) && parent.expression === node) {
    return hasNoGetter(held);
  }
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === node
  ) {
    return plainRead(parent, held);
  }
  if (isVoidExpression(parent) || isTypeOfExpression(parent)) {
    return true;
  }
  if (isPrefixUnaryExpression(parent) && parent.operator === SyntaxKind.ExclamationToken) {
    return true;
  }
  if (isConditionalExpression(parent) && parent.condition === node) {
    return true;
  }
  return isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind);
}

/** Whether reading a member path on `access` neither runs a getter nor invokes a method. */
function plainRead(access: Expression, held: Expression | undefined): boolean {
  if (!hasNoGetter(held)) {
    return false;
  }
  let current: Expression = access;
  for (;;) {
    const next = current.parent;
    if (
      wrappedBy(next) ||
      ((isPropertyAccessExpression(next) || isElementAccessExpression(next)) &&
        next.expression === current)
    ) {
      current = next as Expression;
    } else {
      break;
    }
  }
  const outer = current.parent;
  return !((isCallExpression(outer) || isNewExpression(outer)) && outer.expression === current);
}

/** Whether an initializer literal carries no getter that could run during property reads. */
function hasNoGetter(held: Expression | undefined): boolean {
  if (held === undefined) {
    return true;
  }
  const value = unwrapped(held);
  return (
    !isObjectLiteralExpression(value) ||
    !value.properties.some((each) => isGetAccessorDeclaration(each))
  );
}

/** Whether a global platform constructor or built-in call neither mutates nor aliases `held`. */
export function safePlatformCall(
  call: CallExpression | NewExpression,
  path: string,
  held: Expression | undefined,
): boolean {
  return isNewExpression(call)
    ? SAFE_PLATFORM_NEW.has(path) && hasNoGetter(held)
    : SAFE_PLATFORM_CALL.has(path);
}

/** Whether a variable binding is directly exported from its enclosing statement. */
export function isExportedVariable(name: Identifier): boolean {
  const declaration = name.parent;
  if (!isVariableDeclaration(declaration)) {
    return false;
  }
  const statement = declaration.parent.parent;
  return (
    isVariableStatement(statement) &&
    statement.modifiers?.some((each) => each.kind === SyntaxKind.ExportKeyword) === true
  );
}

/** A source-backed local callable, without assuming what an unknown or imported callback does. */
export function sourceFunction(callee: Expression): Answering | undefined {
  const fn = metadataCallee(callee);
  return fn !== undefined && isAnswering(fn) ? fn : undefined;
}

/** Wrappers that preserve a reference's identity. */
export function wrappedBy(node: Node): boolean {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node)
  );
}

/** Identifier spellings appearing anywhere within a write target expression or pattern. */
export function targetNames(target: Node): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    if (isIdentifier(node)) {
      names.add(node.text);
    }
    node.forEachChild(visit);
  };
  visit(target);
  return names;
}
