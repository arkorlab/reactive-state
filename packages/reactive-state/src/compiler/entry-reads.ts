import {
  type Expression,
  isComputedPropertyName,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
} from 'typescript/ast';

import { type JsonReading, reached } from './json-reading.ts';
import type { Check } from './member-reads.ts';

/**
 * What the keys and the values of an object's entries hold, as the language's functions answer
 * them as arrays — `Reflect.ownKeys`, `Object.values`, `Object.entries` — read by the checks of
 * what no JSON holds (`json-values.ts`), as `check` reads a value.
 */

/**
 * Whether the keys of `node`'s entries may hold what no JSON holds, as `Reflect.ownKeys` answers
 * them: a key the code computes of what no JSON holds, a symbol — `[marker]` — or of a spread, what
 * it spreads; an object the code does not write, where it holds what no JSON holds at all.
 */
export function keysNonJson(node: Expression, reading: JsonReading, check: Check): boolean {
  const { at, value } = reached(node, reading);
  if (!isObjectLiteralExpression(value)) {
    return check(value, { ...at, entry: false });
  }
  return value.properties.some((property) => {
    if (isSpreadAssignment(property)) {
      return keysNonJson(property.expression, at, check);
    }
    const { name } = property;
    return isComputedPropertyName(name) && check(name.expression, { ...at, entry: false });
  });
}

/**
 * Whether the values of `node`'s entries hold what no JSON holds as elements, as `Object.values`
 * and `Object.entries` answer them: an entry of `undefined` among them, which an object's entry
 * may hold and no array of JSON does; a method, a function; of a spread, what it spreads. An object
 * the code does not write is read as it is.
 */
export function entriesNonJson(node: Expression, reading: JsonReading, check: Check): boolean {
  const { at, value } = reached(node, reading);
  if (!isObjectLiteralExpression(value)) {
    return check(value, { ...at, entry: false });
  }
  const element: JsonReading = { ...at, entry: false };
  return value.properties.some((property) => {
    if (isPropertyAssignment(property)) {
      return check(property.initializer, element);
    }
    if (isShorthandPropertyAssignment(property)) {
      return isIdentifier(property.name) && check(property.name, element);
    }
    return isSpreadAssignment(property)
      ? entriesNonJson(property.expression, at, check)
      : isMethodDeclaration(property);
  });
}
