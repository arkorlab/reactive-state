import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { literalKey } from './exported-values.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** Whether copying statically known keys cannot install a prototype or run a spread. */
export function ordinaryAssignKeys(
  object: ObjectLiteralExpression,
  resolve: Resolve | undefined,
): boolean {
  return object.properties.every((property) => {
    if (isSpreadAssignment(property)) {
      return false;
    }
    const key = enumerationKey(property.name, resolve);
    return typeof key === 'string' && key !== '__proto__';
  });
}

/** Syntax that applies ToPropertyKey to a source-proven object with no primitive conversion. */
export function propertyKeyThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (isComputedPropertyName(node)) {
    return hasNoConversion(node.expression, resolve);
  }
  if (isElementAccessExpression(node)) {
    return selectedKey(node, resolve) && hasNoConversion(node.argumentExpression, resolve);
  }
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.InKeyword) {
    return hasNoConversion(node.left, resolve);
  }
  // A method's computed name runs even though its deferred body is not visited.
  return (
    isObjectLiteralExpression(node) &&
    node.properties.some((property) => {
      return (
        !isSpreadAssignment(property) &&
        isComputedPropertyName(property.name) &&
        hasNoConversion(property.name.expression, resolve)
      );
    })
  );
}

/** Every optional link must continue before this key is necessarily converted. Parentheses end it. */
function selectedKey(node: Expression, outer: Resolve | undefined): boolean {
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  let each = node;
  while (
    isElementAccessExpression(each) ||
    isPropertyAccessExpression(each) ||
    isCallExpression(each) ||
    isNonNullExpression(each)
  ) {
    if (
      !isNonNullExpression(each) &&
      each.questionDotToken !== undefined &&
      !nonNullishReceiver(each.expression, resolve)
    ) {
      return false;
    }
    each = each.expression;
  }
  return true;
}

/** Written primitives, literal objects/functions and completed constructions cannot be nullish. */
function nonNullishReceiver(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  const primitive = primitiveOf(value, resolve);
  return (
    (primitive !== undefined && primitive !== 'nothing') ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isNewExpression(value) ||
    value.kind === SyntaxKind.RegularExpressionLiteral ||
    isSymbolWritten(value, resolve)
  );
}

/** An empty null-prototype object has neither OrdinaryToPrimitive method nor @@toPrimitive. */
export function hasNoConversion(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  if (isCallExpression(value)) {
    const [prototype, properties] = value.arguments;
    return (
      globalCalleePath(value.expression, resolve)?.join('.') === 'Object.create' &&
      prototype !== undefined &&
      writtenOf(prototype, resolve).kind === SyntaxKind.NullKeyword &&
      (properties === undefined ||
        primitiveOf(writtenOf(properties, resolve), resolve) === 'nothing')
    );
  }
  if (!isObjectLiteralExpression(value)) {
    return false;
  }
  let nullPrototype = false;
  for (const property of value.properties) {
    if (isSpreadAssignment(property) || isComputedPropertyName(property.name)) {
      return false;
    }
    const name = isIdentifier(property.name) ? property.name.text : literalKey(property.name);
    if (name === undefined || ['toString', 'valueOf'].includes(name)) {
      return false;
    }
    if (name === '__proto__' && isPropertyAssignment(property)) {
      nullPrototype = writtenOf(property.initializer, resolve).kind === SyntaxKind.NullKeyword;
    }
  }
  return nullPrototype;
}

/** The text of a statically written property key, `null` of a symbol, or none of an unknown key. */
export function enumerationKey(
  name: PropertyName,
  resolve: Resolve | undefined,
): string | null | undefined {
  if (isIdentifier(name)) {
    return name.text;
  }
  if (!isComputedPropertyName(name)) {
    return literalKey(name);
  }
  if (isSymbolWritten(name.expression, resolve)) {
    return null;
  }
  const key = constantValue(name.expression, resolve);
  return key === undefined ? undefined : String(key);
}
