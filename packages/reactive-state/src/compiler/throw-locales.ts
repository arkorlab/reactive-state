import {
  type Expression,
  isArrayLiteralExpression,
  isBigIntLiteral,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isSpreadElement,
  SyntaxKind,
} from 'typescript/ast';

import { calledMember, unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { constantValue, type Resolve, writtenTime } from './numbers.ts';
import { ownsMethods, primitiveOf, typedOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/**
 * What a function of the language's that takes locales throws of those the code writes it is given
 * — text of no language tag, `(1).toLocaleString('bad_locale')`, or what no list of locales is made
 * of, `null` — as every engine reads a tag alike, by its form alone; and of the options it writes
 * there, tried as `Intl` takes them: `(1).toLocaleString('en-US', { style: 'currency' })`.
 */

/** The Intl formatter numeric locale methods create. */
const NUMBER_FORMAT = 'Intl.NumberFormat';

/** The methods that take locales, by the place they are given them at: `toLocaleString` and its kin. */
const LOCALE_METHODS: ReadonlyMap<string, number> = new Map([
  ['localeCompare', 1],
  ['toLocaleDateString', 0],
  ['toLocaleLowerCase', 0],
  ['toLocaleString', 0],
  ['toLocaleTimeString', 0],
  ['toLocaleUpperCase', 0],
]);

/** The date methods that return Invalid Date before inspecting locales or options. */
const DATE_LOCALE_METHODS: ReadonlySet<string> = new Set([
  'toLocaleDateString',
  'toLocaleString',
  'toLocaleTimeString',
]);

/** The classes of `Intl` that take locales first, as their `supportedLocalesOf` does. */
const LOCALE_CLASSES: readonly string[] = [
  'Intl.Collator',
  'Intl.DateTimeFormat',
  'Intl.DisplayNames',
  'Intl.DurationFormat',
  'Intl.ListFormat',
  NUMBER_FORMAT,
  'Intl.PluralRules',
  'Intl.RelativeTimeFormat',
  'Intl.Segmenter',
];

/** What a function or a class of `Intl` throws of what it is given, where the code writes it. */
type Taking = (given: readonly Expression[], resolve: Resolve | undefined) => boolean;

/** The locales `given` first, where the code writes them (`localesThrow`). */
const LOCALES_FIRST: Taking = (given, resolve) => localesThrow(given[0], resolve);

/**
 * The functions and the classes of `Intl` that throw of the locales they are given first, where the
 * code writes them — `new Intl.NumberFormat('bad_locale')` — and `Intl.Locale` of what is no tag.
 */
export const LOCALE_TAKERS: ReadonlyMap<string, Taking> = new Map([
  ...LOCALE_CLASSES.flatMap((name): [string, Taking][] => {
    const taking: Taking = (given, resolve) =>
      localesThrow(given[0], resolve) || madeThrows(name, given[0], given[1], resolve);
    return [
      [name, taking],
      [`${name}.supportedLocalesOf`, LOCALES_FIRST],
    ];
  }),
  ['Intl.getCanonicalLocales', LOCALES_FIRST],
  ['Intl.Locale', (given, resolve) => tagThrows(given[0], resolve)],
]);

/**
 * Whether `callee` called with `given` is a method that takes locales (`LOCALE_METHODS`) that throws
 * of those the code writes it is given — but one of a value of methods of its own (`ownsMethods`)
 * but a date the code makes, whose are the language's, or past a spread, which may hand them from
 * any place.
 */
export function localeMethodThrows(
  callee: Expression,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const member = calledMember(callee);
  const at = member === undefined ? undefined : LOCALE_METHODS.get(member.name);
  if (
    at === undefined ||
    member === undefined ||
    given.slice(0, at + 2).some((each) => isSpreadElement(each))
  ) {
    return false;
  }
  if (DATE_LOCALE_METHODS.has(member.name) && Number.isNaN(writtenTime(member.of, resolve))) {
    return false;
  }
  if (member.name === 'toLocaleString' && ignoresLocales(member.of, resolve)) {
    return false;
  }
  const collection = collectionFormat(member.name, member.of, resolve);
  if (
    collection === undefined &&
    ownsMethods(member.of, resolve) &&
    writtenTime(member.of, resolve) === undefined
  ) {
    return false;
  }
  const made = collection ?? madeOf(member.name, member.of, resolve);
  return (
    localesThrow(given[at], resolve) ||
    (made !== undefined && madeThrows(made, given[at], given[at + 1], resolve))
  );
}

/** Whether a written receiver inherits Object's toLocaleString, which ignores locales and options. */
function ignoresLocales(receiver: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(receiver, resolve);
  if (
    typeof constantValue(value, resolve) === 'string' ||
    isRegularExpressionLiteral(value) ||
    isSymbolWritten(value, resolve) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  const made = isNewExpression(value)
    ? globalPath(unwrapped(value.expression))?.join('.')
    : undefined;
  return made !== undefined && ['Boolean', 'RegExp', 'String'].includes(made);
}

/** The NumberFormat a collection is certain to use before any element's unknown code may run. */
function collectionFormat(
  method: string,
  receiver: Expression,
  resolve: Resolve | undefined,
): string | undefined {
  if (method !== 'toLocaleString') {
    return undefined;
  }
  const value = writtenOf(receiver, resolve);
  const typed = typedOf(value, resolve);
  if (typed?.length !== undefined && typed.length > 0) {
    return NUMBER_FORMAT;
  }
  if (!isArrayLiteralExpression(value)) {
    return undefined;
  }
  for (const element of value.elements) {
    if (isOmittedExpression(element)) {
      continue;
    }
    const item = writtenOf(element, resolve);
    if (isBigIntLiteral(item) || typeof constantValue(item, resolve) === 'number') {
      return NUMBER_FORMAT;
    }
    if (primitiveOf(item, resolve) !== 'nothing' && !ignoresLocales(item, resolve)) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The class of `Intl` a method that takes locales makes of them and its options, called on what the
 * code writes: a number's `toLocaleString`, `Intl.NumberFormat`; a date's, `Intl.DateTimeFormat`;
 * text's `localeCompare`, `Intl.Collator`; none of what it does not tell.
 */
function madeOf(
  method: string,
  receiver: Expression,
  resolve: Resolve | undefined,
): string | undefined {
  if (method === 'localeCompare') {
    return 'Intl.Collator';
  }
  if (writtenTime(receiver, resolve) !== undefined) {
    return method === 'toLocaleUpperCase' || method === 'toLocaleLowerCase'
      ? undefined
      : 'Intl.DateTimeFormat';
  }
  const value = constantValue(receiver, resolve);
  return method === 'toLocaleString' && (typeof value === 'number' || typeof value === 'bigint')
    ? NUMBER_FORMAT
    : undefined;
}

/**
 * Whether the class of `Intl` `path` names throws of the locales and the options the code writes it
 * is given, tried as the class takes them — of locales it does not tell, those where it runs — or
 * of no options, `Intl.DisplayNames`, which needs them; none of options it does not write whole.
 */
function madeThrows(
  path: string,
  locales: Expression | undefined,
  options: Expression | undefined,
  resolve: Resolve | undefined,
): boolean {
  const made: unknown = Reflect.get(Intl, path.slice('Intl.'.length));
  const written = writtenOptions(options, resolve);
  if (typeof made !== 'function' || written === undefined) {
    return false;
  }
  try {
    Reflect.construct(made, [writtenLocales(locales, resolve), written.value]);
    return false;
  } catch {
    return true;
  }
}

/** The locales the code writes, as they are given — text, an array of text; none of another. */
function writtenLocales(given: Expression | undefined, resolve: Resolve | undefined): unknown {
  const value = given === undefined ? undefined : writtenOf(given, resolve);
  if (value === undefined) {
    return undefined;
  }
  const written = constantValue(value, resolve);
  if (typeof written === 'string' || !isArrayLiteralExpression(value)) {
    return typeof written === 'string' ? written : undefined;
  }
  const items = value.elements.map((each) =>
    isSpreadElement(each) ? undefined : constantValue(each, resolve),
  );
  return items.every((each) => typeof each === 'string') ? items : undefined;
}

/**
 * The options the code writes, as they are given: nothing, `null`, or an object of entries of names
 * and of constants alone, written there; none told of another.
 */
function writtenOptions(
  given: Expression | undefined,
  resolve: Resolve | undefined,
): { readonly value: unknown } | undefined {
  const value = given === undefined ? undefined : writtenOf(given, resolve);
  if (value === undefined || primitiveOf(value, resolve) === 'nothing') {
    return { value: value?.kind === SyntaxKind.NullKeyword ? null : undefined };
  }
  if (!isObjectLiteralExpression(value)) {
    return undefined;
  }
  const entries: [string, unknown][] = [];
  for (const property of value.properties) {
    if (!isPropertyAssignment(property)) {
      return undefined;
    }
    const key = isIdentifier(property.name) ? property.name.text : literalKey(property.name);
    const written = constantValue(property.initializer, resolve);
    if (key === undefined || written === undefined) {
      return undefined;
    }
    entries.push([key, written]);
  }
  return { value: Object.fromEntries(entries) };
}

/**
 * Whether the locales `given`, where the code writes them, throw where they are taken: text of no
 * language tag; `null`, of which no list is made; an array of one, or of what is neither text nor an
 * object — nothing, a number — none of what the code does not write, nor of nothing, `undefined`,
 * which asks for the locale where it runs.
 */
function localesThrow(given: Expression | undefined, resolve: Resolve | undefined): boolean {
  const value = given === undefined ? undefined : writtenOf(given, resolve);
  if (value === undefined) {
    return false;
  }
  if (value.kind === SyntaxKind.NullKeyword) {
    return true;
  }
  if (!isArrayLiteralExpression(value)) {
    const written = constantValue(value, resolve);
    return typeof written === 'string' && !isLanguageTag(written);
  }
  return value.elements.some((element) => {
    if (isSpreadElement(element) || isOmittedExpression(element)) {
      return false;
    }
    const kind = primitiveOf(writtenOf(element, resolve), resolve);
    return kind === 'text' ? tagThrows(element, resolve) : kind !== undefined;
  });
}

/**
 * Whether `given`, where the code writes it, throws as a language tag `Intl.Locale` takes: nothing, a
 * number, a boolean, `null`, which is no text or object, and text of no tag; none of another.
 */
function tagThrows(given: Expression | undefined, resolve: Resolve | undefined): boolean {
  const value = given === undefined ? undefined : writtenOf(given, resolve);
  if (value === undefined) {
    return true;
  }
  const kind = primitiveOf(value, resolve);
  if (kind === 'nothing' || kind === 'other') {
    return true;
  }
  const written = constantValue(value, resolve);
  return typeof written === 'string' && !isLanguageTag(written);
}

/** Whether `text` is a language tag of a well-formed shape, which every engine reads alike. */
function isLanguageTag(text: string): boolean {
  try {
    Intl.getCanonicalLocales(text);
    return true;
  } catch {
    return false;
  }
}
