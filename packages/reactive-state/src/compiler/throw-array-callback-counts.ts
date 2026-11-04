import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassExpression,
  isConditionalExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
  isSourceFile,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { calledMember, unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { freeReads } from './scope.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** The array searches that visit holes as undefined values. */
const VISITS_HOLES: ReadonlySet<string> = new Set([
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
]);

const COMPARING: ReadonlySet<string> = new Set(['sort', 'toSorted']);

/** The source-written entries for which a native array method necessarily invokes its callback. */
export function arrayCallbackCount(
  receiver: Expression,
  method: string,
  resolve: Resolve | undefined,
): number {
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const array = writtenOf(receiver, follow);
  if (
    !isArrayLiteralExpression(array) ||
    calleeUncertain(array, receiver) ||
    !quietArguments(receiver, method)
  ) {
    return 0;
  }
  return array.elements.filter((each) => {
    if (isSpreadElement(each) || (!VISITS_HOLES.has(method) && isOmittedExpression(each))) {
      return false;
    }
    return !COMPARING.has(method) || comparedValue(each, follow);
  }).length;
}

/** Sort never calls its comparator for undefined; an unknown entry proves no defined value. */
function comparedValue(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  const primitive = primitiveOf(value, resolve);
  return (
    (primitive !== undefined && primitive !== 'nothing') ||
    value.kind === SyntaxKind.NullKeyword ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isNewExpression(value) ||
    guardedValue(node, resolve)
  );
}

/** A quiet strict-equality arm can establish a bare binding's defined value at this execution. */
function guardedValue(node: Expression, resolve: Resolve): boolean {
  const value = unwrapped(node);
  if (
    !isIdentifier(value) ||
    callbackCreationEffect(node.parent) ||
    earlierExpressionEffect(node)
  ) {
    return false;
  }
  for (let each: Node = node; !isSourceFile(each); each = each.parent) {
    if (isAnswering(each) || isBlock(each)) {
      return false;
    }
    const { parent } = each;
    if (
      isConditionalExpression(parent) &&
      parent.whenTrue === each &&
      equalToDefined(parent.condition, value, resolve) &&
      freeReads(each).includes(value)
    ) {
      return true;
    }
  }
  return false;
}

/** Strict equality performs no application conversion of a primitive on either side. */
function equalToDefined(condition: Expression, read: Expression, resolve: Resolve): boolean {
  const value = unwrapped(condition);
  if (
    !isBinaryExpression(value) ||
    value.operatorToken.kind !== SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return false;
  }
  return (
    namedDefined(value.left, value.right, read, resolve) ||
    namedDefined(value.right, value.left, read, resolve)
  );
}

/** A free branch read has the tested name and a quiet, source-written defined primitive. */
function namedDefined(
  name: Expression,
  other: Expression,
  read: Expression,
  resolve: Resolve,
): boolean {
  const identifier = unwrapped(name);
  if (
    !isIdentifier(identifier) ||
    !isIdentifier(read) ||
    identifier.text !== read.text ||
    callbackCreationEffect(other)
  ) {
    return false;
  }
  const value = writtenOf(other, resolve);
  const primitive = primitiveOf(value, resolve);
  return (
    (primitive !== undefined && primitive !== 'nothing') || value.kind === SyntaxKind.NullKeyword
  );
}

/** Native length is read after every argument, whose evaluation may change the selected receiver. */
function quietArguments(receiver: Expression, method: string): boolean {
  for (let node: Node = receiver.parent; !isSourceFile(node); node = node.parent) {
    if (isCallExpression(node)) {
      const member = calledMember(unwrapped(node.expression));
      return (
        member?.of === receiver &&
        member.name === method &&
        node.arguments.every(
          (argument) => !isSpreadElement(argument) && !callbackCreationEffect(argument),
        )
      );
    }
  }
  return false;
}
