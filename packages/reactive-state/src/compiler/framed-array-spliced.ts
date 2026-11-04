import {
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isArrowFunction,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isSetAccessorDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isStringLiteral,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { constantValue } from './numbers.ts';

/** Native toSpliced copies keep each retained source slot and each inserted argument identity. */
interface Range {
  readonly length: number;
  readonly start: number;
  readonly deleted: number;
}

/** Quiet exact bounds preserve copy ranges; evaluated inputs retain every possible source and insertion. */
export function splicedArrayViews(
  receiver: Expression,
  given: readonly Expression[],
  index: number | undefined,
  stable: boolean,
): readonly ArrayElementView[] {
  const at = stable && index !== undefined && index >= 0 ? index : undefined;
  const inserted = given.slice(2);
  if (given.length === 0) return [{ value: receiver, index: at }];
  const quiet = quietArguments(given);
  const start = integer(given[0]);
  const deleted = given.length === 1 ? Infinity : integer(given[1]);
  if (quiet && start === 0 && deleted === Infinity) return insertedViews(inserted, at);
  const length = stable && quiet ? literalLength(receiver) : undefined;
  const range = selectedRange(length, start, deleted);
  if (range === undefined)
    return [{ value: receiver, index: undefined }, ...insertedViews(inserted, undefined)];
  return rangedViews(receiver, inserted, at, range);
}

/** Fixed native bounds clamp to the written source length before mapping result positions. */
function selectedRange(
  length: number | undefined,
  start: number | undefined,
  deleted: number | undefined,
): Range | undefined {
  if (length === undefined || start === undefined || deleted === undefined) return undefined;
  const offset = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
  return { length, start: offset, deleted: Math.min(Math.max(deleted, 0), length - offset) };
}

/** A result index selects its original prefix, one insertion or its shifted original suffix. */
function rangedViews(
  receiver: Expression,
  inserted: readonly Expression[],
  index: number | undefined,
  range: Range,
): readonly ArrayElementView[] {
  const { length, start, deleted } = range;
  if (index !== undefined) {
    if (index >= length - deleted + inserted.length) return [];
    if (index < start) return [{ value: receiver, index }];
    if (index < start + inserted.length) return insertedViews(inserted, index - start);
    return [{ value: receiver, index: index - inserted.length + deleted }];
  }
  const views: ArrayElementView[] = [...insertedViews(inserted, undefined)];
  if (start > 0) views.push({ value: receiver, index: undefined, start: 0, end: start });
  if (start + deleted < length)
    views.push({ value: receiver, index: undefined, start: start + deleted, end: length });
  return views;
}

/** Inserted values are elements themselves, rather than arrays whose contents are flattened. */
function insertedViews(
  inserted: readonly Expression[],
  index: number | undefined,
): readonly ArrayElementView[] {
  const values = index === undefined ? inserted : inserted.slice(index, index + 1);
  return values.map((value) => ({ value, index: undefined, element: true }));
}

/** Whole unchanged literal-array aliases retain their source length without guessing spread widths. */
function literalLength(node: Expression): number | undefined {
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const initializer = constantInitializer(value);
    if (initializer === undefined) return undefined;
    value = unwrapped(initializer);
  }
  return isArrayLiteralExpression(value) && !value.elements.some((each) => isSpreadElement(each))
    ? value.elements.length
    : undefined;
}

/** Native numeric bounds accept primitive constants without invoking application conversion hooks. */
function integer(node: Expression | undefined): number | undefined {
  if (node === undefined) return 0;
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const path = globalPathOf(value)?.join('.');
    if (path === 'undefined' || path === 'NaN') return 0;
    if (path === 'Infinity') return Infinity;
    const initial = constantInitializer(value);
    if (initial === undefined) return undefined;
    value = unwrapped(initial);
  }
  if (value.kind === SyntaxKind.NullKeyword || value.kind === SyntaxKind.FalseKeyword) return 0;
  if (value.kind === SyntaxKind.TrueKeyword) return 1;
  const fixed = literalNumber(value);
  return fixed === undefined ? undefined : Math.trunc(fixed) || 0;
}

/** A syntax-only gate excludes all calls before the existing primitive constant evaluator runs. */
function literalNumber(value: Expression): number | undefined {
  if (!writtenConstant(value)) return undefined;
  const fixed = constantValue(value, constantInitializer);
  return fixed === undefined ? undefined : Number(fixed);
}

/** Literal arithmetic and immutable primitive aliases perform no application conversion. */
function writtenConstant(node: Expression): boolean {
  const pending = [node];
  const seen = new Set<Node>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const value = unwrapped(current);
    if (seen.has(value)) continue;
    seen.add(value);
    if (isNumericLiteral(value) || isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value))
      continue;
    const path = globalPathOf(value)?.join('.');
    if (path === 'Infinity' || path === 'NaN' || path?.startsWith('Number.') === true) continue;
    const children = constantChildren(value);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** Only whole aliases and primitive arithmetic operands are evaluated as constant syntax. */
function constantChildren(value: Expression): readonly Expression[] | undefined {
  if (isIdentifier(value)) {
    const initial = constantInitializer(value);
    return initial === undefined ? undefined : [initial];
  }
  if (isPrefixUnaryExpression(value))
    return [SyntaxKind.MinusToken, SyntaxKind.PlusToken].includes(value.operator)
      ? [value.operand]
      : undefined;
  return isBinaryExpression(value) &&
    [
      SyntaxKind.AsteriskAsteriskToken,
      SyntaxKind.AsteriskToken,
      SyntaxKind.MinusToken,
      SyntaxKind.PercentToken,
      SyntaxKind.PlusToken,
      SyntaxKind.SlashToken,
    ].includes(value.operatorToken.kind)
    ? [value.left, value.right]
    : undefined;
}

/** Primitive binding reads and fresh data literals execute no pre-copy application code. */
function quietArguments(given: readonly Expression[]): boolean {
  const pending = [...given];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const value = unwrapped(node);
    if (isIdentifier(value) || literalNumber(value) !== undefined) continue;
    if (
      [
        SyntaxKind.FalseKeyword,
        SyntaxKind.NullKeyword,
        SyntaxKind.OmittedExpression,
        SyntaxKind.TrueKeyword,
      ].includes(value.kind)
    )
      continue;
    if (isArrowFunction(value) || isFunctionExpression(value)) continue;
    if (isArrayLiteralExpression(value)) {
      pending.push(...value.elements);
      continue;
    }
    if (!isObjectLiteralExpression(value) || !quietFields(value, pending)) return false;
  }
  return true;
}

/** Literal field names and deferred own accessors execute no object-creation callback. */
function quietFields(value: ObjectLiteralExpression, pending: Expression[]): boolean {
  for (const property of value.properties) {
    if (isShorthandPropertyAssignment(property)) continue;
    if (
      !isPropertyAssignment(property) &&
      !isMethodDeclaration(property) &&
      !isGetAccessorDeclaration(property) &&
      !isSetAccessorDeclaration(property)
    )
      return false;
    const name = property.name;
    if (!isIdentifier(name) && !isStringLiteral(name) && !isNumericLiteral(name)) return false;
    if (name.text === '__proto__') return false;
    if (isPropertyAssignment(property)) pending.push(property.initializer);
  }
  return true;
}

/** A whole const alias preserves the original primitive or literal array initializer. */
function constantInitializer(node: Expression): Expression | undefined {
  if (!isIdentifier(node)) return undefined;
  const selected = frameBindingOf(node);
  const binding = selected?.binding;
  return binding !== undefined &&
    selected?.keys.length === 0 &&
    isVariableDeclaration(binding) &&
    isIdentifier(binding.name) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding.initializer
    : undefined;
}
