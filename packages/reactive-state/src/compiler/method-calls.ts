import {
  type ElementAccessExpression,
  isAsExpression,
  isCallExpression,
  isElementAccessExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isTypeAssertion,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from 'typescript/ast';

import { literal, type Rewrite, textOf } from './splice.ts';

/** A member read as a call's callee, through wrappers that preserve its receiver. */
export function isMethodCallee(
  node: Node,
): node is ElementAccessExpression | PropertyAccessExpression {
  return (
    (isPropertyAccessExpression(node) || isElementAccessExpression(node)) && isCalledValue(node)
  );
}

/** Whether a value is a call's callee through parentheses, casts and non-null assertions. */
export function isCalledValue(node: Node): boolean {
  let value: Node = node;
  for (;;) {
    const { parent } = value;
    if (
      (isParenthesizedExpression(parent) ||
        isNonNullExpression(parent) ||
        isAsExpression(parent) ||
        isSatisfiesExpression(parent) ||
        isTypeAssertion(parent)) &&
      parent.expression === value
    ) {
      value = parent;
      continue;
    }
    return isCallExpression(parent) && parent.expression === value;
  }
}

/** The key captured with a method receiver before evaluating any call arguments. */
export function methodKey(
  node: Node,
  sourceFile: SourceFile,
  rewrite: Rewrite,
): string | undefined {
  if (!isMethodCallee(node)) {
    return undefined;
  }
  return isPropertyAccessExpression(node)
    ? literal(node.name.text)
    : textOf(node.argumentExpression, sourceFile, rewrite);
}
