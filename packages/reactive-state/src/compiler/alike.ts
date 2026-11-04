import {
  type CallExpression,
  type Expression,
  isNumericLiteral,
  isSpreadElement,
} from 'typescript/ast';

import { type Refuse, unwrapped } from './bounded.ts';

/**
 * What a value the browser and the authority each compute is computed of, as both answer it alike:
 * the globals of what they are given alone, and none of the members of theirs that answer of the
 * locale, of chance, of what an object holds beyond its value, or as each engine approximates them
 * (`computed.ts`).
 */

/**
 * The functions of `Object` that answer of what an object holds beyond its value — frozen, sealed,
 * extensible — in which the authority's copy of a state and the browser's differ.
 */
export const INTROSPECTORS: ReadonlySet<string> = new Set([
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'isExtensible',
  'isFrozen',
  'isSealed',
]);

/**
 * The functions of `Math` the language leaves each engine to approximate, whose last digits the
 * browser's and the authority's may answer apart: all but those it defines exactly.
 */
export const APPROXIMATED: ReadonlySet<string> = new Set([
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'cbrt',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'hypot',
  'log',
  'log1p',
  'log2',
  'log10',
  'pow',
  'sin',
  'sinh',
  'tan',
  'tanh',
]);

/** The methods that answer of the locale they run in, which the browser's and the authority's may differ in. */
const LOCALE_METHODS: ReadonlySet<string> = new Set([
  'localeCompare',
  'toLocaleDateString',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleTimeString',
  'toLocaleUpperCase',
]);

/**
 * The methods of text that answer of the Unicode data their engine ships — its case mappings, its
 * normalizations — which each version of the standard extends to the characters it adds: the
 * browser's and the authority's may answer apart of text that holds one.
 */
const UNICODE_METHODS: ReadonlySet<string> = new Set([
  'normalize',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimLeft',
  'trimRight',
  'trimStart',
]);

/**
 * The globals a value the browser and the authority each compute may read: functions of what they
 * are given alone, never of the time, of chance, of where they run or of the page.
 */
const PURE_GLOBALS: ReadonlySet<string> = new Set([
  'Array',
  'BigInt',
  'Boolean',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'Infinity',
  'isFinite',
  'isNaN',
  'JSON',
  'Math',
  'NaN',
  'Number',
  'Object',
  'parseFloat',
  'parseInt',
  'String',
  'undefined',
]);

/** What a value both sides compute is computed of, as a refusal of what they may answer apart says. */
export const ALIKE =
  "what a dynamic site is computed of — what it reads of the browser's, the props its element is given, a condition it stands under, a list's array and its key — the authority computes again, of the inputs a view sends or a binding names, and it is computed of what answers alike each time and on each side: the states, the props, the application's shared modules, and the globals of what they are given alone, `Math`, `JSON`, `Number`, `String`, `Object`, `Array` and the like";

/**
 * Refuses a call of the method `method` — of the global `global`, where it is one's — that the
 * browser and the authority may answer apart: of the locale, of the Unicode data its engine ships,
 * of chance, as each engine approximates it, or of what an object holds beyond its value.
 */
export function checkAnsweredAlike(
  method: string,
  global: string | undefined,
  refuse: Refuse,
): void {
  if (LOCALE_METHODS.has(method)) {
    refuse(
      `\`.${method}()\` answers of the locale it runs in, which the browser's and the authority's may differ in, and ${ALIKE}.`,
    );
  }
  if (UNICODE_METHODS.has(method)) {
    refuse(
      `\`.${method}()\` answers of the Unicode data its engine ships — the case mappings and normalizations each version of the standard gives the characters it adds, and the spaces it trims, which a version has changed (U+180E, of Unicode 6.3) — which the browser's and the authority's may differ in, and ${ALIKE}.`,
    );
  }
  if (method === 'random' && global === 'Math') {
    refuse(`\`Math.random()\` answers of chance, otherwise on each side, and ${ALIKE}.`);
  }
  if (global === 'Math' && APPROXIMATED.has(method)) {
    refuse(approximated(`Math.${method}()`));
  }
  if (global === 'Object' && INTROSPECTORS.has(method)) {
    refuse(
      `\`Object.${method}()\` answers of what an object holds beyond its value — frozen, sealed, extensible — in which the authority's copy of a state, which it freezes, and the browser's differ, and ${ALIKE}.`,
    );
  }
}

/** The methods that order an array by the comparator they are given. */
const ORDERING: ReadonlySet<string> = new Set(['sort', 'toSorted']);

/**
 * Refuses a call of the method `method` that orders an array by a comparator it is given: of one
 * that answers inconsistently — `() => 1`, or `-1` of two equal items — the language leaves the
 * order to each engine's sort, which the browser's and the authority's may run otherwise, and the
 * compile cannot tell one that answers consistently.
 */
export function checkComparator(call: CallExpression, method: string, refuse: Refuse): void {
  if (ORDERING.has(method) && call.arguments.length > 0) {
    refuse(
      `\`.${method}(…)\` given a comparator orders as each engine's sort calls it where the comparator answers inconsistently — \`() => 1\`, or \`-1\` of two equal items — which the language leaves to the engine, and ${ALIKE}. Sort in the order the language defines, \`.${method}()\`, or in a function of a \`shared\` module, which answers alike as the application keeps it: \`sortedByTitle(items)\`.`,
    );
  }
}

/** Why a value both sides compute may not read the global `name`; none where it may. */
export function impureGlobal(name: string): string | undefined {
  return PURE_GLOBALS.has(name)
    ? undefined
    : `\`${name}\` is a global the browser and the authority may each answer otherwise — of the time, of chance, of where it runs or of the page — and ${ALIKE}. Give it as a prop, or keep it in the browser, out of what a site reads.`;
}

/**
 * The radices the language defines `parseInt`'s answer of exactly, which each engine answers alike,
 * by the text of their value: of any other, it may answer an integer the engine approximates, as
 * long text tells apart. Of 10 it lets an engine read past the 20th significant digit as zeros, as
 * it lets it round any decimal text made a number there — `Number(text)`, `+text`, `parseFloat`, a
 * comparison of text with a number — which the grammar cannot keep from a site; the engines a page
 * runs in read every digit, correctly rounded — V8 (the browser's and the authority's) and
 * SpiderMonkey by double-conversion, JavaScriptCore by fast_float, of 10 too — and answer alike.
 */
const EXACT_RADICES: ReadonlySet<string> = new Set(['2', '4', '8', '10', '16', '32']);

/**
 * The radix the argument at `index` of `call` is, by the text of its value as the code writes it —
 * `16` of `0x10` — none where it gives none, and the empty text where the compile cannot read it: a
 * name, or a spread before it or at it.
 */
function radixOf(call: CallExpression, index: number): string | undefined {
  const { arguments: given } = call;
  if (given.slice(0, index + 1).some((argument) => isSpreadElement(argument))) {
    return '';
  }
  const argument: Expression | undefined = given[index];
  if (argument === undefined) {
    return undefined;
  }
  const radix = unwrapped(argument);
  return isNumericLiteral(radix) ? String(Number(radix.text)) : '';
}

/**
 * Refuses a call of `name` that reads or writes a number in a radix each engine may answer
 * otherwise of: `parseInt` of a radix the code writes outside `EXACT_RADICES`, or not at all as a
 * number, and a number's `.toString(radix)` of any radix but 10 — whose digits the language leaves
 * to the engine.
 */
export function checkRadix(call: CallExpression, name: string | undefined, refuse: Refuse): void {
  if (name === 'parseInt') {
    const radix = radixOf(call, 1);
    if (radix !== undefined && !EXACT_RADICES.has(radix)) {
      refuse(
        `\`parseInt(…)\` of a radix but 2, 4, 8, 10, 16 or 32, written as a number, answers an integer each engine may approximate for long text, and ${ALIKE}. Give it one of those radices, written: \`parseInt(text, 10)\`.`,
      );
    }
  }
  if (name === 'toString' && call.arguments.length > 0 && radixOf(call, 0) !== '10') {
    refuse(
      `\`.toString(…)\` of a radix but 10, written as a number, writes the digits of a number as each engine chooses them, and ${ALIKE}. Write it in radix 10: \`String(value)\`.`,
    );
  }
}

/** Why `parseInt`, handed on, is no value both sides compute. */
export function handedParse(what: string): string {
  return `\`${what}\` is handed on here, to be called where the compile does not see it, of a radix it does not see — \`items.map(parseInt)\` gives it each index — and ${ALIKE}. Call it, of a radix of 2, 4, 8, 10, 16 or 32: \`items.map((item) => parseInt(item, 10))\`.`;
}

/** Why what an engine approximates is no value both sides compute. */
export function approximated(what: string): string {
  return `\`${what}\` answers as each engine approximates it — the browser's may answer otherwise in its last digits than the authority's — and ${ALIKE}. Compute it of what both answer exactly: \`+\`, \`*\`, \`/\`, \`Math.round\`, \`Math.sqrt\`.`;
}
