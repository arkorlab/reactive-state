import {
  type Expression,
  isArrayLiteralExpression,
  isComputedPropertyName,
  isIdentifier,
  isObjectLiteralExpression,
  isRegularExpressionLiteral,
  isSpreadAssignment,
  isSpreadElement,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { literalKey } from './exported-values.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** What collection operations throw before consuming their iterable or calling their callback. */

/** The functions that group an iterable by a required callback, even of no elements. */
const GROUPING: ReadonlySet<string> = new Set(['Map.groupBy', 'Object.groupBy']);

/**
 * Whether `AggregateError`, called or constructed, throws of no iterable first argument. A plain
 * object with no spread, computed key or custom prototype has no iterator; text and arrays do.
 */
export function aggregateArgumentThrows(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (path !== 'AggregateError' || given.some((each) => isSpreadElement(each))) {
    return false;
  }
  const [first] = given;
  if (first === undefined) {
    return true;
  }
  return nonIterableWritten(first, resolve);
}

/** A value the source proves supplies no iterator, where a consumer requires one. */
export function nonIterableWritten(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  const primitive = primitiveOf(value, resolve);
  return (
    primitive === 'nothing' ||
    primitive === 'other' ||
    isSymbolWritten(value, resolve) ||
    (isObjectLiteralExpression(value) && hasNoIterator(value, resolve))
  );
}

/** Whether a grouping function throws of its required callback before iterating even an empty input. */
export function groupingCallbackThrows(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (!GROUPING.has(path) || given.some((each) => isSpreadElement(each))) {
    return false;
  }
  const callback = given[1];
  if (callback === undefined) {
    return true;
  }
  const value = writtenOf(callback, resolve);
  return (
    primitiveOf(value, resolve) !== undefined ||
    isSymbolWritten(value, resolve) ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isRegularExpressionLiteral(value)
  );
}

/** Whether every entry an object writes is an ordinary named entry, with no inherited iterator. */
function hasNoIterator(value: ObjectLiteralExpression, resolve: Resolve | undefined): boolean {
  return value.properties.every((property) => {
    if (isSpreadAssignment(property)) {
      return false;
    }
    const { name } = property;
    const key = isComputedPropertyName(name)
      ? constantValue(name.expression, resolve)
      : literalKey(name);
    const named = isIdentifier(name) ? name.text : key;
    return named !== undefined && named !== '__proto__';
  });
}
