import {
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isNewExpression,
  isSourceFile,
  isSpreadElement,
  isVariableStatement,
  type NewExpression,
  type Node,
} from 'typescript/ast';

import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** The sole native symbol maker that registers the returned identity. */
const REGISTERED_SYMBOL = 'Symbol.for';

/** Source-proven registered symbols cannot be entries of a native weak collection. */
export function registeredWeakEntriesThrow(
  path: string,
  given: readonly Expression[],
  outer: Resolve | undefined,
): boolean {
  const argument = given[0];
  const call = argument === undefined ? undefined : constructionOf(argument);
  if (call === undefined || earlierExpressionEffect(call)) {
    return false;
  }
  const resolve: Resolve = (name) => {
    const captured = metadataInitializer(name);
    const held = outer?.(name) ?? captured;
    if (held === undefined) {
      return;
    }
    const native = held === captured && symbolMaker(globalCalleePath(held, undefined)?.join('.'));
    return native || !calleeUncertain(held, call) ? held : undefined;
  };
  if (given.some((each) => !quietValue(each, resolve)) || !quietPrefix(call, resolve)) {
    return false;
  }
  const entries = argument === undefined ? undefined : writtenOf(argument, resolve);
  if (
    entries === undefined ||
    !isArrayLiteralExpression(entries) ||
    calleeUncertain(entries, call)
  ) {
    return false;
  }
  return entries.elements.some((element) => {
    const entry = writtenOf(element, resolve);
    const key = path === 'WeakMap' && isArrayLiteralExpression(entry) ? entry.elements[0] : entry;
    return key !== undefined && registeredSymbol(key, resolve);
  });
}

/** Only Symbol.for registers the symbol; ordinary Symbol and well-known symbols remain valid. */
function registeredSymbol(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  return (
    isCallExpression(value) &&
    globalCalleePath(value.expression, resolve)?.join('.') === REGISTERED_SYMBOL
  );
}

/** Native symbol creation with primitive arguments cannot repair a collection's selected adder. */
function quietValue(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  if (isArrayLiteralExpression(value)) {
    return value.elements.every((each) => !isSpreadElement(each) && quietValue(each, resolve));
  }
  const named = globalCalleePath(value, resolve)?.join('.');
  if (symbolMaker(named)) {
    return true;
  }
  if (isCallExpression(value)) {
    const path = globalCalleePath(value.expression, resolve)?.join('.');
    return (
      symbolMaker(path) &&
      value.arguments.every((each) => {
        return (
          !callbackCreationEffect(each) &&
          primitiveOf(writtenOf(each, resolve), resolve) !== undefined
        );
      })
    );
  }
  return !callbackCreationEffect(value);
}

/** A captured native symbol function keeps its call behavior after quiet source-array creation. */
function symbolMaker(path: string | undefined): boolean {
  return path === 'Symbol' || path === REGISTERED_SYMBOL;
}

/** Earlier enclosing applications may replace the native constructor, symbol maker or adder. */
function quietPrefix(call: NewExpression, resolve: Resolve): boolean {
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && !quietStatement(statement, resolve),
      )
    ) {
      return false;
    }
  }
  return true;
}

/** A quiet constant alias of symbols or entry arrays introduces no application effects. */
function quietStatement(node: Node, resolve: Resolve): boolean {
  return isVariableStatement(node)
    ? node.declarationList.declarations.every(
        (each) => each.initializer === undefined || quietValue(each.initializer, resolve),
      )
    : !callbackCreationEffect(node);
}

/** The actual constructor whose argument retains its original parent chain. */
function constructionOf(node: Node): NewExpression | undefined {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (isNewExpression(each)) {
      return each;
    }
  }
  return undefined;
}
