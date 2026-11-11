import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isComputedPropertyName,
  isFunctionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  NodeFlags,
  SyntaxKind,
  type VariableStatement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/** Initializations that may be omitted without skipping calls, coercions or property reads. */
const INERT: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.OmittedExpression,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

/**
 * Whether leaving a statement out skips only values whose construction runs no application code.
 * A `using` or an `await using` is more than its value: it reads the resource's disposal method and
 * registers a cleanup its scope runs, which only its whole behavior could show inert, so it stays.
 */
export function canOmit(statement: VariableStatement): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript says `using` and `await using` in this flag.
  if ((statement.declarationList.flags & NodeFlags.Using) !== 0) {
    return false;
  }
  return statement.declarationList.declarations.every((declaration) => {
    return (
      isIdentifier(declaration.name) &&
      declaration.initializer !== undefined &&
      inertValue(declaration.initializer)
    );
  });
}

/** A literal, alias or data container whose evaluation does not call or coerce another value. */
function inertValue(expression: Expression): boolean {
  const pending = [expression];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const children = inertChildren(unwrapped(next));
    if (children === undefined) {
      return false;
    }
    pending.push(...children);
  }
  return true;
}

/** The values an inert expression evaluates; none where another evaluation must be preserved. */
function inertChildren(value: Expression): readonly Expression[] | undefined {
  if (
    INERT.has(value.kind) ||
    isIdentifier(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value)
  ) {
    return [];
  }
  if (isArrayLiteralExpression(value)) {
    return value.elements;
  }
  if (!isObjectLiteralExpression(value)) {
    return undefined;
  }
  const values: Expression[] = [];
  for (const property of value.properties) {
    if (!isPropertyAssignment(property) || isComputedPropertyName(property.name)) {
      return undefined;
    }
    values.push(property.initializer);
  }
  return values;
}
