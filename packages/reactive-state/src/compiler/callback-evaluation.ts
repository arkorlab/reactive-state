import {
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isNewExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isTaggedTemplateExpression,
  type Node,
  type PropertyName,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { skipsEvaluation } from './skipped-evaluation.ts';
import { conversionRunsCode } from './throw-coercions.ts';
import { primitiveOf } from './throw-shapes.ts';
import { writtenBy } from './written.ts';

/** Earlier expressions in the same statement can change an intrinsic before a callback uses it. */
export function earlierExpressionEffect(node: Node): boolean {
  for (let each = node; ; each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) ||
      isSourceFile(parent) ||
      isAnswering(parent) ||
      isConstructorDeclaration(parent)
    ) {
      return false;
    }
    const status = { effect: false };
    parent.forEachChild((part) => {
      if (part.end <= each.pos && callbackCreationEffect(part)) {
        status.effect = true;
      }
    });
    if (status.effect) {
      return true;
    }
  }
}

/** Deferred bodies are quiet; other calls, reads, writes and conversions may run application code. */
export function callbackCreationEffect(node: Node): boolean {
  const pending = [node];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    // No caller resolver is applied to names inside a nested lexical scope.
    if (skipsEvaluation(each, undefined)) {
      continue;
    }
    if (isAnswering(each)) {
      const key = computedMethodName(each);
      if (key !== undefined) {
        pending.push(key);
      }
      continue;
    }
    if (
      isCallExpression(each) ||
      isNewExpression(each) ||
      isPropertyAccessExpression(each) ||
      isElementAccessExpression(each) ||
      isTaggedTemplateExpression(each) ||
      isClassDeclaration(each) ||
      isClassExpression(each) ||
      conversionRunsCode(each) ||
      writtenBy(each) !== undefined ||
      (isComputedPropertyName(each) && primitiveOf(each.expression, undefined) === undefined)
    ) {
      return true;
    }
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Only methods and accessors evaluate computed names while their bodies remain deferred. */
function computedMethodName(fn: Answering): PropertyName | undefined {
  if (!isMethodDeclaration(fn) && !isGetAccessorDeclaration(fn)) {
    return undefined;
  }
  return isComputedPropertyName(fn.name) ? fn.name : undefined;
}
