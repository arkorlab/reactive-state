import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isFunctionExpression,
  isObjectLiteralExpression,
  isRegularExpressionLiteral,
  isSourceFile,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { calledMember } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { globalCalleePath } from './throw-callees.ts';
import { quietNativeCall } from './throw-construct-only.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** Earlier application work, including enclosing immediate scopes, leaves native behavior unproven. */
export function nativeEvaluationChanged(node: Node): boolean {
  if (earlierExpressionEffect(node)) {
    return true;
  }
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (
      isBlock(each.parent) &&
      each.parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** An abstract Iterator constructor cannot be constructed with itself as the direct new target. */
export function abstractIteratorThrows(node: NewExpression, outer: Resolve | undefined): boolean {
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  return (
    globalCalleePath(node.expression, resolve)?.join('.') === 'Iterator' &&
    !nativeEvaluationChanged(node) &&
    (node.arguments ?? []).every((each) => !callbackCreationEffect(writtenOf(each, resolve)))
  );
}

/** Additional native call shapes whose failures precede any result conversion. */
export function additionalNativeCallThrows(
  call: CallExpression,
  path: string,
  outer: Resolve | undefined,
): boolean {
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  if (path === 'queueMicrotask') {
    return quietNativeCall(call, path, resolve) && noCallback(call.arguments[0], resolve);
  }
  const member = calledMember(call.expression);
  if (member?.name !== 'compile' || !quietNativeCall(call, 'RegExp.prototype.compile', resolve)) {
    return false;
  }
  const receiver = writtenOf(member.of, resolve);
  const source = call.arguments[0];
  const flags = call.arguments[1];
  return (
    isRegularExpressionLiteral(receiver) &&
    source !== undefined &&
    flags !== undefined &&
    isRegularExpressionLiteral(writtenOf(source, resolve)) &&
    !calleeUncertain(receiver, call) &&
    knownDefined(flags, resolve)
  );
}

/** Defined literal flags differ from both omitted/undefined flags and an unknown value. */
function knownDefined(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  const kind = primitiveOf(value, resolve);
  return (
    value.kind === SyntaxKind.NullKeyword ||
    (kind !== undefined && kind !== 'nothing') ||
    isBigIntWritten(value, resolve) ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value)
  );
}

/** Registration validates function identity; class and generator bodies are not invoked synchronously. */
function noCallback(node: Expression | undefined, resolve: Resolve): boolean {
  if (node === undefined) {
    return true;
  }
  const value = writtenOf(node, resolve);
  return (
    primitiveOf(value, resolve) !== undefined ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isRegularExpressionLiteral(value)
  );
}

/** Functions whose ordinary instance prototype is absent, unlike generator and class functions. */
export function lacksFunctionPrototype(node: Expression, at: Expression): boolean {
  if (calleeUncertain(node, at)) {
    return false;
  }
  return (
    isArrowFunction(node) ||
    (isFunctionExpression(node) &&
      node.asteriskToken === undefined &&
      node.modifiers?.some((each) => each.kind === SyntaxKind.AsyncKeyword) === true)
  );
}

/** A native compile receiver needs internal RegExp slots; an own exec method is insufficient. */
export function compileReceiverThrows(
  callee: Expression,
  source: { readonly brand: string; readonly method: string; readonly kind: string | undefined },
  resolve: Resolve | undefined,
): boolean | undefined {
  if (source.brand !== 'RegExp' || source.method !== 'compile') {
    return undefined;
  }
  const call = callee.parent;
  return (
    isCallExpression(call) &&
    quietNativeCall(
      call,
      'RegExp.prototype.compile',
      resolve,
      globalCalleePath(callee, resolve)?.join('.') === 'Reflect.apply',
    ) &&
    source.kind !== undefined &&
    source.kind !== 'new RegExp'
  );
}
