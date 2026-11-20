import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isClassExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isTaggedTemplateExpression,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { calledMember, globalOf, unwrapped } from './bounded.ts';
import { earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { runsLater } from './deferred-syntax.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { callbackResultThrows } from './throw-callback-results.ts';
import { globalCalleePath } from './throw-callees.ts';
import { conversionRunsCode } from './throw-coercions.ts';
import { isTypedKind, primitiveOf, typedOf, writtenOf } from './throw-shapes.ts';
import { writtenBy } from './written.ts';

/** A guaranteed native comparison whose source callback returns a value ToNumber cannot consume. */
export function comparatorResultThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (!isCallExpression(node) || node.arguments.length !== 1 || earlierExpressionEffect(node)) {
    return false;
  }
  const member = calledMember(unwrapped(node.expression));
  const [given] = node.arguments;
  if (
    given === undefined ||
    member === undefined ||
    (member.name !== 'sort' && member.name !== 'toSorted')
  ) {
    return false;
  }
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const fn = writtenOf(given, follow);
  if (
    (!isArrowFunction(fn) && !isFunctionExpression(fn)) ||
    calleeUncertain(fn, node.expression) ||
    !callbackResultThrows(fn, 'number', follow)
  ) {
    return false;
  }
  const receiver = writtenOf(member.of, follow);
  return !calleeUncertain(receiver, node) && comparisonNeeded(receiver, follow);
}

/** Arrays compare defined entries; typed arrays compare every element of their known length. */
function comparisonNeeded(value: Expression, resolve: Resolve): boolean {
  if (sourceEffect(value, isNewExpression(value))) {
    return false;
  }
  if (isArrayLiteralExpression(value)) {
    return (
      !value.elements.some((each) => isSpreadElement(each)) &&
      value.elements.filter((each) => definedValue(each, resolve)).length >= 2
    );
  }
  if (!isNewExpression(value)) {
    return false;
  }
  const path = globalCalleePath(value.expression, resolve) ?? [];
  const [kind = ''] = path;
  return (
    path.length === 1 &&
    isTypedKind(kind) &&
    quietTypedInput(value, resolve) &&
    (typedOf(value, resolve, kind)?.length ?? 0) >= 2
  );
}

/** Constructing a typed array may coerce element objects before the comparator is selected. */
function quietTypedInput(value: Expression, resolve: Resolve): boolean {
  if (!isNewExpression(value)) {
    return false;
  }
  const first = value.arguments?.[0];
  if (first === undefined) {
    return true;
  }
  const input = writtenOf(first, resolve);
  return isArrayLiteralExpression(input)
    ? input.elements.every((element) => {
        return (
          isOmittedExpression(element) ||
          primitiveOf(writtenOf(element, resolve), resolve) !== undefined
        );
      })
    : primitiveOf(input, resolve) !== undefined;
}

/** A source element proved not to be undefined; holes and unknown values cannot force comparison. */
function definedValue(node: Expression, resolve: Resolve): boolean {
  if (isOmittedExpression(node) || isSpreadElement(node)) {
    return false;
  }
  const value = writtenOf(node, resolve);
  if (isVoidExpression(value) || (isIdentifier(value) && globalOf(value) === 'undefined')) {
    return false;
  }
  return (
    value.kind === SyntaxKind.NullKeyword ||
    primitiveOf(value, resolve) !== undefined ||
    constantValue(value, resolve) !== undefined ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value)
  );
}

/** Reads, calls and writes while creating the source can change its later callback or method. */
function sourceEffect(node: Node, construction = false): boolean {
  if (isClassExpression(node)) {
    return true;
  }
  if (runsLater(node)) {
    return false;
  }
  if (construction && isNewExpression(node)) {
    return (node.arguments ?? []).some((argument) => sourceEffect(argument));
  }
  return (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node) ||
    isTaggedTemplateExpression(node) ||
    conversionRunsCode(node) ||
    writtenBy(node) !== undefined ||
    node.forEachChild((child) => (sourceEffect(child) ? true : undefined)) === true
  );
}
