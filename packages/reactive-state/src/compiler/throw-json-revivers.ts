import {
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isSourceFile,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataCallee, metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { writtenOf } from './throw-shapes.ts';

/** A synchronous source reviver that native JSON.parse necessarily invokes for its parsed root. */
export function jsonReviverFunction(node: Node, outer: Resolve | undefined): Node | undefined {
  if (
    !isCallExpression(node) ||
    node.arguments.some(
      (argument) => isSpreadElement(argument) || callbackCreationEffect(argument),
    ) ||
    earlierExpressionEffect(node) ||
    priorEffect(node)
  ) {
    return undefined;
  }
  const follow: Resolve = (name) => {
    const held = outer?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, node) ? undefined : held;
  };
  const [input, reviver] = node.arguments;
  if (
    input === undefined ||
    reviver === undefined ||
    globalCalleePath(node.expression, follow)?.join('.') !== 'JSON.parse'
  ) {
    return undefined;
  }
  const value = writtenOf(reviver, follow);
  const fn = metadataCallee(value) ?? value;
  return isAnswering(fn) ? fn : undefined;
}

/** Earlier application evaluation can replace the native parser or the callback selected by it. */
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
