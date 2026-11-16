import {
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, patternKey } from './code-globals.ts';
import { declarationOf, namesType, parameterOf } from './framed.ts';

/**
 * What of a shared module's code answers of the time zone or the locale where it runs (`settled.ts`):
 * a method of local time or of the locale, called, or read to be called otherwise — borrowed,
 * `Date.prototype.getHours.call(date)`, or taken apart, `const { getHours } = Date.prototype`.
 */

/**
 * The methods that answer of the time zone or of the locale where they run, which a page's and the
 * authority's commonly differ in: a date's parts read or set in local time, its text of local time,
 * and the locale's comparisons and texts — beside which a date's UTC parts, `getUTCHours`, and
 * `toISOString` answer alike.
 */
export const LOCAL_METHODS: ReadonlySet<string> = new Set([
  'getDate',
  'getDay',
  'getFullYear',
  'getHours',
  'getMilliseconds',
  'getMinutes',
  'getMonth',
  'getSeconds',
  'getTimezoneOffset',
  'getYear',
  'localeCompare',
  'setDate',
  'setFullYear',
  'setHours',
  'setMilliseconds',
  'setMinutes',
  'setMonth',
  'setSeconds',
  'setYear',
  'toDateString',
  'toLocaleDateString',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleTimeString',
  'toLocaleUpperCase',
  'toTimeString',
]);

/**
 * What of `node` reads a method of `LOCAL_METHODS` — `getHours` of `Date.prototype.getHours.call(date)`,
 * of `const { getHours } = Date.prototype` — which answers of the time zone or the locale where it
 * runs; none of another.
 */
export function localRead(node: Node): string | undefined {
  const name = readName(node);
  return name === undefined ? undefined : localNamed(name);
}

/** What a read of the method `name` reads, where it is one of `LOCAL_METHODS`: `toLocaleString`. */
export function localNamed(name: string): string | undefined {
  return LOCAL_METHODS.has(name)
    ? `reads \`${name}\`, of the time zone or the locale where it runs`
    : undefined;
}

/**
 * The name `node` reads of what it reads it of: a member's, or an entry's a pattern takes apart,
 * by a name the code writes in brackets too, `{ ['getHours']: hours }` (`patternKey`).
 */
function readName(node: Node): string | undefined {
  if (isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (isElementAccessExpression(node)) {
    const key = unwrapped(node.argumentExpression);
    return isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key) ? key.text : undefined;
  }
  return patternKey(node);
}

/** The operators that make text of a date beside them: `+`, `+=`. */
const ADDING: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken]);

/**
 * What of `node` writes a date as text of the time zone where it runs — `toString` of a date the code
 * makes, `new Date(0).toString()`, or of `Date.prototype`, `String(date)`, a date in a template,
 * `${date}`, or added, `date + ''` — none of another, nor of a value the code shows no date of.
 */
export function dateText(node: Node): string | undefined {
  const of = datedOf(node);
  return of !== undefined && isDate(unwrapped(of), new Set())
    ? 'writes a date as text of the time zone where it runs'
    : undefined;
}

/** Whether `node` names or constructs a local `Date` value directly or via typed/initialized aliases. */
export function isDateValue(node: Expression): boolean {
  return isDate(unwrapped(node), new Set());
}

/** What `node` writes as text where it writes it so: `toString`'s receiver, `String`'s argument, an operand. */
function datedOf(node: Node): Expression | undefined {
  if (isPropertyAccessExpression(node) && node.name.text === 'toString') {
    return node.expression;
  }
  if (isCallExpression(node) && globalPathOf(unwrapped(node.expression))?.join('.') === 'String') {
    return node.arguments[0];
  }
  if (isTemplateExpression(node)) {
    return node.templateSpans.find((span) => isDate(unwrapped(span.expression), new Set()))
      ?.expression;
  }
  if (!isBinaryExpression(node) || !ADDING.has(node.operatorToken.kind)) {
    return undefined;
  }
  return isDate(unwrapped(node.left), new Set()) ? node.left : node.right;
}

/** The type a date is said to be of. */
const DATED: ReadonlySet<string> = new Set(['Date']);

/**
 * Whether `node` is a date: one the code makes there, `new Date(0)`, `Date.prototype`; a parameter
 * or a variable said to be one, `(date: Date)`; or what a variable around it is declared of
 * (`declarationOf`), in turn.
 */
function isDate(node: Expression, seen: Set<string>): boolean {
  const path = globalPathOf(node)?.join('.');
  if (path === 'Date.prototype' || (isNewExpression(node) && isDateClass(node.expression))) {
    return true;
  }
  if (!isIdentifier(node) || seen.has(node.text)) {
    return false;
  }
  seen.add(node.text);
  const declared = declarationOf(node);
  if (declared === undefined) {
    return namesType(parameterOf(node)?.type, DATED);
  }
  return (
    isVariableDeclaration(declared) &&
    (namesType(declared.type, DATED) ||
      (declared.initializer !== undefined && isDate(unwrapped(declared.initializer), seen)))
  );
}

/** Whether `node` names the global `Date`. */
function isDateClass(node: Expression): boolean {
  return globalPathOf(unwrapped(node))?.join('.') === 'Date';
}
