import {
  type Expression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  type ObjectLiteralElementLike,
  type SpreadAssignment,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { literalKey } from './exported-values.ts';
import { type JsonReading, reached } from './json-reading.ts';

/** The source function a surviving own member of a literal object calls, through constants. */
export function ownCallTarget(callee: Expression, reading: JsonReading): Answering | undefined {
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return undefined;
  }
  const key = isPropertyAccessExpression(callee)
    ? callee.name.text
    : literalKey(reached(callee.argumentExpression, reading).value);
  const { at, value } = reached(callee.expression, reading);
  if (key === undefined || !isObjectLiteralExpression(value)) {
    return undefined;
  }
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const name = ownName(property, at);
    if (name === undefined) {
      return undefined;
    }
    if (name === key) {
      return ownFunction(property, at);
    }
  }
  return undefined;
}

/** A literal entry's ordinary name, or the constant value its computed name holds. */
function ownName(
  property: Exclude<ObjectLiteralElementLike, SpreadAssignment>,
  reading: JsonReading,
): string | undefined {
  const { name } = property;
  if (isIdentifier(name)) {
    return name.text;
  }
  return literalKey(isComputedPropertyName(name) ? reached(name.expression, reading).value : name);
}

/** The function an own data entry holds, or the source method it declares; no accessor's result. */
function ownFunction(
  property: ObjectLiteralElementLike,
  reading: JsonReading,
): Answering | undefined {
  if (isMethodDeclaration(property)) {
    return property;
  }
  let held: Expression | undefined;
  if (isPropertyAssignment(property)) {
    held = property.initializer;
  } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    held = property.name;
  }
  const value = held === undefined ? undefined : reached(held, reading).value;
  return value !== undefined && isAnswering(value) ? value : undefined;
}
