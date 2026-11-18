import {
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameDeclarationOf } from './framed-bindings.ts';

/** What a function's own code, closures included, writes into one of its parameters. */

/**
 * The values plain assignments of a parameter may give it; whether another write — a compound
 * assignment, `++` or `--`, a pattern, a loop head — may change it otherwise; and the one plain
 * assignment that certainly runs before `point`, a statement of the function's own body ahead of
 * it, where it is the only write.
 */
export interface ParameterWrites {
  readonly values: readonly Expression[];
  readonly unknown: boolean;
  readonly definite: Expression | undefined;
}

/** Expressions a written target may stand in and still be written: wrappers and patterns. */
const CONTAINERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AsExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.TypeAssertionExpression,
]);

/**
 * Every write of a function's parameter in its own code, nested functions included: the code of its
 * parameters (their initializers, and the defaults and computed keys of their patterns) as well as
 * its body.
 */
export function framedParameterWrites(
  fn: Answering,
  parameter: ParameterDeclaration,
  point: Node,
): ParameterWrites {
  const values: Expression[] = [];
  const writes: Node[] = [];
  let unknown = false;
  const pending: Node[] = [...fn.parameters];
  if (fn.body !== undefined) pending.push(fn.body);
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    node.forEachChild((child) => {
      pending.push(child);
    });
    if (!isIdentifier(node) || frameDeclarationOf(node) !== parameter) continue;
    const written = writeOf(node);
    if (written === undefined) continue;
    writes.push(written.node);
    if (written.value === undefined) unknown = true;
    else values.push(written.value);
  }
  const [only] = writes;
  const sole = only !== undefined && writes.length === 1 && !unknown;
  const definite = sole && aheadOf(only, fn, point) ? values[0] : undefined;
  return { definite, unknown, values };
}

/** The write a parameter's reference takes part in: a plain assignment's value, or none read. */
function writeOf(
  name: Node,
): { readonly node: Node; readonly value: Expression | undefined } | undefined {
  let target = name;
  while (container(target)) target = target.parent;
  const { parent } = target;
  if (isBinaryExpression(parent) && parent.left === target) {
    const kind = parent.operatorToken.kind;
    if (kind < SyntaxKind.FirstAssignment || kind > SyntaxKind.LastAssignment) return undefined;
    const direct = target === name && kind === SyntaxKind.EqualsToken && !patternDefault(parent);
    return { node: parent, value: direct ? parent.right : undefined };
  }
  if (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  )
    return { node: parent, value: undefined };
  return (isForInStatement(parent) || isForOfStatement(parent)) && parent.initializer === target
    ? { node: parent, value: undefined }
    : undefined;
}

/**
 * Whether an assignment is a default of a pattern that assigns (`[target = {}] = source`, `({ key:
 * target = {} } = source)`, a loop head's): the pattern gives the target what its source holds, and
 * the default only where that is `undefined`, so what it writes is not the one value the target takes.
 */
function patternDefault(assignment: Node): boolean {
  let outer = assignment;
  while (container(outer)) outer = outer.parent;
  const { parent } = outer;
  if (outer === assignment) return false;
  return isBinaryExpression(parent)
    ? parent.left === outer && parent.operatorToken.kind === SyntaxKind.EqualsToken
    : (isForInStatement(parent) || isForOfStatement(parent)) && parent.initializer === outer;
}

/** Whether a written target stands inside an expression or pattern that still assigns it. */
function container(target: Node): boolean {
  const { parent } = target;
  return (
    (CONTAINERS.has(parent.kind) && 'expression' in parent && parent.expression === target) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === target) ||
    (isShorthandPropertyAssignment(parent) && parent.name === target)
  );
}

/** A statement of the function's own body ahead of the one that holds `point`. */
function aheadOf(write: Node, fn: Answering, point: Node): boolean {
  const { body } = fn;
  const statement = write.parent;
  if (body === undefined || !isBlock(body) || !isExpressionStatement(statement)) return false;
  if (statement.parent !== body || executionOwner(point) !== fn) return false;
  for (let at: Node = point; at !== body; at = at.parent) {
    if (at.parent === body) return statement.pos < at.pos;
  }
  return false;
}
