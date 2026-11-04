import {
  type Expression,
  type GetAccessorDeclaration,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { borrowedCall } from './borrowed-calls.ts';
import { calledMember } from './bounded.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { conversionRunsCode } from './throw-coercions.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { writtenBy } from './written.ts';

/** The final own tag getter the native Object.prototype.toString call synchronously reads. */
export function objectTagGetter(
  node: Node,
  outer: Resolve | undefined,
): GetAccessorDeclaration | undefined {
  if (!isCallExpression(node) || node.arguments.some((each) => isSpreadElement(each))) {
    return undefined;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const borrowed = borrowedCall(node, resolve);
  const member = borrowed === undefined ? undefined : calledMember(borrowed.call.expression);
  if (
    borrowed?.brand !== 'Object' ||
    member?.name !== 'toString' ||
    earlierEffect(node, resolve) ||
    !quietArguments(node.arguments, resolve) ||
    borrowed.call.arguments.some((each) => creationEffect(each, resolve))
  ) {
    return undefined;
  }
  const object = writtenOf(member.of, resolve);
  if (
    !isObjectLiteralExpression(object) ||
    creationEffect(object, resolve) ||
    calleeUncertain(object, node)
  ) {
    return undefined;
  }
  return tagGetter(object, resolve);
}

/** Even apply's ignored extra arguments are evaluated before the native receiver tag is read. */
function quietArguments(given: readonly Expression[], resolve: Resolve): boolean {
  return given.every((argument) => {
    const value = writtenOf(argument, resolve);
    return (
      globalCalleePath(value, resolve)?.join('.') === 'Object.prototype.toString' ||
      !creationEffect(value, resolve)
    );
  });
}

/** Paired setters preserve a getter, while data entries and methods replace it. */
function tagGetter(
  object: ObjectLiteralExpression,
  resolve: Resolve,
): GetAccessorDeclaration | undefined {
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property) || prototypeEntry(property)) {
      return undefined;
    }
    const key = tagKey(property.name, resolve);
    if (key === undefined) {
      return undefined;
    }
    if (!key || isSetAccessorDeclaration(property)) {
      continue;
    }
    return isGetAccessorDeclaration(property) ? property : undefined;
  }
  return undefined;
}

/** A source-written prototype or unknown spread leaves the native receiver unproven. */
function prototypeEntry(property: Node): boolean {
  return (
    isPropertyAssignment(property) &&
    (isIdentifier(property.name) || isStringLiteral(property.name)) &&
    property.name.text === '__proto__'
  );
}

/** Only the well-known symbol selects the tag; other primitive names cannot overwrite it. */
function tagKey(name: PropertyName, resolve: Resolve): boolean | undefined {
  if (!isComputedPropertyName(name)) {
    return false;
  }
  const value = writtenOf(name.expression, resolve);
  if (globalCalleePath(value, resolve)?.join('.') === 'Symbol.toStringTag') {
    return true;
  }
  return isSymbolWritten(value, resolve) || primitiveOf(value, resolve) !== undefined
    ? false
    : undefined;
}

/** Preceding evaluation may change the native callable or the selected descriptor. */
function earlierEffect(node: Node, resolve: Resolve): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const status = { effect: false };
    each.parent.forEachChild((part) => {
      if (part.end <= each.pos && creationEffect(part, resolve)) {
        status.effect = true;
      }
    });
    if (status.effect) {
      return true;
    }
  }
  return false;
}

/** Accessor bodies defer, but argument calls, writes, reads and key conversions execute now. */
function creationEffect(node: Node, resolve: Resolve): boolean {
  const pending = [node];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isAnswering(each) || isSetAccessorDeclaration(each)) {
      const key = computedName(each);
      if (key !== undefined) {
        pending.push(key);
      }
      continue;
    }
    if (
      isCallExpression(each) ||
      isNewExpression(each) ||
      isSpreadAssignment(each) ||
      isTaggedTemplateExpression(each) ||
      isClassDeclaration(each) ||
      isClassExpression(each) ||
      writtenBy(each) !== undefined ||
      conversionRunsCode(each) ||
      ((isPropertyAccessExpression(each) || isElementAccessExpression(each)) &&
        !isSymbolWritten(each, resolve)) ||
      (isComputedPropertyName(each) && tagKey(each, resolve) === undefined)
    ) {
      return true;
    }
    if (!isPropertyAccessExpression(each) && !isElementAccessExpression(each)) {
      each.forEachChild((child) => {
        pending.push(child);
      });
    }
  }
  return false;
}

/** Only a method or accessor's computed name executes when the literal is created. */
function computedName(node: Node): PropertyName | undefined {
  return (isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)) &&
    isComputedPropertyName(node.name)
    ? node.name
    : undefined;
}
