import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isIdentifier,
  isNonNullExpression,
  isNewExpression,
  isPropertyAccessExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  type Node,
  type NonNullExpression,
  type PropertyAccessExpression,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { invocationThrows, nullishCallee } from './throw-callability.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** A read or call in a chain, before any parentheses that end optional short-circuiting. */
type Link = CallExpression | ElementAccessExpression | NonNullExpression | PropertyAccessExpression;

/** A source-proven throwing property read, call or construction. */
export function dereferenceThrows(node: Node, resolve: Resolve | undefined): boolean {
  return (
    strictArgumentsRead(node, resolve) ||
    nullishDereference(node, resolve) ||
    invocationThrows(node, resolve)
  );
}

/** The strict arguments object's non-configurable callee getter always throws when read. */
export function strictArgumentsRead(node: Node, resolve: Resolve | undefined): boolean {
  if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) {
    return false;
  }
  const follow: Resolve = (name) =>
    name.text === 'arguments' ? undefined : (resolve?.(name) ?? metadataInitializer(name));
  const key = isPropertyAccessExpression(node)
    ? node.name.text
    : literalKey(writtenOf(node.argumentExpression, follow));
  const value = writtenOf(node.expression, follow);
  if (key !== 'callee' || !isIdentifier(value) || value.text !== 'arguments') {
    return false;
  }
  for (let at: Node = value.parent; !isSourceFile(at); at = at.parent) {
    if (
      (isAnswering(at) && !isArrowFunction(at)) ||
      isConstructorDeclaration(at) ||
      isSetAccessorDeclaration(at)
    ) {
      return true;
    }
  }
  return false;
}

/** A read or invocation dereferencing a source-proven null or undefined value. */
function nullishDereference(node: Node, resolve: Resolve | undefined): boolean {
  if (isNewExpression(node)) {
    return isNullish(node.expression, resolve, new Set());
  }
  return (
    (isPropertyAccessExpression(node) ||
      isElementAccessExpression(node) ||
      isCallExpression(node)) &&
    node.questionDotToken === undefined &&
    isNullish(node.expression, resolve, new Set())
  );
}

/**
 * The receiver evaluated by a chain whose later keys and arguments are skipped because an optional
 * link already short-circuits on a known nullish value; none of a chain that still evaluates them.
 */
export function shortedReceiver(node: Node, resolve: Resolve | undefined): Expression | undefined {
  return isLink(node) && shortCircuits(node, resolve, new Set()) ? node.expression : undefined;
}

/** Whether a chain already short-circuits, following its raw syntax until parentheses end it. */
function shortCircuits(node: Link, resolve: Resolve | undefined, seen: Set<Expression>): boolean {
  let each: Expression = node;
  while (isLink(each)) {
    if (
      !isNonNullExpression(each) &&
      each.questionDotToken !== undefined &&
      isNullish(each.expression, resolve, seen)
    ) {
      return true;
    }
    each = each.expression;
  }
  return false;
}

/** Whether an expression necessarily answers null or undefined, without running the application. */
function isNullish(node: Expression, resolve: Resolve | undefined, seen: Set<Expression>): boolean {
  let current = node;
  let visited = seen;
  for (;;) {
    if (nullishCallee(current, resolve)) {
      return true;
    }
    const value = writtenOf(current, resolve);
    if (visited.has(value)) {
      return false;
    }
    if (primitiveOf(value, resolve) === 'nothing' || globalPath(value)?.join('.') === 'undefined') {
      return true;
    }
    const following = new Set([...visited, value]);
    if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken) {
      current = value.right;
      visited = following;
      continue;
    }
    if (isConditionalExpression(value)) {
      return (
        isNullish(value.whenTrue, resolve, new Set(following)) &&
        isNullish(value.whenFalse, resolve, new Set(following))
      );
    }
    return isLink(value) && shortCircuits(value, resolve, following);
  }
}

/** Whether a node reads, calls or asserts a value in the same syntactic chain. */
function isLink(node: Node): node is Link {
  return (
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node) ||
    isCallExpression(node) ||
    isNonNullExpression(node)
  );
}
