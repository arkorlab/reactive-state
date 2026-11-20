import {
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isOmittedExpression,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { callbackCreationEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { hasNoConversion } from './throw-keys.ts';
import { writtenOf } from './throw-shapes.ts';
import { interveningEvaluation } from './written-evaluation.ts';

/** Native entry-key conversion of literal pairs whose creation cannot replace a conversion hook. */
export function entryKeyThrows(node: Node, outer: Resolve | undefined): boolean {
  if (!isCallExpression(node)) {
    return false;
  }
  const resolve: Resolve = (name) => {
    const held = outer?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, node) ? undefined : held;
  };
  if (
    globalCalleePath(node.expression, resolve)?.join('.') !== 'Object.fromEntries' ||
    !node.arguments.every((argument) => quietEntry(argument, resolve))
  ) {
    return false;
  }
  const argument = node.arguments[0];
  const entries = argument === undefined ? undefined : writtenOf(argument, resolve);
  if (
    entries === undefined ||
    !isArrayLiteralExpression(entries) ||
    !quietEntry(entries, resolve) ||
    interveningEvaluation(entries, node)
  ) {
    return false;
  }
  for (const entry of entries.elements) {
    if (isOmittedExpression(entry) || isSpreadElement(entry)) {
      return false;
    }
    const pair = writtenOf(entry, resolve);
    if (
      !isArrayLiteralExpression(pair) ||
      !quietEntry(pair, resolve) ||
      interveningEvaluation(pair, node)
    ) {
      return false;
    }
    if (badEntryKey(pair.elements[0], node, resolve)) {
      return true;
    }
  }
  return false;
}

/** A present pair key with no primitive conversion before native entry consumption. */
function badEntryKey(key: Expression | undefined, at: Expression, resolve: Resolve): boolean {
  return (
    key !== undefined &&
    !isOmittedExpression(key) &&
    !isSpreadElement(key) &&
    hasNoConversion(key, resolve) &&
    !interveningEvaluation(writtenOf(key, resolve), at)
  );
}

/** Literal array creation and empty null-prototype construction have no application evaluation. */
function quietEntry(node: Expression, resolve: Resolve | undefined): boolean {
  const value = unwrapped(node);
  if (isArrayLiteralExpression(value)) {
    return value.elements.every(
      (element) => !isSpreadElement(element) && quietEntry(element, resolve),
    );
  }
  if (isCallExpression(value) && hasNoConversion(value, resolve)) {
    return (
      value.arguments.length <= 2 &&
      value.arguments.every((argument) => !callbackCreationEffect(argument))
    );
  }
  return !callbackCreationEffect(value);
}
