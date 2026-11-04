import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isSourceFile,
  isVariableStatement,
  type Node,
} from 'typescript/ast';

import { calledMember } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** String's own native methods either coerce their receiver or require its string brand. */
const STRING_METHODS: ReadonlySet<string> = new Set([
  'at',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'concat',
  'endsWith',
  'includes',
  'indexOf',
  'isWellFormed',
  'lastIndexOf',
  'localeCompare',
  'match',
  'matchAll',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'replaceAll',
  'search',
  'slice',
  'split',
  'startsWith',
  'substr',
  'substring',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toString',
  'toUpperCase',
  'toWellFormed',
  'trim',
  'trimEnd',
  'trimLeft',
  'trimRight',
  'trimStart',
  'valueOf',
]);

/** A native callback requirement rejects a written symbol before any callback body can run. */
export function symbolCallbackThrows(
  value: Expression,
  callee: Expression,
  outer: Resolve | undefined,
): boolean {
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  return isSymbolWritten(value, resolve) && quietInvocation(callee, resolve);
}

/** A borrowed String method cannot coerce a symbol receiver, unlike the String constructor. */
export function stringSymbolReceiverThrows(
  lent: { readonly method: string; readonly receiver: Expression | undefined },
  callee: Expression,
  outer: Resolve | undefined,
): boolean {
  return (
    lent.receiver !== undefined &&
    STRING_METHODS.has(lent.method) &&
    symbolCallbackThrows(lent.receiver, callee, outer)
  );
}

/** Source argument and enclosing evaluation must preserve the selected native method. */
function quietInvocation(callee: Expression, resolve: Resolve): boolean {
  const call = sourceCall(callee);
  if (call === undefined || earlierExpressionEffect(call)) {
    return false;
  }
  const path = globalCalleePath(call.expression, resolve)?.join('.');
  const args = path === 'Reflect.apply' ? call.arguments.slice(1) : call.arguments;
  const receiver = path === undefined ? calledMember(callee)?.of : undefined;
  if (
    args.some((each) => !quietValue(each, resolve)) ||
    (receiver !== undefined && !quietValue(receiver, resolve))
  ) {
    return false;
  }
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

/** Symbol creation and aliases are quiet when their own arguments contain no application work. */
function quietValue(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  if (isSymbolWritten(value, resolve)) {
    return (
      !isCallExpression(value) ||
      value.arguments.every((each) => !callbackCreationEffect(writtenOf(each, resolve)))
    );
  }
  return isArrayLiteralExpression(value)
    ? value.elements.every((each) => quietValue(each, resolve))
    : !callbackCreationEffect(value);
}

/** A quiet alias declaration does not alter a native method before it is called. */
function quietStatement(node: Node, resolve: Resolve): boolean {
  return isVariableStatement(node)
    ? node.declarationList.declarations.every(
        (each) => each.initializer === undefined || quietValue(each.initializer, resolve),
      )
    : !callbackCreationEffect(node);
}

/** A borrowed call's normalized syntax still has the original invocation among its ancestors. */
function sourceCall(node: Node): CallExpression | undefined {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (isCallExpression(each)) {
      return each;
    }
  }
  return undefined;
}
