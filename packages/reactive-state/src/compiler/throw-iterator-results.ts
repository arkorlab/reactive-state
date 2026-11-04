import {
  isBlock,
  isComputedPropertyName,
  isConstructorDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { isAnswering, parametersOf } from './answers.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { callbackResultThrows } from './throw-callback-results.ts';
import { globalCalleePath } from './throw-callees.ts';
import { consumedNextFunction, readIterator, returnedIterator } from './throw-next.ts';
import { writtenOf } from './throw-shapes.ts';

/** A selected synchronous iterator or requested next result that is written as a primitive. */
export function iteratorResultThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (earlierExpressionEffect(node) || priorEffect(node)) {
    return false;
  }
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const read = readIterator(node, follow);
  if (read === undefined || !quietSource(writtenOf(read.source, follow), follow)) {
    return false;
  }
  const { fn } = read;
  if (!isAnswering(fn) || isGetAccessorDeclaration(fn)) {
    return false;
  }
  if (callbackResultThrows(fn, 'object', undefined)) {
    return true;
  }
  const iterator = returnedIterator(fn);
  if (
    iterator === undefined ||
    !quietSource(iterator, follow) ||
    parametersOf(fn).some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  ) {
    return false;
  }
  const next = consumedNextFunction(node, follow);
  return (
    next !== undefined &&
    isAnswering(next) &&
    !isGetAccessorDeclaration(next) &&
    callbackResultThrows(next, 'object', undefined)
  );
}

/** Source construction skips method bodies but must not repair intrinsic names before consumption. */
function quietSource(node: Node, resolve: Resolve): node is ObjectLiteralExpression {
  if (!isObjectLiteralExpression(node)) {
    return false;
  }
  for (const property of node.properties) {
    if (isSpreadAssignment(property)) {
      return false;
    }
    if (
      isComputedPropertyName(property.name) &&
      globalCalleePath(property.name.expression, resolve)?.join('.') !== 'Symbol.iterator' &&
      callbackCreationEffect(property.name.expression)
    ) {
      return false;
    }
    if (isPropertyAssignment(property) && callbackCreationEffect(property.initializer)) {
      return false;
    }
  }
  return true;
}

/** Prior application work leaves native names or selected source results unproven. */
function priorEffect(node: Node): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return true;
    }
    if (isAnswering(parent) || isConstructorDeclaration(parent)) {
      break;
    }
  }
  return false;
}
