import {
  type CallExpression,
  type Expression,
  type GetAccessorDeclaration,
  type MethodDeclaration,
  type ObjectLiteralExpression,
  isArrayLiteralExpression,
  isCallExpression,
  isClassExpression,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  type Node,
} from 'typescript/ast';

import { calledMember } from './bounded.ts';
import { callbackCreationEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { quietNativeCall } from './throw-construct-only.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

interface LocaleMember {
  readonly target: Node;
  readonly invalid: boolean;
}

/** The first necessarily invoked own element locale method; earlier unknown work stays opaque. */
function localeMember(call: CallExpression, outer: Resolve | undefined): LocaleMember | undefined {
  const member = calledMember(call.expression);
  if (member?.name !== 'toLocaleString') {
    return undefined;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const value = writtenOf(member.of, resolve);
  if (
    !isArrayLiteralExpression(value) ||
    callbackCreationEffect(value) ||
    calleeUncertain(value, call) ||
    !quietNativeCall(call, 'Array.prototype.toLocaleString', resolve)
  ) {
    return undefined;
  }
  for (const element of value.elements) {
    if (isOmittedExpression(element)) {
      continue;
    }
    const item = writtenOf(element, resolve);
    if (primitiveOf(item, resolve) === 'nothing') {
      continue;
    }
    if (!isObjectLiteralExpression(item)) {
      return undefined;
    }
    const target = selectedLocale(item, resolve);
    return target === undefined ? undefined : { target, invalid: invalidLocale(target, resolve) };
  }
  return undefined;
}

type LocaleTarget = Expression | MethodDeclaration | GetAccessorDeclaration;

/** The final ordinary own member, without executing accessors, spreads or computed property keys. */
function selectedLocale(item: ObjectLiteralExpression, resolve: Resolve): LocaleTarget | undefined {
  let target: LocaleTarget | undefined;
  for (const property of item.properties) {
    if (isSpreadAssignment(property) || isComputedPropertyName(property.name)) {
      return undefined;
    }
    const { name } = property;
    if (!(isIdentifier(name) || isStringLiteral(name)) || name.text === '__proto__') {
      return undefined;
    }
    if (name.text !== 'toLocaleString') {
      continue;
    }
    if (isMethodDeclaration(property) || isGetAccessorDeclaration(property)) {
      target = property;
    } else if (isPropertyAssignment(property)) {
      target = writtenOf(property.initializer, resolve);
    } else {
      return undefined;
    }
  }
  return target;
}

/** A primitive, ordinary literal or class cannot perform the element's ordinary method call. */
function invalidLocale(target: LocaleTarget, resolve: Resolve): boolean {
  if (isMethodDeclaration(target) || isGetAccessorDeclaration(target)) {
    return false;
  }
  return (
    isClassExpression(target) ||
    isArrayLiteralExpression(target) ||
    isObjectLiteralExpression(target) ||
    primitiveOf(target, resolve) !== undefined
  );
}

/** A source-written array element cannot supply a callable locale method. */
export function arrayLocaleThrows(call: CallExpression, resolve: Resolve | undefined): boolean {
  return localeMember(call, resolve)?.invalid === true;
}

/** A selected locale getter or method whose synchronous source body can be checked by the caller. */
export function arrayLocaleFunction(node: Node, resolve: Resolve | undefined): Node | undefined {
  return isCallExpression(node) ? localeMember(node, resolve)?.target : undefined;
}
