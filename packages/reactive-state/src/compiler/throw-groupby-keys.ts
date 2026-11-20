import {
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isReturnStatement,
  isSourceFile,
  isSpreadElement,
  isStringLiteral,
  type Node,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering, parametersOf } from './answers.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataCallee, metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { hasNoConversion } from './throw-keys.ts';
import { writtenOf } from './throw-shapes.ts';

/** A necessarily invoked Object.groupBy callback whose result has no property-key conversion. */
export function groupingKeyResultThrows(node: Node, outer: Resolve | undefined): boolean {
  if (
    !isCallExpression(node) ||
    node.arguments.length !== 2 ||
    node.arguments.some(
      (argument) => isSpreadElement(argument) || callbackCreationEffect(argument),
    ) ||
    earlierExpressionEffect(node) ||
    priorEffect(node)
  ) {
    return false;
  }
  const follow: Resolve = (name) => {
    const held = outer?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, node) ? undefined : held;
  };
  if (globalCalleePath(node.expression, follow)?.join('.') !== 'Object.groupBy') {
    return false;
  }
  const [input, callback] = node.arguments;
  if (input === undefined || callback === undefined) {
    return false;
  }
  const source = writtenOf(input, follow);
  const value = writtenOf(callback, follow);
  const fn = metadataCallee(value) ?? value;
  if (
    !nonemptySource(source) ||
    callbackCreationEffect(source) ||
    calleeUncertain(source, node) ||
    calleeUncertain(value, node) ||
    !isAnswering(fn)
  ) {
    return false;
  }
  const result = simpleResult(fn);
  // The callback's lexical bindings never inherit the consumer's parameter resolver.
  return result !== undefined && hasNoConversion(result, metadataInitializer);
}

/** Array iteration visits holes, and nonempty literal text supplies at least one code point. */
function nonemptySource(node: Expression): boolean {
  if (isArrayLiteralExpression(node)) {
    return node.elements.length > 0 && !node.elements.some((element) => isSpreadElement(element));
  }
  return (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) && node.text.length > 0;
}

/** A single synchronous result with no parameter initialization or preceding body effects. */
function simpleResult(fn: Answering): Expression | undefined {
  if (
    answersLater(fn) ||
    fn.body === undefined ||
    parametersOf(fn).some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  ) {
    return undefined;
  }
  if (!isBlock(fn.body)) {
    return fn.body;
  }
  const [only] = fn.body.statements;
  return only !== undefined && fn.body.statements.length === 1 && isReturnStatement(only)
    ? only.expression
    : undefined;
}

/** Earlier application work can replace the consumer or a conversion maker used by its callback. */
function priorEffect(node: Node): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return true;
    }
    if (isAnswering(parent) || isConstructorDeclaration(parent)) {
      break;
    }
  }
  return false;
}
