import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isOmittedExpression,
  isSourceFile,
  isSpreadElement,
  isVariableStatement,
  type Node,
  type Statement,
} from 'typescript/ast';

import { calledMember } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { nativeMethodConversions, type NumericConversion } from './numeric-method-slots.ts';
import { expandedInvocation } from './throw-arguments.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { globalCalleePath } from './throw-callees.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

const READS = { date: 7 } as const;
const FORWARDERS: ReadonlySet<string> = new Set(['apply', 'call']);

/** Fixed ToNumber slots; explicit Number, text/parsing conversions and number predicates differ. */
const NUMERIC: ReadonlyMap<string, number> = new Map([
  ['Date.UTC', READS.date],
  ['isFinite', 1],
  ['isNaN', 1],
  ['Math.abs', 1],
  ['Math.acos', 1],
  ['Math.acosh', 1],
  ['Math.asin', 1],
  ['Math.asinh', 1],
  ['Math.atan2', 2],
  ['Math.atan', 1],
  ['Math.atanh', 1],
  ['Math.cbrt', 1],
  ['Math.ceil', 1],
  ['Math.clz32', 1],
  ['Math.cos', 1],
  ['Math.cosh', 1],
  ['Math.exp', 1],
  ['Math.expm1', 1],
  ['Math.f16round', 1],
  ['Math.floor', 1],
  ['Math.fround', 1],
  ['Math.imul', 2],
  ['Math.log1p', 1],
  ['Math.log2', 1],
  ['Math.log10', 1],
  ['Math.log', 1],
  ['Math.pow', 2],
  ['Math.random', 0],
  ['Math.round', 1],
  ['Math.sign', 1],
  ['Math.sin', 1],
  ['Math.sinh', 1],
  ['Math.sqrt', 1],
  ['Math.sumPrecise', 1],
  ['Math.tan', 1],
  ['Math.tanh', 1],
  ['Math.trunc', 1],
  ['String.prototype.repeat', 1],
]);

/** Variadic natives convert every supplied argument rather than only their formal parameters. */
const VARIADIC: ReadonlySet<string> = new Set([
  'Math.hypot',
  'Math.max',
  'Math.min',
  'String.fromCharCode',
  'String.fromCodePoint',
]);

/** A written BigInt in a necessarily number-coercing native argument position. */
export function numberBigIntArgumentThrows(node: Node, outer: Resolve | undefined): boolean {
  return numericArgumentThrows(
    node,
    outer,
    (value, resolve, kind) => kind === 'number' && isBigIntWritten(value, resolve),
  );
}

type InvalidArgument = (value: Expression, resolve: Resolve, kind: 'number' | 'bigint') => boolean;

/** A source-proven native conversion rejects a value, with its original evaluation context intact. */
export function numericArgumentThrows(
  node: Node,
  outer: Resolve | undefined,
  invalid: InvalidArgument,
): boolean {
  if (!isCallExpression(node) || earlierExpressionEffect(node)) {
    return false;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const invoked = numericInvocation(node, resolve);
  if (invoked === undefined) {
    return false;
  }
  const { path, reflected } = invoked;
  const converted = convertedArguments(invoked);
  if (converted === undefined) {
    return false;
  }
  return (
    converted.some((each) => invalid(each.value, resolve, each.kind)) &&
    node.arguments.every(
      (each, index) => (reflected && index === 0) || quietArgument(each, resolve, invalid),
    ) &&
    !priorEffect(node, path, resolve)
  );
}

interface NumericInvocation {
  readonly path: string;
  readonly given: readonly Expression[];
  readonly reflected: boolean;
  readonly converted?: readonly NumericConversion[] | undefined;
}

/** Method slots are already selected; global natives retain their existing arity table. */
function convertedArguments(invoked: NumericInvocation): readonly NumericConversion[] | undefined {
  if (invoked.converted !== undefined) {
    return invoked.converted;
  }
  const count = NUMERIC.get(invoked.path);
  if (count === undefined && !VARIADIC.has(invoked.path)) {
    return undefined;
  }
  const converted = count === undefined ? invoked.given : invoked.given.slice(0, count);
  return converted.map((value) => ({ kind: 'number', value }));
}

/** Native target and positional arguments only; evaluation remains tied to the original call. */
function numericInvocation(node: CallExpression, resolve: Resolve): NumericInvocation | undefined {
  const call = expandedInvocation(node, resolve);
  if (call.arguments.some((each) => isSpreadElement(each))) {
    return undefined;
  }
  const path = globalCalleePath(call.expression, resolve)?.join('.') ?? '';
  const reflected = path === 'Reflect.apply';
  const member = calledMember(writtenOf(call.expression, resolve));
  const forwarding = FORWARDERS.has(member?.name ?? '');
  if (!reflected && !forwarding) {
    return numericCall(call.expression, call.arguments, undefined, resolve);
  }
  const target = reflected ? call.arguments[0] : member?.of;
  if (target === undefined || calleeUncertain(target, node)) {
    return undefined;
  }
  const list = call.arguments[reflected ? 2 : 1];
  const given =
    !reflected && member?.name === 'call'
      ? call.arguments.slice(1)
      : appliedValues(list, node, resolve);
  if (given === undefined) {
    return undefined;
  }
  const invoked = numericCall(target, given, call.arguments[reflected ? 1 : 0], resolve);
  return { ...invoked, reflected };
}

/** A direct native or a borrowed intrinsic selects the same conversion slots. */
function numericCall(
  callee: Expression,
  given: readonly Expression[],
  receiver: Expression | undefined,
  resolve: Resolve,
): NumericInvocation {
  const method = nativeMethodConversions(callee, given, receiver, resolve);
  return {
    given,
    path: method?.path ?? globalCalleePath(callee, resolve)?.join('.') ?? '',
    reflected: false,
    ...(method !== undefined && { converted: method.converted }),
  };
}

/** Apply reads only an unchanged written list; unknown, sparse and changed lists stay unproven. */
function appliedValues(
  node: Expression | undefined,
  at: CallExpression,
  resolve: Resolve,
): readonly Expression[] | undefined {
  if (node === undefined || primitiveOf(node, resolve) === 'nothing') {
    return [];
  }
  const value = writtenOf(node, resolve);
  if (
    !isArrayLiteralExpression(value) ||
    value.elements.some((each) => isOmittedExpression(each)) ||
    calleeUncertain(value, at)
  ) {
    return undefined;
  }
  const view = new Proxy(at, {
    get: (target, key): unknown =>
      key === 'arguments' ? value.elements : Reflect.get(target, key),
  });
  const given = expandedInvocation(view, resolve).arguments;
  return given.some((each) => isSpreadElement(each)) ? undefined : given;
}

/** Known BigInt makers yield a bigint or throw; other application argument work remains unproven. */
function quietArgument(node: Expression, resolve: Resolve, invalid: InvalidArgument): boolean {
  const pending = [node];
  const seen = new Set<Expression>();
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const value = writtenOf(each, resolve);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (isArrayLiteralExpression(value)) {
      if (value.elements.some((part) => isSpreadElement(part) || isOmittedExpression(part))) {
        return false;
      }
      pending.push(...value.elements);
    } else if (isCallExpression(value) && invalid(value, resolve, 'number')) {
      if (
        value.arguments.some((part) => primitiveOf(writtenOf(part, resolve), resolve) === undefined)
      ) {
        return false;
      }
    } else if (callbackCreationEffect(value)) {
      return false;
    }
  }
  return true;
}

/** Enclosing prior work can replace a native callee, including before a nested immediate function. */
function priorEffect(call: CallExpression, path: string, resolve: Resolve): boolean {
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && statementEffect(statement, call, path, resolve),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** A stable alias of this native callee is a read, while other application work may replace it. */
function statementEffect(
  statement: Statement,
  call: CallExpression,
  path: string,
  resolve: Resolve,
): boolean {
  if (!isVariableStatement(statement)) {
    return callbackCreationEffect(statement);
  }
  return statement.declarationList.declarations.some((declaration) => {
    const value = declaration.initializer;
    if (
      value !== undefined &&
      globalCalleePath(value, resolve)?.join('.') === path &&
      !calleeUncertain(value, call)
    ) {
      return false;
    }
    return callbackCreationEffect(declaration);
  });
}
