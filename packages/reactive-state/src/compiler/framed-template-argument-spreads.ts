import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isConditionalExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { isWrapper, outermost, peeled } from './framed-written-targets.ts';
import { isTypeOnly } from './scope.ts';

/**
 * Closed spread-argument and `.apply` operand unfolding for `arguments` taint analysis, following
 * array literals, conditional/logical branches, and local `const` bindings read only via spread.
 */

export const LOGICAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.QuestionQuestionToken,
]);

const CLOSED_SPREAD_CACHE = new WeakMap<VariableDeclaration, boolean>();
const EMPTY_SEEN: ReadonlySet<FrameDeclaration> = new Set();

export interface SpreadUnfold {
  readonly elements: readonly Expression[];
  readonly resolved: boolean;
}

interface SpreadStep {
  readonly expr: Expression;
  readonly seen: ReadonlySet<FrameDeclaration>;
  readonly spread: boolean;
}

/** Whole `const` bindings keep their initializer value throughout their scope. */
export function constantDeclaration(declared: VariableDeclaration): boolean {
  return (
    isIdentifier(declared.name) &&
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/** Whether `kind` is `=` or a compound assignment operator. */
export function isAssignmentOperator(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

/** Queues branch value operands of conditional, comma, assignment, and logical expressions. */
export function queueBranchExpressions(current: Expression, pending: Expression[]): boolean {
  if (isConditionalExpression(current)) {
    pending.push(current.whenTrue, current.whenFalse);
    return true;
  }
  if (!isBinaryExpression(current)) return false;
  const op = current.operatorToken.kind;
  if (op === SyntaxKind.CommaToken || op === SyntaxKind.EqualsToken) {
    pending.push(current.right);
    if (op === SyntaxKind.EqualsToken && isExpression(current.left)) pending.push(current.left);
    return true;
  }
  if (LOGICAL_OPERATORS.has(op)) {
    pending.push(current.left, current.right);
    return true;
  }
  return false;
}

/** Unfolds an `.apply` or `Reflect.construct` argument-list operand (`null`/`undefined` = empty). */
export function unfoldApplyOperand(expr: Expression, owner: Node): SpreadUnfold {
  const current = peeled(expr);
  if (
    current.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(current) &&
      current.text === 'undefined' &&
      frameDeclarationOf(current) === undefined)
  ) {
    return { elements: [], resolved: true };
  }
  return unfoldSpreadExpression(current, owner);
}

/** Unfolds a `...spread` operand into ordered positional expressions when statically closed. */
export function unfoldSpreadExpression(expr: Expression, owner: Node): SpreadUnfold {
  const elements: Expression[] = [];
  let resolved = true;
  const stack: SpreadStep[] = [{ expr, seen: EMPTY_SEEN, spread: true }];
  for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
    if (!step.spread) {
      elements.push(step.expr);
      continue;
    }
    if (!stepUnfoldSpread(peeled(step.expr), owner, step.seen, stack)) {
      resolved = false;
    }
  }
  return { elements, resolved };
}

function stepUnfoldSpread(
  current: Expression,
  owner: Node,
  seen: ReadonlySet<FrameDeclaration>,
  stack: SpreadStep[],
): boolean {
  if (isArrayLiteralExpression(current)) {
    pushArraySpreadSteps(current.elements, seen, stack);
    return true;
  }
  if (isStringLiteral(current) || isNoSubstitutionTemplateLiteral(current)) {
    return true;
  }
  if (isIdentifier(current)) {
    const local = closedLocalSpreadInitializer(current, owner, seen);
    if (local === undefined) return false;
    stack.push({ expr: local.expression, seen: local.nextSeen, spread: true });
    return true;
  }
  return pushBranchSpreadSteps(current, seen, stack);
}

function pushArraySpreadSteps(
  elements: readonly Expression[],
  seen: ReadonlySet<FrameDeclaration>,
  stack: SpreadStep[],
): void {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (element === undefined || isOmittedExpression(element)) continue;
    if (isSpreadElement(element)) {
      stack.push({ expr: element.expression, seen, spread: true });
    } else {
      stack.push({ expr: element, seen, spread: false });
    }
  }
}

function pushBranchSpreadSteps(
  current: Expression,
  seen: ReadonlySet<FrameDeclaration>,
  stack: SpreadStep[],
): boolean {
  if (isConditionalExpression(current)) {
    stack.push(
      { expr: current.whenFalse, seen, spread: true },
      { expr: current.whenTrue, seen, spread: true },
    );
    return true;
  }
  if (!isBinaryExpression(current)) return false;
  const op = current.operatorToken.kind;
  if (op === SyntaxKind.CommaToken || op === SyntaxKind.EqualsToken) {
    stack.push({ expr: current.right, seen, spread: true });
    return true;
  }
  if (LOGICAL_OPERATORS.has(op)) {
    stack.push(
      { expr: current.right, seen, spread: true },
      { expr: current.left, seen, spread: true },
    );
    return true;
  }
  return false;
}

function closedLocalSpreadInitializer(
  id: Identifier,
  owner: Node,
  seen: ReadonlySet<FrameDeclaration>,
):
  | { readonly expression: Expression; readonly nextSeen: ReadonlySet<FrameDeclaration> }
  | undefined {
  const decl = frameDeclarationOf(id);
  if (
    decl === undefined ||
    seen.has(decl) ||
    decl.pos < owner.pos ||
    decl.end > owner.end ||
    !isVariableDeclaration(decl) ||
    !constantDeclaration(decl) ||
    decl.initializer === undefined ||
    !isClosedSpreadOnlyBinding(decl, owner)
  ) {
    return undefined;
  }
  return { expression: decl.initializer, nextSeen: new Set([...seen, decl]) };
}

function isClosedSpreadOnlyBinding(decl: VariableDeclaration, owner: Node): boolean {
  const cached = CLOSED_SPREAD_CACHE.get(decl);
  if (cached !== undefined) return cached;
  const closed = checkClosedSpreadOnlyBinding(decl, owner);
  CLOSED_SPREAD_CACHE.set(decl, closed);
  return closed;
}

function checkClosedSpreadOnlyBinding(decl: VariableDeclaration, owner: Node): boolean {
  if (!isIdentifier(decl.name)) return false;
  const name = decl.name.text;
  const pending: Node[] = [owner];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      node !== decl.name &&
      node.text === name &&
      frameDeclarationOf(node) === decl &&
      !isReadOnlySpreadUse(node)
    ) {
      return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

function isReadOnlySpreadUse(id: Identifier): boolean {
  const parent = outermost(id).parent;
  return isSpreadElement(parent) && !inAssignmentTarget(parent);
}

function inAssignmentTarget(node: Node): boolean {
  let current: Node = node;
  for (;;) {
    const parent = current.parent;
    if (isBinaryExpression(parent) && isAssignmentOperator(parent.operatorToken.kind)) {
      return parent.left === current;
    }
    if (isForOfStatement(parent) || isForInStatement(parent)) {
      return parent.initializer === current;
    }
    if (!isAssignmentPatternContainer(current, parent)) return false;
    current = parent;
  }
}

function isAssignmentPatternContainer(child: Node, parent: Node): boolean {
  return (
    isWrapper(parent) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === child) ||
    (isShorthandPropertyAssignment(parent) && parent.name === child)
  );
}
