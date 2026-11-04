import {
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isObjectLiteralExpression,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { callbackResultThrows } from './throw-callback-results.ts';
import { globalCalleePath } from './throw-callees.ts';
import { enumerationKey } from './throw-keys.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** A synchronous root replacer's written bigint that JSON serialization cannot write. */
export function jsonReplacerResultThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (
    !isCallExpression(node) ||
    node.arguments.some((argument) => isSpreadElement(argument)) ||
    earlierEffect(node) ||
    earlierExpressionEffect(node)
  ) {
    return false;
  }
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const [root, replacer] = node.arguments;
  if (
    root === undefined ||
    replacer === undefined ||
    globalCalleePath(node.expression, follow)?.join('.') !== 'JSON.stringify' ||
    node.arguments.some((argument) => callbackCreationEffect(argument))
  ) {
    return false;
  }
  const value = writtenOf(root, follow);
  const fn = writtenOf(replacer, follow);
  if (
    !isAnswering(fn) ||
    calleeUncertain(fn, node.expression) ||
    calleeUncertain(value, node) ||
    !quietRoot(value, follow)
  ) {
    return false;
  }
  // An imported callback never reads the caller's formal parameters or lexical constants.
  return callbackResultThrows(
    fn,
    'json',
    fn.getSourceFile() === node.getSourceFile() ? follow : undefined,
  );
}

/** Root toJSON hooks run before the replacer and can change operations used by its result. */
function quietRoot(node: Expression, resolve: Resolve): boolean {
  if (callbackCreationEffect(node)) {
    return false;
  }
  if (isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (isSpreadAssignment(property)) {
        return false;
      }
      const key = enumerationKey(property.name, resolve);
      return key !== undefined && key !== 'toJSON';
    });
  }
  return isArrayLiteralExpression(node) || primitiveOf(node, resolve) !== undefined;
}

/** Earlier application work can change the native function or a callback's primitive maker. */
function earlierEffect(node: Node): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (
      isBlock(each.parent) &&
      each.parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return true;
    }
    if (isAnswering(each.parent) || isConstructorDeclaration(each.parent)) {
      break;
    }
  }
  return false;
}
