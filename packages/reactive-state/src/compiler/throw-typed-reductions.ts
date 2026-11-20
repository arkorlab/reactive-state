import {
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isIdentifier,
  isNewExpression,
  isSourceFile,
  isSpreadElement,
  isVariableStatement,
  type NewExpression,
  type Node,
  type Statement,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { calledMember, unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { isTypedKind, typedOf, writtenOf } from './throw-shapes.ts';

/** Whether a native typed-array reduction is empty and is given no initial accumulator. */
export function emptyTypedReductionThrows(node: Node, outer: Resolve | undefined): boolean {
  if (
    !isCallExpression(node) ||
    node.arguments.length > 1 ||
    node.arguments.some((each) => isSpreadElement(each) || callbackCreationEffect(each)) ||
    earlierExpressionEffect(node)
  ) {
    return false;
  }
  const member = calledMember(unwrapped(node.expression));
  if (member === undefined || (member.name !== 'reduce' && member.name !== 'reduceRight')) {
    return false;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const receiver = writtenOf(member.of, resolve);
  return (
    isNewExpression(receiver) &&
    !calleeUncertain(receiver, node) &&
    emptyTypedArray(receiver, resolve) &&
    !priorStatementEffect(node, receiver)
  );
}

/** A known empty native construction with no source evaluation that can replace its method. */
function emptyTypedArray(value: NewExpression, resolve: Resolve): boolean {
  const path = globalCalleePath(value.expression, resolve) ?? [];
  const [kind = ''] = path;
  if (
    path.length !== 1 ||
    !isTypedKind(kind) ||
    value.arguments?.some(
      (argument) =>
        isSpreadElement(argument) || callbackCreationEffect(writtenOf(argument, resolve)),
    ) === true
  ) {
    return false;
  }
  const first = value.arguments?.[0];
  if (first !== undefined) {
    const source = writtenOf(first, resolve);
    if (isArrayLiteralExpression(source) && calleeUncertain(source, value)) {
      return false;
    }
  }
  return typedOf(value, resolve, kind)?.length === 0;
}

/** The receiver's own quiet construction is allowed; other earlier effects leave methods unknown. */
function priorStatementEffect(node: Node, receiver: NewExpression): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && statementEffect(statement, receiver),
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

/** Other declarations can run application code, including declarations alongside the receiver. */
function statementEffect(statement: Statement, receiver: Expression): boolean {
  if (!isVariableStatement(statement)) {
    return callbackCreationEffect(statement);
  }
  return statement.declarationList.declarations.some((declaration) => {
    return (
      (!isIdentifier(declaration.name) ||
        declaration.initializer === undefined ||
        unwrapped(declaration.initializer) !== receiver) &&
      callbackCreationEffect(declaration)
    );
  });
}
