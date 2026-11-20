import {
  isCallExpression,
  isComputedPropertyName,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadElement,
  type Expression,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { globalCalleePath } from './throw-callees.ts';
import { enumerationKey } from './throw-keys.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** Array.from lengths that ToLength cannot convert, without selecting an unknown iterator. */
export function arrayFromLengthThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (
    !isCallExpression(node) ||
    node.arguments.some((each) => isSpreadElement(each)) ||
    earlierExpressionEffect(node)
  ) {
    return false;
  }
  const follow: Resolve = (name) => {
    const held = resolve?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, node) ? undefined : held;
  };
  if (globalCalleePath(node.expression, follow)?.join('.') !== 'Array.from') {
    return false;
  }
  const [source, ...later] = node.arguments;
  if (source === undefined || later.some((each) => callbackCreationEffect(each))) {
    return false;
  }
  const value = writtenOf(source, follow);
  if (!isObjectLiteralExpression(value) || calleeUncertain(value, node)) {
    return false;
  }
  const length = arrayLikeLength(value, follow);
  return length !== undefined && uncoercibleLength(length, follow);
}

/** A final own length data entry without another iterator source or creation effect. */
function arrayLikeLength(value: ObjectLiteralExpression, resolve: Resolve): Expression | undefined {
  let length: Expression | undefined;
  for (const property of value.properties) {
    if (!isPropertyAssignment(property) || isComputedPropertyName(property.name)) {
      return undefined;
    }
    const key = enumerationKey(property.name, resolve);
    if (key === '__proto__') {
      return undefined;
    }
    if (key === 'length') {
      if (
        callbackCreationEffect(property.initializer) &&
        !uncoercibleLength(property.initializer, resolve)
      ) {
        return undefined;
      }
      length = property.initializer;
    } else if (callbackCreationEffect(property.initializer)) {
      return undefined;
    }
  }
  return length;
}

/** Only known primitive makers with quiet primitive inputs establish a bad length after creation. */
function uncoercibleLength(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  if (!isBigIntWritten(value, resolve) && !isSymbolWritten(value, resolve)) {
    return false;
  }
  return (
    !isCallExpression(value) ||
    value.arguments.every((argument) => {
      return (
        !callbackCreationEffect(argument) &&
        primitiveOf(writtenOf(argument, resolve), resolve) !== undefined
      );
    })
  );
}
