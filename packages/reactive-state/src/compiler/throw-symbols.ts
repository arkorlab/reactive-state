import {
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isNewExpression,
  isPrefixUnaryExpression,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { globalPath } from './global-answers.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { globalCalleePath } from './throw-callees.ts';
import { writtenOf } from './throw-shapes.ts';

/**
 * What throws of a symbol the code writes where the language makes a number or text of it —
 * `Number(Symbol('x'))`, `+symbol`, `` `${symbol}` ``, `symbol + ''` — as it makes neither of one,
 * but `String(symbol)`, which writes its description.
 */

/** The year through milliseconds a `Date` construction converts, ignoring later arguments. */
const DATE_PARTS = 7;

/** Native conversion argument counts; undefined denotes a function that reads every argument. */
const COERCING: ReadonlyMap<string, number | undefined> = new Map([
  ['atob', 1],
  ['BigInt', 1],
  ['btoa', 1],
  ['Date.UTC', DATE_PARTS],
  ['decodeURI', 1],
  ['decodeURIComponent', 1],
  ['encodeURI', 1],
  ['encodeURIComponent', 1],
  ['escape', 1],
  ['isFinite', 1],
  ['isNaN', 1],
  ['Number', 1],
  ['Number.parseFloat', 1],
  ['Number.parseInt', 2],
  ['parseFloat', 1],
  ['parseInt', 2],
  ['String.fromCharCode', undefined],
  ['String.fromCodePoint', undefined],
  ['unescape', 1],
]);

/** Fixed native Math argument counts; max, min and hypot convert every supplied argument. */
const MATH_ARGUMENTS: ReadonlyMap<string, number> = new Map([
  ['Math.abs', 1],
  ['Math.acos', 1],
  ['Math.acosh', 1],
  ['Math.asin', 1],
  ['Math.asinh', 1],
  ['Math.atan2', 2],
  ['Math.atan', 1],
  ['Math.atanh', 1],
  ['Math.cbrt', 1],
  ['Math.ceil', 1],
  ['Math.clz32', 1],
  ['Math.cos', 1],
  ['Math.cosh', 1],
  ['Math.exp', 1],
  ['Math.expm1', 1],
  ['Math.f16round', 1],
  ['Math.floor', 1],
  ['Math.fround', 1],
  ['Math.imul', 2],
  ['Math.log1p', 1],
  ['Math.log2', 1],
  ['Math.log10', 1],
  ['Math.log', 1],
  ['Math.pow', 2],
  ['Math.random', 0],
  ['Math.round', 1],
  ['Math.sign', 1],
  ['Math.sin', 1],
  ['Math.sinh', 1],
  ['Math.sqrt', 1],
  ['Math.sumPrecise', 1],
  ['Math.tan', 1],
  ['Math.tanh', 1],
  ['Math.trunc', 1],
]);

/** The arguments constructors convert, unlike `String(symbol)` or `Object(symbol)` as functions. */
const CONSTRUCTED_COERCIONS: ReadonlyMap<string, number> = new Map([
  ['Date', DATE_PARTS],
  ['Number', 1],
  ['String', 1],
]);

/** The operators that make a number of each value beside them, or text where one is text: `+`, `<`. */
const COERCING_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.AmpersandToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.BarToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.CaretToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.LessThanLessThanToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.MinusToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.PercentToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.PlusToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.SlashToken,
]);

/** The symbols the language knows well, `Symbol.iterator` and its kin. */
const WELL_KNOWN: ReadonlySet<string> = new Set([
  'Symbol.asyncDispose',
  'Symbol.asyncIterator',
  'Symbol.dispose',
  'Symbol.hasInstance',
  'Symbol.isConcatSpreadable',
  'Symbol.iterator',
  'Symbol.match',
  'Symbol.matchAll',
  'Symbol.replace',
  'Symbol.search',
  'Symbol.species',
  'Symbol.split',
  'Symbol.toPrimitive',
  'Symbol.toStringTag',
  'Symbol.unscopables',
]);

/** The prefix operators that make a number of what they stand before: `+`, `-`, `~`. */
const COERCING_PREFIXES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.MinusToken,
  SyntaxKind.PlusToken,
  SyntaxKind.TildeToken,
]);

/** Unary plus requires a Number conversion, which a written primitive bigint cannot supply. */
export function unaryBigIntThrows(node: Node, resolve: Resolve | undefined): boolean {
  return (
    isPrefixUnaryExpression(node) &&
    node.operator === SyntaxKind.PlusToken &&
    isBigIntWritten(node.operand, resolve)
  );
}

/**
 * Whether `node` makes a number or text of a symbol the code writes (`isSymbolWritten`), which
 * throws: a function that coerces what it is given (`COERCING`, `Math`'s), an operator
 * (`COERCING_OPERATORS`, `COERCING_PREFIXES`), a template.
 */
export function coercesSymbol(node: Node, resolve: Resolve | undefined): boolean {
  if (isCallExpression(node)) {
    return callCoercesSymbol(node, resolve);
  }
  if (isNewExpression(node)) {
    return constructionCoercesSymbol(node, resolve);
  }
  if (isPrefixUnaryExpression(node)) {
    return COERCING_PREFIXES.has(node.operator) && isSymbolWritten(node.operand, resolve);
  }
  if (isBinaryExpression(node)) {
    return (
      COERCING_OPERATORS.has(node.operatorToken.kind) &&
      (isSymbolWritten(node.left, resolve) || isSymbolWritten(node.right, resolve))
    );
  }
  return (
    isTemplateExpression(node) &&
    (!isTaggedTemplateExpression(node.parent) ||
      globalPath(writtenOf(node.parent.tag, resolve))?.join('.') === 'String.raw') &&
    node.templateSpans.some((span) => isSymbolWritten(span.expression, resolve))
  );
}

/** Whether a call converts a written symbol among the arguments it actually reads. */
function callCoercesSymbol(node: CallExpression, resolve: Resolve | undefined): boolean {
  const path = symbolCalleePath(node.expression, resolve);
  return (
    (COERCING.has(path) || path.startsWith('Math.')) &&
    argumentsCoerceSymbol(node.arguments, COERCING.get(path) ?? MATH_ARGUMENTS.get(path), resolve)
  );
}

/** Whether a Number, String or Date construction converts a written symbol. */
function constructionCoercesSymbol(node: NewExpression, resolve: Resolve | undefined): boolean {
  const path = symbolCalleePath(node.expression, resolve);
  const count = CONSTRUCTED_COERCIONS.get(path);
  return count !== undefined && argumentsCoerceSymbol(node.arguments ?? [], count, resolve);
}

/** Native callees held by unchanged lexical constants, including namespace aliases. */
function symbolCalleePath(node: Expression, resolve: Resolve | undefined): string {
  const follow: Resolve = (name) => {
    const held = resolve?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, node) ? undefined : held;
  };
  return globalCalleePath(node, follow)?.join('.') ?? '';
}

/** Whether the converted arguments hold a written symbol, without guessing positions past a spread. */
function argumentsCoerceSymbol(
  given: readonly Expression[],
  count: number | undefined,
  resolve: Resolve | undefined,
): boolean {
  if (count !== undefined && given.some((each) => isSpreadElement(each))) {
    return false;
  }
  const converted = count === undefined ? given : given.slice(0, count);
  return converted.some((each) => !isSpreadElement(each) && isSymbolWritten(each, resolve));
}

/**
 * Whether `node` is a symbol where the code writes it, through its constants: one `Symbol(…)` or
 * `Symbol.for(…)` makes, or one the language knows well, `Symbol.iterator`.
 */
export function isSymbolWritten(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  if (isCallExpression(value)) {
    const path = globalPath(unwrapped(value.expression))?.join('.');
    return path === 'Symbol' || path === 'Symbol.for';
  }
  return WELL_KNOWN.has(globalPath(value)?.join('.') ?? '');
}
