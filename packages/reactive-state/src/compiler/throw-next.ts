import {
  type Expression,
  isArrayBindingPattern,
  isBlock,
  isCallExpression,
  isForOfStatement,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import {
  consumedIteratorFunction,
  followedResolver,
  iteratorFunctionOf,
} from './throw-iteration.ts';
import { enumerationKey } from './throw-keys.ts';
import { writtenOf } from './throw-shapes.ts';

/** A source-written next function requested by actual synchronous iterator consumption. */
export function consumedNextFunction(node: Node, resolve: Resolve | undefined): Node | undefined {
  const obtained = readIterator(node, resolve)?.fn;
  const result = obtained === undefined ? undefined : returnedIterator(obtained);
  return result === undefined || merelyObtained(node, resolve)
    ? undefined
    : ownNext(result, resolve);
}

/** The written source and selected iterator method that an actual consumer obtains. */
export function readIterator(
  node: Node,
  resolve: Resolve | undefined,
): { readonly source: Expression; readonly fn: Node } | undefined {
  const source = consumedSource(node);
  if (source !== undefined) {
    const fn = iteratorFunctionOf(source, resolve);
    return fn === undefined ? undefined : { source, fn };
  }
  const invocation = consumedIteratorFunction(node, resolve);
  const argument =
    isCallExpression(node) || isNewExpression(node) ? node.arguments?.[0] : undefined;
  return invocation === undefined || argument === undefined
    ? undefined
    : { source: argument, fn: invocation.fn };
}

/** Iterator syntax requests a first step, except for an empty array binding. */
function consumedSource(node: Node): Expression | undefined {
  if (isSpreadElement(node)) {
    return node.expression;
  }
  if (isForOfStatement(node)) {
    return node.awaitModifier === undefined ? node.expression : undefined;
  }
  return isVariableDeclaration(node) && isArrayBindingPattern(node.name)
    ? node.initializer
    : undefined;
}

/** Iterator.from and an empty array binding obtain an iterator without requesting its first result. */
function merelyObtained(node: Node, resolve: Resolve | undefined): boolean {
  return (
    (isCallExpression(node) &&
      globalCalleePath(node.expression, followedResolver(node, resolve))?.join('.') ===
        'Iterator.from') ||
    (isVariableDeclaration(node) &&
      isArrayBindingPattern(node.name) &&
      node.name.elements.length === 0)
  );
}

/** An ordinary iterator method returning one literal result, with no intervening control flow. */
export function returnedIterator(fn: Node): ObjectLiteralExpression | undefined {
  if (
    !isAnswering(fn) ||
    isGetAccessorDeclaration(fn) ||
    answersLater(fn) ||
    fn.body === undefined
  ) {
    return undefined;
  }
  const body = fn.body;
  if (!isBlock(body)) {
    const result = unwrapped(body);
    return isObjectLiteralExpression(result) ? result : undefined;
  }
  const [statement] = body.statements;
  if (
    statement === undefined ||
    body.statements.length !== 1 ||
    !isReturnStatement(statement) ||
    statement.expression === undefined
  ) {
    return undefined;
  }
  const result = unwrapped(statement.expression);
  return isObjectLiteralExpression(result) ? result : undefined;
}

/** The surviving own next method; a spread, unknown key or accessor leaves its callable unproven. */
function ownNext(
  iterator: ObjectLiteralExpression,
  resolve: Resolve | undefined,
): Node | undefined {
  for (const property of iterator.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const key = enumerationKey(property.name, resolve);
    if (key === undefined) {
      return undefined;
    }
    if (key !== 'next') {
      continue;
    }
    if (isMethodDeclaration(property)) {
      return property;
    }
    if (isPropertyAssignment(property)) {
      return writtenOf(property.initializer, resolve);
    }
    return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
      ? writtenOf(property.name, resolve)
      : undefined;
  }
  return undefined;
}
