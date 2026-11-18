import {
  type Expression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, isTakenApart, patternKey } from './code-globals.ts';
import { framedKeyNames, framedMemberNames } from './framed-keys.ts';
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
  for (const name of readNames(node)) {
    const found = localNamed(name);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** What a read of the method `name` reads, where it is one of `LOCAL_METHODS`: `toLocaleString`. */
export function localNamed(name: string): string | undefined {
  return LOCAL_METHODS.has(name)
    ? `reads \`${name}\`, of the time zone or the locale where it runs`
    : undefined;
}

/**
 * The names `node` may read of what it reads them of: a member's, or an entry's a pattern takes
 * apart, by a literal, constant, or conditional name in brackets too (`framedMemberNames`, `patternKey`).
 */
function readNames(node: Node): readonly string[] {
  const framed = framedMemberNames(node);
  if (framed !== undefined) {
    return framed;
  }
  const computed = computedReadKey(node);
  if (computed !== undefined) {
    const resolved = framedKeyNames(computed);
    if (resolved !== undefined) {
      return resolved;
    }
    const folded = staticText(computed);
    if (folded !== undefined) {
      return [folded];
    }
  }
  const single = patternKey(node);
  return single === undefined ? [] : [single];
}

/** Key expression of a bracket read or a computed object binding or assignment-pattern entry. */
function computedReadKey(node: Node): Expression | undefined {
  if (isElementAccessExpression(node)) {
    return node.argumentExpression;
  }
  if (
    isBindingElement(node) &&
    node.dotDotDotToken === undefined &&
    isObjectBindingPattern(node.parent) &&
    node.propertyName !== undefined &&
    isComputedPropertyName(node.propertyName)
  ) {
    return node.propertyName.expression;
  }
  return isPropertyAssignment(node) &&
    isTakenApart(node.parent) &&
    isComputedPropertyName(node.name)
    ? node.name.expression
    : undefined;
}

/** The literal text `node` writes of strings, templates, constants, and string additions alone. */
function staticText(node: Expression): string | undefined {
  const value = unwrapped(node);
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  if (isIdentifier(value)) {
    const names = framedKeyNames(value);
    return names?.length === 1 ? names[0] : undefined;
  }
  if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.PlusToken) {
    const left = staticText(value.left);
    const right = staticText(value.right);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  if (!isTemplateExpression(value)) {
    return undefined;
  }
  let text = value.head.text;
  for (const span of value.templateSpans) {
    const part = staticText(span.expression);
    if (part === undefined) {
      return undefined;
    }
    text += `${part}${span.literal.text}`;
  }
  return text;
}

/** The operators that make text of a date beside them: `+`, `+=`. */
const ADDING: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken]);

/**
 * What of `node` writes a date as text of the time zone where it runs — `toString` of a date the code
 * makes, `new Date(0).toString()`, `new Date(0)['toString']()`, or of `Date.prototype`, `String(date)`,
 * a date in a template, `${date}`, or added, `date + ''` — none of another, nor of a value the code
 * shows no date of.
 */
export function dateText(node: Node): string | undefined {
  const of = datedOf(node);
  return of !== undefined && isDate(unwrapped(of), new Set())
    ? 'writes a date as text of the time zone where it runs'
    : undefined;
}

/** What `node` writes as text where it writes it so: `toString`'s receiver, `String`'s argument, an operand. */
function datedOf(node: Node): Expression | undefined {
  const receiver = toStringReceiver(node);
  if (receiver !== undefined) {
    return receiver;
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

/** The receiver whose `toString` method `node` reads by member access or takes apart by pattern. */
function toStringReceiver(node: Node): Expression | undefined {
  if (!readNames(node).includes('toString')) {
    return undefined;
  }
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    return node.expression;
  }
  if (
    isBindingElement(node) &&
    node.dotDotDotToken === undefined &&
    isObjectBindingPattern(node.parent)
  ) {
    const holder = node.parent.parent;
    return isVariableDeclaration(holder) || isParameterDeclaration(holder)
      ? holder.initializer
      : undefined;
  }
  if (
    (!isPropertyAssignment(node) && !isShorthandPropertyAssignment(node)) ||
    !isObjectLiteralExpression(node.parent)
  ) {
    return undefined;
  }
  const assignment = node.parent.parent;
  return isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === SyntaxKind.EqualsToken &&
    unwrapped(assignment.left) === node.parent
    ? assignment.right
    : undefined;
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
