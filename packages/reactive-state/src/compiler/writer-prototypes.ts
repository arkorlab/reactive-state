import {
  type Expression,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  type ObjectLiteralElementLike,
} from 'typescript/ast';

import type { TopLevel } from './analyze.ts';
import { keyValue, propertyKey } from './writer-bindings.ts';

/** The prototype a literal installs, and own spread members that shadow inherited writers. */

/** The initializer of a literal's prototype-setting entry, rather than an own __proto__ property. */
export function prototypeValue(
  property: ObjectLiteralElementLike,
  names: ReadonlyMap<string, TopLevel>,
): Expression | undefined {
  return isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name) &&
    propertyKey(property.name, names) === '__proto__'
    ? property.initializer
    : undefined;
}

/** Whether spreading a known plain holder necessarily copies an own property of this key. */
export function spreadsOwnKey(
  node: Expression,
  key: string | undefined,
  names: ReadonlyMap<string, TopLevel>,
): boolean {
  if (key === undefined) {
    return false;
  }
  const pending = [node];
  const seen = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = keyValue(next, names);
    if (seen.has(value) || !isObjectLiteralExpression(value)) {
      continue;
    }
    seen.add(value);
    // A getter may remove another member before the spread copies it.
    if (value.properties.some((each) => isGetAccessorDeclaration(each))) {
      continue;
    }
    for (const property of value.properties) {
      if (isSpreadAssignment(property)) {
        pending.push(property.expression);
      } else if (
        prototypeValue(property, names) === undefined &&
        propertyKey(property.name, names) === key
      ) {
        return true;
      }
    }
  }
  return false;
}
