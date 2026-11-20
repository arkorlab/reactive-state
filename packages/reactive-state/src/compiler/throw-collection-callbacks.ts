import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isClassExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  isVariableStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { calledMember, unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { runsLater } from './deferred-syntax.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { callbackResultThrows } from './throw-callback-results.ts';
import { globalCalleePath } from './throw-callees.ts';
import { conversionRunsCode } from './throw-coercions.ts';
import { isTypedKind, primitiveOf, typedOf, writtenOf } from './throw-shapes.ts';
import { writtenBy } from './written.ts';

/** A source callback invoked by native forEach on a collection proven to retain an element. */
export function collectionCallback(node: Node, resolve: Resolve | undefined): Node | undefined {
  if (!isCallExpression(node) || node.arguments.some((each) => !quietArgument(each))) {
    return undefined;
  }
  const member = calledMember(unwrapped(node.expression));
  const [given] = node.arguments;
  if (given === undefined || member?.name !== 'forEach') {
    return undefined;
  }
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const value = writtenOf(member.of, follow);
  if (
    !isNewExpression(value) ||
    calleeUncertain(value, node) ||
    !nonemptyCollection(value, follow)
  ) {
    return undefined;
  }
  const fn = writtenOf(given, follow);
  return calleeUncertain(fn, given) ? undefined : fn;
}

/** A necessarily invoked native typed-array mapper whose simple result cannot become an element. */
export function typedMapResultThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (
    !isCallExpression(node) ||
    node.arguments.some((each) => !quietArgument(each)) ||
    earlierExpressionEffect(node)
  ) {
    return false;
  }
  const member = calledMember(unwrapped(node.expression));
  const [given] = node.arguments;
  if (given === undefined || member?.name !== 'map') {
    return false;
  }
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const value = writtenOf(member.of, follow);
  if (
    !isNewExpression(value) ||
    calleeUncertain(value, node) ||
    !nonemptyCollection(value, follow) ||
    !quietTypedInput(value, follow) ||
    priorMapEffect(node, value, follow)
  ) {
    return false;
  }
  const [kind = ''] = globalCalleePath(value.expression, follow) ?? [];
  const fn = writtenOf(given, follow);
  return (
    isTypedKind(kind) &&
    isAnswering(fn) &&
    callbackResultThrows(
      fn,
      kind === 'BigInt64Array' || kind === 'BigUint64Array' ? 'bigint' : 'number',
      undefined,
    )
  );
}

/** Native construction converts source elements before map; object coercion can repair its mapper. */
function quietTypedInput(value: Expression, resolve: Resolve): boolean {
  const [input] = isNewExpression(value) ? (value.arguments ?? []) : [];
  if (input === undefined) {
    return false;
  }
  const source = writtenOf(input, resolve);
  const elements = isArrayLiteralExpression(source) ? source.elements : [source];
  return elements.every((each) => {
    const element = writtenOf(each, resolve);
    return (
      isOmittedExpression(element) ||
      primitiveOf(element, resolve) !== undefined ||
      isBigIntWritten(element, resolve)
    );
  });
}

/** Prior work may replace the native method, species or a callback's primitive-producing intrinsic. */
function priorMapEffect(call: CallExpression, receiver: Expression, resolve: Resolve): boolean {
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some((statement) => {
        if (statement.end > each.pos) {
          return false;
        }
        if (!isVariableStatement(statement)) {
          return callbackCreationEffect(statement);
        }
        return statement.declarationList.declarations.some((declaration) => {
          const source = declaration.initializer;
          return (
            (source === undefined || writtenOf(source, resolve) !== receiver) &&
            callbackCreationEffect(declaration)
          );
        });
      })
    ) {
      return true;
    }
  }
  return false;
}

/** A written native constructor's nonempty input or typed-array length, without source effects. */
function nonemptyCollection(value: Expression, resolve: Resolve): boolean {
  if (!isNewExpression(value) || value.arguments?.some((each) => isSpreadElement(each)) === true) {
    return false;
  }
  const path = globalCalleePath(value.expression, resolve) ?? [];
  const [kind = ''] = path;
  if (path.length !== 1 || (kind !== 'Set' && kind !== 'Map' && !isTypedKind(kind))) {
    return false;
  }
  if ((value.arguments ?? []).some((argument) => sourceEffect(writtenOf(argument, resolve)))) {
    return false;
  }
  if (isTypedKind(kind)) {
    return (typedOf(value, resolve, kind)?.length ?? 0) >= 1;
  }
  const [argument] = value.arguments ?? [];
  if (argument === undefined) {
    return false;
  }
  const source = writtenOf(argument, resolve);
  return (
    isArrayLiteralExpression(source) &&
    !calleeUncertain(source, value) &&
    source.elements.length > 0 &&
    !source.elements.some((each) => isSpreadElement(each))
  );
}

/** Creating a callback or reading a primitive/name cannot clear the already evaluated collection. */
function quietArgument(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isIdentifier(value) ||
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword
  );
}

/** Source creation that can replace a method, mapper or collection input remains unproven. */
function sourceEffect(node: Node): boolean {
  if (isClassExpression(node)) {
    return true;
  }
  if (runsLater(node)) {
    return false;
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
