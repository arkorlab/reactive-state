import {
  type Expression,
  isArrowFunction,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater, isAnswering } from './answers.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import { isCalledValue } from './method-calls.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { isTypedKind, primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** Source-written iterator methods and accessors synchronously invoked by native consumers. */

/** Whether an iterator's source function is merely obtained or its generator result is exhausted. */
export interface IteratorInvocation {
  readonly fn: Node;
  readonly resumes: boolean;
  readonly invalid?: boolean;
}

/** Constructors that obtain an iterator from their sole argument. */
const COLLECTIONS: ReadonlySet<string> = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

/** Functions that obtain an iterator before producing their result. */
const CONSUMERS: ReadonlySet<string> = new Set([
  'Array.from',
  'Iterator.from',
  'Object.fromEntries',
]);

/** The own iterator member a native call reads, its callability and whether its result is consumed. */
export function consumedIteratorFunction(
  node: Node,
  resolve: Resolve | undefined,
): IteratorInvocation | undefined {
  if (!isCallExpression(node) && !isNewExpression(node)) {
    return undefined;
  }
  const follow: Resolve = (name) => {
    const held = resolve?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, node) ? undefined : held;
  };
  const names = globalCalleePath(node.expression, follow) ?? [];
  const path = names.join('.');
  const typedFactory = names.length === 2 && names[1] === 'from' && isTypedKind(names[0] ?? '');
  if (typedFactory && (earlierExpressionEffect(node) || priorEffect(node))) {
    return undefined;
  }
  const consumes = isNewExpression(node)
    ? COLLECTIONS.has(path)
    : CONSUMERS.has(path) || typedFactory;
  const given = node.arguments ?? [];
  const [source] = given;
  if (!consumes || source === undefined || !quietArguments(given, node)) {
    return undefined;
  }
  const fn = iteratorFunctionOf(source, resolve);
  return fn === undefined
    ? undefined
    : {
        fn,
        invalid: nonCallableIterator(fn, source, node, resolve),
        resumes: path !== 'Iterator.from' && synchronousGenerator(fn),
      };
}

/** Later argument evaluation preserves the selected native consumer and its iterator. */
function quietArguments(given: readonly Expression[], call: Node): boolean {
  if (
    given.some((each) => isSpreadElement(each)) ||
    given.slice(1).some((each) => callbackCreationEffect(each))
  ) {
    return false;
  }
  return given.length === 1 || (!earlierExpressionEffect(call) && !priorEffect(call));
}

/** GetMethod refuses a written non-nullish data value before attempting iterator invocation. */
function nonCallableIterator(
  fn: Node,
  source: Expression,
  at: Expression,
  resolve: Resolve | undefined,
): boolean {
  if (!isExpression(fn) || earlierExpressionEffect(at) || priorEffect(at)) {
    return false;
  }
  const value = writtenOf(source, resolve);
  if (!isObjectLiteralExpression(value) || calleeUncertain(value, at)) {
    return false;
  }
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      return false;
    }
    if (
      (isComputedPropertyName(property.name) &&
        iteratorKey(property.name, resolve) !== true &&
        callbackCreationEffect(property.name.expression)) ||
      (isPropertyAssignment(property) && callbackCreationEffect(property.initializer))
    ) {
      return false;
    }
  }
  const primitive = primitiveOf(fn, resolve);
  return (
    (primitive !== undefined && primitive !== 'nothing') ||
    isArrayLiteralExpression(fn) ||
    isObjectLiteralExpression(fn)
  );
}

/** An earlier native replacement leaves the selected consumer unproven. */
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
    if (
      isConstructorDeclaration(parent) ||
      (isAnswering(parent) && (answersLater(parent) || !isCalledValue(parent)))
    ) {
      break;
    }
  }
  return false;
}

/** The own iterator member of a written object, without invoking a getter. */
export function iteratorFunctionOf(
  source: Expression,
  resolve: Resolve | undefined,
): Node | undefined {
  const value = writtenOf(source, resolve);
  return isObjectLiteralExpression(value) ? ownIterator(value, resolve) : undefined;
}

/** Whether calling this source function creates a generator whose next calls run synchronously. */
function synchronousGenerator(fn: Node): boolean {
  return (
    isAnswering(fn) &&
    !isArrowFunction(fn) &&
    fn.asteriskToken !== undefined &&
    fn.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) !== true
  );
}

/** The final own Symbol.iterator property, respecting accessor pairs and unknown overwrites. */
function ownIterator(
  object: ObjectLiteralExpression,
  resolve: Resolve | undefined,
): Node | undefined {
  let setter = false;
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const iterator = iteratorKey(property.name, resolve);
    if (iterator === undefined) {
      return undefined;
    }
    if (!iterator) {
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
    return iteratorCallable(property, resolve);
  }
  return undefined;
}

/** A method declaration or the function held in an own data property. */
function iteratorCallable(
  property: ObjectLiteralElementLike,
  resolve: Resolve | undefined,
): Node | undefined {
  if (isMethodDeclaration(property)) {
    return property;
  }
  return isPropertyAssignment(property) ? writtenOf(property.initializer, resolve) : undefined;
}

/** Whether a key is Symbol.iterator, another known key, or unknown and able to overwrite it. */
function iteratorKey(name: PropertyName, resolve: Resolve | undefined): boolean | undefined {
  if (!isComputedPropertyName(name)) {
    return false;
  }
  const value: Expression = writtenOf(name.expression, resolve);
  if (globalCalleePath(value, resolve)?.join('.') === 'Symbol.iterator') {
    return true;
  }
  return isSymbolWritten(value, resolve) || constantValue(value, resolve) !== undefined
    ? false
    : undefined;
}
