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
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { readsBinding } from './scope.ts';
import { isTypeSyntax } from './type-syntax.ts';

/** Cached unmutated constant tuple-spread resolution shared across call-argument analyses. */

const NON_SPREAD_DECLARATIONS = new WeakMap<SourceFile, ReadonlySet<Node>>();

/** An inline array literal, or a const array literal read exclusively as a spread operand. */
export function unmutatedTuple(expression: Expression): ArrayLiteralExpression | undefined {
  const value = unwrapped(expression);
  if (isArrayLiteralExpression(value)) {
    return value;
  }
  const initial = spreadOnlyInitializer(value);
  return initial !== undefined && isArrayLiteralExpression(initial) ? initial : undefined;
}

/** Initializer of a whole-identifier `const` declaration read exclusively as a spread operand. */
export function spreadOnlyInitializer(expression: Expression): Expression | undefined {
  const value = unwrapped(expression);
  const declared = isIdentifier(value) ? constVariableDeclaration(value) : undefined;
  return declared?.initializer !== undefined &&
    !nonSpreadDeclarationsIn(declared.getSourceFile()).has(declared)
    ? unwrapped(declared.initializer)
    : undefined;
}

/** Initializer of a whole-identifier `const` declaration, or none when mutable or destructured. */
export function constInitializerOf(name: Identifier): Expression | undefined {
  return constVariableDeclaration(name)?.initializer;
}

/** Follows whole-identifier `const` initializers without crossing `let`, `var` or patterns. */
export function constFollowedValue(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const initial = constInitializerOf(value);
    if (initial === undefined) {
      break;
    }
    value = unwrapped(initial);
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

/** Indexes declarations referenced outside a spread operand once per `file`. */
function nonSpreadDeclarationsIn(file: SourceFile): ReadonlySet<Node> {
  const cached = NON_SPREAD_DECLARATIONS.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const nonSpread = new Set<Node>();
  const pending: Node[] = [file];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (isTypeSyntax(current)) {
      continue;
    }
    recordNonSpreadReference(current, nonSpread);
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  NON_SPREAD_DECLARATIONS.set(file, nonSpread);
  return nonSpread;
}

/** Marks `node`'s resolved declaration when `node` references a binding outside `...node`. */
function recordNonSpreadReference(node: Node, nonSpread: Set<Node>): void {
  if (
    !isIdentifier(node) ||
    isOwnVariableName(node) ||
    !readsBinding(node) ||
    isSpreadOperand(node)
  ) {
    return;
  }
  const declared = frameDeclarationOf(node);
  if (declared !== undefined) {
    nonSpread.add(declared);
  }
}

/** Whether `node` is the bound identifier of its enclosing `VariableDeclaration`. */
function isOwnVariableName(node: Identifier): boolean {
  return isVariableDeclaration(node.parent) && node.parent.name === node;
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
