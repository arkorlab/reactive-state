import {
  type ArrayBindingPattern,
  isArrayBindingPattern,
  isBindingElement,
  isBlock,
  isComputedPropertyName,
  isConstructorDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { enumerationKey } from './throw-keys.ts';
import { readIterator, returnedIterator } from './throw-next.ts';
import { writtenOf } from './throw-shapes.ts';

/** The source-written return method or getter that finite destructuring necessarily invokes. */
export function iteratorCloseFunction(node: Node, resolve: Resolve | undefined): Node | undefined {
  if (
    !isVariableDeclaration(node) ||
    !isArrayBindingPattern(node.name) ||
    !simplePattern(node.name) ||
    earlierExpressionEffect(node) ||
    priorEffect(node)
  ) {
    return undefined;
  }
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const read = readIterator(node, follow);
  if (read === undefined || !isAnswering(read.fn) || parametersOf(read.fn).length > 0) {
    return undefined;
  }
  const source = writtenOf(read.source, follow);
  const iterator = returnedIterator(read.fn);
  if (
    iterator === undefined ||
    !quietObject(source, follow) ||
    !quietObject(iterator, follow) ||
    (node.name.elements.length > 0 && !remainsOpen(iterator, follow))
  ) {
    return undefined;
  }
  const next = ownFunction(iterator, 'next', follow);
  if (next !== undefined && isGetAccessorDeclaration(next)) {
    return undefined;
  }
  return ownFunction(iterator, 'return', follow);
}

/** Identifier and omitted elements cannot run defaults, nested patterns or exhaustion work. */
function simplePattern(pattern: ArrayBindingPattern): boolean {
  return pattern.elements.every((element) => {
    return (
      isOmittedExpression(element) ||
      (isBindingElement(element) &&
        (element.name === undefined || isIdentifier(element.name)) &&
        element.initializer === undefined &&
        element.dotDotDotToken === undefined)
    );
  });
}

/** A pure next method returns an own false done entry on every requested step. */
function remainsOpen(iterator: ObjectLiteralExpression, resolve: Resolve): boolean {
  const next = ownFunction(iterator, 'next', resolve);
  if (next === undefined || !isAnswering(next) || parametersOf(next).length > 0) {
    return false;
  }
  const result = returnedIterator(next);
  if (result === undefined || !quietObject(result, resolve)) {
    return false;
  }
  let open = false;
  let valueGetter = false;
  for (const property of result.properties) {
    if (isSpreadAssignment(property)) {
      return false;
    }
    const key = enumerationKey(property.name, resolve);
    if (key === undefined || key === '__proto__') {
      return false;
    }
    if (key === 'done') {
      open =
        isPropertyAssignment(property) &&
        unwrapped(property.initializer).kind === SyntaxKind.FalseKeyword;
    } else if (key === 'value' && !isSetAccessorDeclaration(property)) {
      valueGetter = isGetAccessorDeclaration(property);
    }
  }
  return open && !valueGetter;
}

/** A final own callable or getter, preserving accessor pairs and rejecting uncertain overwrites. */
function ownFunction(
  iterator: ObjectLiteralExpression,
  name: string,
  resolve: Resolve,
): Node | undefined {
  let setter = false;
  for (const property of iterator.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const key = enumerationKey(property.name, resolve);
    if (key === undefined) {
      return undefined;
    }
    if (key !== name) {
      continue;
    }
    if (isSetAccessorDeclaration(property)) {
      setter = true;
      continue;
    }
    if (isGetAccessorDeclaration(property)) {
      return property;
    }
    if (setter) {
      return undefined;
    }
    return dataFunction(property, resolve);
  }
  return undefined;
}

/** A method declaration or the function stored by an own data entry. */
function dataFunction(property: ObjectLiteralElementLike, resolve: Resolve): Node | undefined {
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

/** Creating the source, iterator and step objects cannot repair a selected close method. */
function quietObject(node: Node, resolve: Resolve): node is ObjectLiteralExpression {
  if (!isObjectLiteralExpression(node)) {
    return false;
  }
  for (const property of node.properties) {
    if (isSpreadAssignment(property)) {
      return false;
    }
    const key = enumerationKey(property.name, resolve);
    if (key === undefined || key === '__proto__') {
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

/** Prior application work leaves source and intrinsic selections unproven. */
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
