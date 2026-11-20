import {
  type CallExpression,
  type Expression,
  type GetAccessorDeclaration,
  isBlock,
  isCallExpression,
  isGetAccessorDeclaration,
  isObjectLiteralExpression,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { writtenDescriptors } from './throw-definitions.ts';
import { enumerationKey } from './throw-keys.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** Fields read by ToPropertyDescriptor before a native property definition. */
const FIELDS: ReadonlySet<string> = new Set([
  'configurable',
  'enumerable',
  'get',
  'set',
  'value',
  'writable',
]);
const SINGLE: ReadonlySet<string> = new Set(['Object.defineProperty', 'Reflect.defineProperty']);
const MULTIPLE: ReadonlySet<string> = new Set(['Object.create', 'Object.defineProperties']);

/** A sole source getter necessarily read while native code converts a property descriptor. */
export function descriptorGetterFunction(
  node: Node,
  outer: Resolve | undefined,
): GetAccessorDeclaration | undefined {
  if (!isCallExpression(node) || node.arguments.some((each) => isSpreadElement(each))) {
    return undefined;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const path = globalCalleePath(node.expression, resolve)?.join('.') ?? '';
  if (
    (!SINGLE.has(path) && !MULTIPLE.has(path)) ||
    node.arguments.some((each) => callbackCreationEffect(each)) ||
    earlierExpressionEffect(node) ||
    earlierStatementEffect(node)
  ) {
    return undefined;
  }
  const descriptors = descriptorLiterals(node, path, resolve);
  if (descriptors === undefined) {
    return undefined;
  }
  const getters: GetAccessorDeclaration[] = [];
  for (const descriptor of descriptors) {
    const selected = descriptorGetters(descriptor, resolve);
    if (selected === undefined) {
      return undefined;
    }
    getters.push(...selected);
  }
  return getters.length === 1 ? getters[0] : undefined;
}

/** Final own accessors in fields the native descriptor conversion actually reads. */
function descriptorGetters(
  descriptor: ObjectLiteralExpression,
  resolve: Resolve,
): readonly GetAccessorDeclaration[] | undefined {
  const properties = writtenDescriptors(descriptor, resolve)?.properties;
  if (properties === undefined) {
    return undefined;
  }
  const getters: GetAccessorDeclaration[] = [];
  for (const [key, property] of properties) {
    const getter = property.values.get('get')?.value;
    if (
      getter !== null &&
      typeof getter === 'object' &&
      property.kind === 'accessor' &&
      FIELDS.has(key) &&
      isGetAccessorDeclaration(getter)
    ) {
      getters.push(getter);
    }
  }
  return getters;
}

/** One descriptor or an own data dictionary, without earlier key coercions or dictionary getters. */
function descriptorLiterals(
  call: CallExpression,
  path: string,
  resolve: Resolve,
): readonly ObjectLiteralExpression[] | undefined {
  const [, second, third] = call.arguments;
  if (SINGLE.has(path)) {
    if (
      second === undefined ||
      third === undefined ||
      (primitiveOf(writtenOf(second, resolve), resolve) === undefined &&
        !isSymbolWritten(second, resolve))
    ) {
      return undefined;
    }
    const value = literalOf(third, call, resolve);
    return value === undefined ? undefined : [value];
  }
  return dictionaryDescriptors(second, call, resolve);
}

/** A descriptor dictionary cannot invoke an accessor before another descriptor is converted. */
function dictionaryDescriptors(
  node: Expression | undefined,
  call: CallExpression,
  resolve: Resolve,
): readonly ObjectLiteralExpression[] | undefined {
  const dictionary = node === undefined ? undefined : literalOf(node, call, resolve);
  const properties = dictionary === undefined ? undefined : writtenDescriptors(dictionary, resolve);
  if (properties === undefined) {
    return undefined;
  }
  const descriptors: ObjectLiteralExpression[] = [];
  for (const property of properties.properties.values()) {
    const value = property.values.get('value')?.value;
    if (value === null || typeof value !== 'object' || property.kind !== 'data') {
      return undefined;
    }
    if (!isObjectLiteralExpression(value)) {
      return undefined;
    }
    const descriptor = literalOf(value, call, resolve);
    if (descriptor === undefined) {
      return undefined;
    }
    descriptors.push(descriptor);
  }
  return descriptors;
}

/** A quiet, unchanged literal whose ordinary prototype cannot hide earlier descriptor reads. */
function literalOf(
  node: Expression,
  call: CallExpression,
  resolve: Resolve,
): ObjectLiteralExpression | undefined {
  const value = writtenOf(node, resolve);
  if (
    !isObjectLiteralExpression(value) ||
    callbackCreationEffect(value) ||
    calleeUncertain(value, call)
  ) {
    return undefined;
  }
  return value.properties.every((property) => {
    return (
      !isSpreadAssignment(property) &&
      !['__proto__', null, undefined].includes(enumerationKey(property.name, resolve))
    );
  })
    ? value
    : undefined;
}

/** Earlier application work may replace the native callee or a retained descriptor's getters. */
function earlierStatementEffect(call: CallExpression): boolean {
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return true;
    }
  }
  return false;
}
