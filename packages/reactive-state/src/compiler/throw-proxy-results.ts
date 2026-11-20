import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isClassExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isReturnStatement,
  isSpreadElement,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { callbackCreationEffect } from './callback-evaluation.ts';
import { constantValue } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { callbackResultThrows } from './throw-callback-results.ts';
import { primitiveOf } from './throw-shapes.ts';

/** A simple ownKeys trap result that cannot be a list of distinct string or symbol keys. */
export function proxyOwnKeysResultThrows(fn: Answering): boolean {
  if (isGetAccessorDeclaration(fn) || answersLater(fn)) {
    return false;
  }
  if (callbackResultThrows(fn, 'object', undefined)) {
    return true;
  }
  const result = returnedList(fn);
  if (result === undefined || callbackCreationEffect(result)) {
    return false;
  }
  const keys = new Set<string>();
  for (const element of result.elements) {
    if (isOmittedExpression(element)) {
      return true;
    }
    const value = unwrapped(element);
    const key = constantValue(value);
    if (typeof key === 'string') {
      if (keys.has(key)) {
        return true;
      }
      keys.add(key);
    } else if (nonKey(value)) {
      return true;
    }
  }
  return false;
}

/** Only one written return establishes a result; callback defaults and effectful bodies defer. */
function returnedList(fn: Answering): ArrayLiteralExpression | undefined {
  if (
    fn.body === undefined ||
    parametersOf(fn).some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  ) {
    return undefined;
  }
  let result: Expression | undefined;
  if (isBlock(fn.body)) {
    const [only] = fn.body.statements;
    if (only === undefined || fn.body.statements.length !== 1 || !isReturnStatement(only)) {
      return undefined;
    }
    result = only.expression;
  } else {
    result = fn.body;
  }
  const value = result === undefined ? undefined : unwrapped(result);
  return value !== undefined &&
    isArrayLiteralExpression(value) &&
    !value.elements.some((each) => isSpreadElement(each))
    ? value
    : undefined;
}

/** Property keys in a trap list are never coerced: a written non-text primitive or object is invalid. */
function nonKey(value: Expression): boolean {
  const primitive = primitiveOf(value, undefined);
  return (
    (primitive !== undefined && primitive !== 'text') ||
    isBigIntWritten(value, undefined) ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isAnswering(value) ||
    isClassExpression(value)
  );
}
