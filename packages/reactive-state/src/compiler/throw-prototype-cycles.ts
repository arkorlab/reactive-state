import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isComputedPropertyName,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableStatement,
  type Node,
} from 'typescript/ast';

import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { writtenOf } from './throw-shapes.ts';

/** Object's throwing prototype setter, unlike Reflect's false result for a rejected cycle. */
const SETTING = 'Object.setPrototypeOf';
const CREATING = 'Object.create';

/** A source-identity target already occurs in the unchanged prototype chain being installed. */
export function prototypeCycleThrows(
  given: readonly Expression[],
  outer: Resolve | undefined,
): boolean {
  const [target, prototype] = given;
  if (target === undefined || prototype === undefined) {
    return false;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const call = sourceCall(target);
  const value = writtenOf(target, resolve);
  if (
    call === undefined ||
    globalCalleePath(call.expression, resolve)?.join('.') !== SETTING ||
    (!isObjectLiteralExpression(value) && !isArrayLiteralExpression(value)) ||
    calleeUncertain(value, call) ||
    given.some((each) => !quietValue(each, resolve)) ||
    earlierExpressionEffect(call) ||
    priorEffect(call, resolve)
  ) {
    return false;
  }
  const seen = new Set<Expression>();
  let each: Expression | undefined = prototype;
  while (each !== undefined) {
    const held = writtenOf(each, resolve);
    if (seen.has(held) || calleeUncertain(held, call) || !quietValue(held, resolve)) {
      return false;
    }
    if (held === value) {
      return true;
    }
    seen.add(held);
    each = prototypeOf(held, resolve);
  }
  return false;
}

/** Only a literal prototype setter or the sole argument of native Object.create establishes a link. */
function prototypeOf(value: Expression, resolve: Resolve): Expression | undefined {
  if (isCallExpression(value)) {
    return value.arguments.length === 1 &&
      globalCalleePath(value.expression, resolve)?.join('.') === CREATING
      ? value.arguments[0]
      : undefined;
  }
  if (!isObjectLiteralExpression(value)) {
    return undefined;
  }
  for (const property of value.properties) {
    if (!isPropertyAssignment(property) || isComputedPropertyName(property.name)) {
      continue;
    }
    const { name } = property;
    if ((isIdentifier(name) || isStringLiteral(name)) && name.text === '__proto__') {
      return property.initializer;
    }
  }
  return undefined;
}

/** Literal creation and one-argument native Object.create cannot change the candidate chain. */
function quietValue(node: Expression, resolve: Resolve): boolean {
  const seen = new Set<Expression>();
  let value = writtenOf(node, resolve);
  while (isCallExpression(value)) {
    if (
      seen.has(value) ||
      value.arguments.length !== 1 ||
      globalCalleePath(value.expression, resolve)?.join('.') !== CREATING ||
      value.arguments[0] === undefined
    ) {
      return false;
    }
    seen.add(value);
    value = writtenOf(value.arguments[0], resolve);
  }
  return !callbackCreationEffect(value) && !containsSpread(value);
}

/** Spread creation can invoke an iterator or a getter that repairs a prototype or native method. */
function containsSpread(node: Node): boolean {
  const pending = [node];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isSpreadAssignment(each) || isSpreadElement(each)) {
      return true;
    }
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Earlier enclosing work may repair the prototype chain or replace Object.setPrototypeOf. */
function priorEffect(call: CallExpression, resolve: Resolve): boolean {
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some((statement) => {
        if (statement.end > each.pos) {
          return false;
        }
        return isVariableStatement(statement)
          ? statement.declarationList.declarations.some((declaration) => {
              return (
                declaration.initializer !== undefined &&
                !quietValue(declaration.initializer, resolve)
              );
            })
          : callbackCreationEffect(statement);
      })
    ) {
      return true;
    }
  }
  return false;
}

/** A written argument retains the original invocation in its source ancestors. */
function sourceCall(node: Node): CallExpression | undefined {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (isCallExpression(each)) {
      return each;
    }
  }
  return undefined;
}
