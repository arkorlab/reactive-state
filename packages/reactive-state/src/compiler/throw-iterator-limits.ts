import {
  isArrayLiteralExpression,
  isCallExpression,
  isSpreadElement,
  type CallExpression,
  type Expression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { calledMember } from './bounded.ts';
import { callbackCreationEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { globalCalleePath } from './throw-callees.ts';
import { nativeEvaluationChanged } from './throw-native-next.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** Native iterator helper limits are converted and validated before the helper can be resumed. */
export function iteratorLimitThrows(node: Node, outer: Resolve | undefined): boolean {
  if (!isCallExpression(node) || nativeEvaluationChanged(node)) {
    return false;
  }
  const resolve: Resolve = (name) => {
    const value = outer?.(name) ?? metadataInitializer(name);
    return value === undefined || calleeUncertain(value, node) ? undefined : value;
  };
  const member = calledMember(writtenOf(node.expression, resolve));
  if (
    member === undefined ||
    (member.name !== 'take' && member.name !== 'drop') ||
    !nativeIterator(member.of, node, resolve) ||
    node.arguments.some((each) => isSpreadElement(each) || !quietArgument(each, resolve))
  ) {
    return false;
  }
  return invalidLimit(node.arguments[0], resolve);
}

/** A quiet written array or string acquires an ordinary native iterator without application code. */
function nativeIterator(receiver: Expression, at: CallExpression, resolve: Resolve): boolean {
  const value = writtenOf(receiver, resolve);
  if (
    !isCallExpression(value) ||
    globalCalleePath(value.expression, resolve)?.join('.') !== 'Iterator.from' ||
    calleeUncertain(value, at)
  ) {
    return false;
  }
  const [source, ...later] = value.arguments;
  if (
    source === undefined ||
    isSpreadElement(source) ||
    later.some((each) => isSpreadElement(each) || !quietArgument(each, resolve))
  ) {
    return false;
  }
  const input = writtenOf(source, resolve);
  return (
    !calleeUncertain(input, at) &&
    !callbackCreationEffect(input) &&
    (isArrayLiteralExpression(input) || typeof constantValue(input, resolve) === 'string')
  );
}

/** A known primitive maker remains quiet only when creating its argument cannot run application code. */
function quietArgument(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  if (isBigIntWritten(value, resolve) || isSymbolWritten(value, resolve)) {
    return (
      !isCallExpression(value) ||
      value.arguments.every((each) => {
        return (
          primitiveOf(writtenOf(each, resolve), resolve) !== undefined &&
          !callbackCreationEffect(writtenOf(each, resolve))
        );
      })
    );
  }
  return !callbackCreationEffect(value);
}

/** NaN and missing limits fail; ToIntegerOrInfinity truncates negative fractions before comparison. */
function invalidLimit(node: Expression | undefined, resolve: Resolve): boolean {
  if (node === undefined) {
    return true;
  }
  const value = writtenOf(node, resolve);
  if (isBigIntWritten(value, resolve) || isSymbolWritten(value, resolve)) {
    return true;
  }
  if (primitiveOf(value, resolve) === 'nothing') {
    return value.kind !== SyntaxKind.NullKeyword;
  }
  const constant = constantValue(value, resolve);
  if (constant === undefined) {
    return false;
  }
  const number = Number(constant);
  return Number.isNaN(number) || Math.trunc(number) < 0;
}
