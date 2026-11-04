import {
  type CallExpression,
  type Expression,
  isBlock,
  isCallExpression,
  isSourceFile,
  type Node,
} from 'typescript/ast';

import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { globalPath } from './global-answers.ts';

/** A borrowed native Promise then rejects a shown receiver with no Promise internal slots. */
export function promiseReceiverThrows(callee: Expression, kind: string | undefined): boolean {
  if (kind === undefined || kind === 'new Promise') {
    return false;
  }
  const call = sourceCall(callee);
  if (call === undefined || earlierExpressionEffect(call)) {
    return false;
  }
  const reflected = globalPath(call.expression)?.join('.') === 'Reflect.apply';
  const given = reflected ? call.arguments.slice(1) : call.arguments;
  if (given.some((argument) => callbackCreationEffect(argument))) {
    return false;
  }
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Borrowed normalization keeps the actual invocation in the selected callee's source ancestors. */
function sourceCall(node: Node): CallExpression | undefined {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (isCallExpression(each)) {
      return each;
    }
  }
  return undefined;
}
