import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isExpression,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isRegularExpressionLiteral,
  isSourceFile,
  isBlock,
  isSpreadElement,
  isVariableStatement,
  type Node,
} from 'typescript/ast';

import { calledMember, unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { globalPath } from './global-answers.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { CALLING } from './throw-callback-methods.ts';
import { globalCalleePath } from './throw-callees.ts';
import { eagerClassOf } from './throw-classes.ts';
import { isTypedKind, primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** Native Function methods that require a callable receiver; constructor and @@hasInstance are generic. */
const CALLABLE_METHODS: ReadonlySet<string> = new Set(['apply', 'bind', 'call', 'toString']);
const OBJECT_CONSTRUCTIONS: ReadonlySet<string> = new Set([
  'Array',
  'ArrayBuffer',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'Map',
  'Number',
  'Object',
  'Promise',
  'RegExp',
  'Set',
  'SharedArrayBuffer',
  'WeakMap',
  'WeakRef',
  'WeakSet',
]);

/** A class used as a callback necessarily invoked by a quiet native literal-array method. */
export function invokedClassThrows(
  callee: Expression,
  given: readonly Expression[],
  outer: Resolve | undefined,
): boolean {
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const member = calledMember(callee);
  const least = member === undefined ? undefined : CALLING.get(member.name);
  const first = given[0];
  const callback = first === undefined ? undefined : writtenOf(first, resolve);
  const call = sourceCall(callee);
  if (
    least === undefined ||
    member === undefined ||
    callback === undefined ||
    call === undefined ||
    !isClassExpression(callback) ||
    !quietNativeCall(call) ||
    !quietCreation(callback)
  ) {
    return false;
  }
  const array = writtenOf(member.of, resolve);
  if (
    !isArrayLiteralExpression(array) ||
    !quietCreation(array) ||
    calleeUncertain(array, call) ||
    array.elements.some((each) => isSpreadElement(each))
  ) {
    return false;
  }
  const sort = member.name === 'sort' || member.name === 'toSorted';
  const present = array.elements.filter(
    (each) => !isOmittedExpression(each) && (!sort || definedValue(each, resolve)),
  ).length;
  const initial = given.length > 1 && (member.name === 'reduce' || member.name === 'reduceRight');
  return present >= (initial ? 1 : least);
}

/** A borrowed Function method whose shown receiver cannot satisfy its callable requirement. */
export function functionReceiverThrows(
  lent: { readonly method: string; readonly receiver: Expression | undefined },
  callee: Expression,
  outer: Resolve | undefined,
): boolean {
  const call = sourceCall(callee);
  if (call === undefined || !CALLABLE_METHODS.has(lent.method) || !quietNativeCall(call)) {
    return false;
  }
  if (lent.receiver === undefined) {
    return true;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const value = writtenOf(lent.receiver, resolve);
  if (isClassExpression(value)) {
    return lent.method === 'call' || lent.method === 'apply';
  }
  if (
    primitiveOf(value, resolve) !== undefined ||
    isSymbolWritten(value, resolve) ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isRegularExpressionLiteral(value)
  ) {
    return true;
  }
  const path = isNewExpression(value) ? globalCalleePath(value.expression, resolve) : undefined;
  const [kind = ''] = path ?? [];
  return path?.length === 1 && (OBJECT_CONSTRUCTIONS.has(kind) || isTypedKind(kind));
}

/** Sort skips holes and undefined; unknown elements do not guarantee a comparison. */
function definedValue(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  const primitive = primitiveOf(value, resolve);
  return primitive !== undefined && primitive !== 'nothing';
}

/** The actual source invocation also contains argument work omitted by borrowed normalization. */
function sourceCall(node: Node): CallExpression | undefined {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (isCallExpression(each)) {
      return each;
    }
  }
  return undefined;
}

/** Earlier arguments and enclosing application work may replace a native method or empty its receiver. */
function quietNativeCall(call: CallExpression): boolean {
  const reflected = globalPath(call.expression)?.join('.') === 'Reflect.apply';
  const given = reflected ? call.arguments.slice(1) : call.arguments;
  if (given.some((each) => !quietCreation(each)) || earlierExpressionEffect(call)) {
    return false;
  }
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some((statement) => statement.end <= each.pos && !quietStatement(statement))
    ) {
      return false;
    }
  }
  return true;
}

/** Class creation follows eager keys and initializers, leaving constructor and instance bodies deferred. */
function quietCreation(node: Node): boolean {
  const value = isExpression(node) ? unwrapped(node) : node;
  if (isClassExpression(value) || isClassDeclaration(value)) {
    const eager = eagerClassOf(value);
    return (
      eager?.blocks.length === 0 &&
      [...eager.keys, ...eager.expressions].every((each) => !callbackCreationEffect(each))
    );
  }
  return isArrayLiteralExpression(value)
    ? value.elements.every((each) => !isSpreadElement(each) && quietCreation(each))
    : !callbackCreationEffect(value);
}

/** A constant alias of a quiet class does not run its constructor while it is declared. */
function quietStatement(node: Node): boolean {
  return isVariableStatement(node)
    ? node.declarationList.declarations.every(
        (each) => each.initializer === undefined || quietCreation(each.initializer),
      )
    : quietCreation(node);
}
