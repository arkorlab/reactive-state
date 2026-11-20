import {
  type CallExpression,
  type Expression,
  isBlock,
  isCallExpression,
  isSourceFile,
  isSpreadElement,
  isVariableStatement,
  type Node,
  type Statement,
} from 'typescript/ast';

import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { expandedInvocation } from './throw-arguments.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { globalCalleePath } from './throw-callees.ts';
import { iteratorLimitThrows } from './throw-iterator-limits.ts';
import { numberBigIntArgumentThrows } from './throw-number-bigints.ts';
import { numberSymbolArgumentThrows } from './throw-number-symbols.ts';
import { regexpSymbolThrows } from './throw-regexp-symbols.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

const TIMEOUT = { path: 'AbortSignal.timeout', maximum: 0xff_ff_ff_ff } as const;

/** Native argument contracts that fail before any successful operation is scheduled or returned. */
export function nativeArgumentThrows(node: Node, resolve: Resolve | undefined): boolean {
  return (
    numberBigIntArgumentThrows(node, resolve) ||
    numberSymbolArgumentThrows(node, resolve) ||
    iteratorLimitThrows(node, resolve) ||
    abortTimeoutThrows(node, resolve) ||
    regexpSymbolThrows(node, resolve)
  );
}

/** The native timeout delay is an unsigned integer number; validation creates no timer. */
function abortTimeoutThrows(node: Node, outer: Resolve | undefined): boolean {
  if (!isCallExpression(node) || earlierExpressionEffect(node)) {
    return false;
  }
  const resolve: Resolve = (name) => {
    const value = outer?.(name) ?? metadataInitializer(name);
    return value === undefined || calleeUncertain(value, node) ? undefined : value;
  };
  const call = expandedInvocation(node, resolve);
  if (
    globalCalleePath(call.expression, resolve)?.join('.') !== TIMEOUT.path ||
    call.arguments.some((each) => isSpreadElement(each) || !quietArgument(each, resolve)) ||
    priorEffect(node, resolve)
  ) {
    return false;
  }
  const [first] = call.arguments;
  if (first === undefined) {
    return true;
  }
  const delay = writtenOf(first, resolve);
  const value = constantValue(delay, resolve);
  if (typeof value === 'number') {
    return !Number.isSafeInteger(value) || value < 0 || value > TIMEOUT.maximum;
  }
  return (
    primitiveOf(delay, resolve) !== undefined ||
    isBigIntWritten(delay, resolve) ||
    isSymbolWritten(delay, resolve)
  );
}

/** Known primitive makers are quiet only when their argument construction is also quiet. */
function quietArgument(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  return isCallExpression(value) &&
    (isBigIntWritten(value, resolve) || isSymbolWritten(value, resolve))
    ? value.arguments.every((each) => !callbackCreationEffect(writtenOf(each, resolve)))
    : !callbackCreationEffect(value);
}

/** Enclosing application work can replace a timeout method before a nested immediate call. */
function priorEffect(call: CallExpression, resolve: Resolve): boolean {
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && statementEffect(statement, call, resolve),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Capturing this native method is quiet; any other earlier application effect stays opaque. */
function statementEffect(statement: Statement, call: CallExpression, resolve: Resolve): boolean {
  if (!isVariableStatement(statement)) {
    return callbackCreationEffect(statement);
  }
  return statement.declarationList.declarations.some((declaration) => {
    const value = declaration.initializer;
    return (
      (value === undefined ||
        globalCalleePath(value, resolve)?.join('.') !== TIMEOUT.path ||
        calleeUncertain(value, call)) &&
      callbackCreationEffect(declaration)
    );
  });
}
