import {
  type Expression,
  isBigIntLiteral,
  isBreakStatement,
  isCaseClause,
  isContinueStatement,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isReturnStatement,
  isStringLiteral,
  isThrowStatement,
  type Node,
  type Statement,
  type SwitchStatement,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf } from './bounded.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { runsLater } from './deferred-syntax.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { writtenOf } from './throw-shapes.ts';

type Scalar = bigint | boolean | number | string | null | undefined;
interface Known {
  readonly value: Scalar;
}
interface Plan {
  readonly checked: readonly Expression[];
  readonly statements: readonly Statement[] | undefined;
}

/** The tests necessarily evaluated by a switch and its source-selected fallthrough statements. */
export function switchPlan(node: SwitchStatement, resolve: Resolve | undefined): Plan {
  const checked: Expression[] = [node.expression];
  const clauses = node.caseBlock.clauses;
  const follow: Resolve = (name) => {
    const held = resolve?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, name) ? undefined : held;
  };
  const selected = scalarOf(node.expression, follow);
  if (selected === undefined) {
    const first = clauses.find((clause) => isCaseClause(clause));
    if (first !== undefined && isCaseClause(first)) {
      checked.push(first.expression);
    }
    return { checked, statements: undefined };
  }
  let fallback: number | undefined;
  for (const [index, clause] of clauses.entries()) {
    if (!isCaseClause(clause)) {
      fallback = index;
      continue;
    }
    checked.push(clause.expression);
    const test = scalarOf(clause.expression, follow);
    if (test === undefined) {
      return { checked, statements: undefined };
    }
    if (selected.value === test.value) {
      return { checked, statements: selectedStatements(clauses, index) };
    }
  }
  return {
    checked,
    statements: fallback === undefined ? [] : selectedStatements(clauses, fallback),
  };
}

/** Break belongs to this switch only when direct and unlabeled; other loop exits stay opaque. */
function selectedStatements(
  clauses: SwitchStatement['caseBlock']['clauses'],
  from: number,
): readonly Statement[] | undefined {
  const statements: Statement[] = [];
  for (const clause of clauses.slice(from)) {
    for (const statement of clause.statements) {
      if (isBreakStatement(statement) && statement.label === undefined) {
        return statements;
      }
      if (hasExit(statement)) {
        return undefined;
      }
      statements.push(statement);
      if (isReturnStatement(statement) || isThrowStatement(statement)) {
        return statements;
      }
    }
  }
  return statements;
}

/** Nested and labeled exits cannot be treated as a function return or a direct switch break. */
function hasExit(node: Node): boolean {
  const pending = [node];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (runsLater(each)) {
      continue;
    }
    if (isBreakStatement(each) || isContinueStatement(each)) {
      return true;
    }
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Only literal scalar syntax and unchanged aliases choose a clause, without running conversions. */
function scalarOf(node: Expression, resolve: Resolve): Known | undefined {
  const signs: SyntaxKind[] = [];
  const seen = new Set<Expression>();
  let value = writtenOf(node, resolve);
  while (isPrefixUnaryExpression(value)) {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    signs.push(value.operator);
    value = writtenOf(value.operand, resolve);
  }
  let known = literalOf(value);
  for (const sign of signs.toReversed()) {
    known = known === undefined ? undefined : signed(known.value, sign);
  }
  return known;
}

/** A literal's exact primitive, preserving strict type distinctions and NaN's non-equality. */
function literalOf(node: Expression): Known | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return { value: node.text };
  }
  if (isNumericLiteral(node)) {
    return { value: Number(node.text) };
  }
  if (isBigIntLiteral(node)) {
    return { value: BigInt(node.getText().replaceAll('_', '').slice(0, -1)) };
  }
  if (node.kind === SyntaxKind.TrueKeyword || node.kind === SyntaxKind.FalseKeyword) {
    return { value: node.kind === SyntaxKind.TrueKeyword };
  }
  if (node.kind === SyntaxKind.NullKeyword) {
    return { value: null };
  }
  return isIdentifier(node) ? globalScalar(globalOf(node)) : undefined;
}

/** Stable language scalar constants; shadowed names have no global identity. */
function globalScalar(name: string | undefined): Known | undefined {
  if (name === 'undefined') {
    return { value: undefined };
  }
  if (name === 'NaN') {
    return { value: NaN };
  }
  return name === 'Infinity' ? { value: Infinity } : undefined;
}

/** Numeric signs alone preserve source certainty without converting text or application objects. */
function signed(value: Scalar, sign: SyntaxKind): Known | undefined {
  if (sign === SyntaxKind.MinusToken && (typeof value === 'number' || typeof value === 'bigint')) {
    return { value: -value };
  }
  return typeof value === 'number' && sign === SyntaxKind.PlusToken ? { value } : undefined;
}
