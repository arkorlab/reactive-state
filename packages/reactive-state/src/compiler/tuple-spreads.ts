import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isIdentifier,
  isNonNullExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { readsBinding } from './scope.ts';
import { isTypeSyntax } from './type-syntax.ts';

/** Unmutated constant tuple-spread resolution shared across call-argument analyses. */

/** An inline array literal, or a const array literal read exclusively as a spread operand. */
export function unmutatedTuple(expression: Expression): ArrayLiteralExpression | undefined {
  const value = unwrapped(expression);
  if (isArrayLiteralExpression(value)) {
    return value;
  }
  const declared = isIdentifier(value) ? constVariableDeclaration(value) : undefined;
  if (
    declared === undefined ||
    declared.initializer === undefined ||
    !isIdentifier(declared.name)
  ) {
    return undefined;
  }
  const initial = unwrapped(declared.initializer);
  return isArrayLiteralExpression(initial) && spreadOnlyReads(declared, declared.name)
    ? initial
    : undefined;
}

/** Follows whole-identifier `const` initializers without crossing `let`, `var` or patterns. */
export function constFollowedValue(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = constVariableDeclaration(value);
    if (declared?.initializer === undefined) {
      break;
    }
    value = unwrapped(declared.initializer);
  }
  return value;
}

/** The whole-identifier `const` declaration `name` resolves to, or none when mutable. */
function constVariableDeclaration(name: Identifier): VariableDeclaration | undefined {
  const declared = frameDeclarationOf(name);
  return declared !== undefined &&
    isVariableDeclaration(declared) &&
    isIdentifier(declared.name) &&
    isVariableDeclarationList(declared.parent) &&
    /^const\b/u.test(declared.parent.getText(declared.getSourceFile()))
    ? declared
    : undefined;
}

/** Whether every runtime binding reference to `declared` in its file is a spread operand. */
function spreadOnlyReads(declared: Node, boundName: Identifier): boolean {
  const pending: Node[] = [declared.getSourceFile()];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (isTypeSyntax(current)) {
      continue;
    }
    if (
      current !== boundName &&
      isIdentifier(current) &&
      current.text === boundName.text &&
      readsBinding(current) &&
      frameDeclarationOf(current) === declared &&
      !isSpreadOperand(current)
    ) {
      return false;
    }
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Whether `node` (past parentheses and type wrappers) is the direct operand of `...node`. */
function isSpreadOperand(node: Node): boolean {
  let current = node;
  while (isTransparentWrapper(current.parent) && current.parent.expression === current) {
    current = current.parent;
  }
  return isSpreadElement(current.parent) && current.parent.expression === current;
}

/** Parentheses, casts, satisfies and non-null assertions preserve the spread operand. */
function isTransparentWrapper(node: Node): node is Node & { readonly expression: Expression } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node)
  );
}
