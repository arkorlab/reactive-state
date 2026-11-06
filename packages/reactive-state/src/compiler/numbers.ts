import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isFunctionExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPrefixUnaryExpression,
  isNewExpression,
  isPropertyAccessExpression,
  type NewExpression,
  type PropertyAccessExpression,
  isSpreadElement,
  isStringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';

/**
 * What the code computes of numbers alone, as the language computes it — of literals, `NaN`,
 * `Infinity`, the operators of arithmetic, and the language's functions that answer a number of
 * what they are given alone (`Number('bad')`, `Math.sqrt(-1)`) — so that a value the authority
 * would compute to what no JSON holds, a state's first value or a list's key, is told as it compiles.
 */

/** The globals that hold a number of their own: `NaN`, `Infinity`. */
const NUMBER_GLOBALS: ReadonlyMap<string, number> = new Map([
  ['Infinity', Infinity],
  ['NaN', NaN],
]);

/** The operators of arithmetic, by what each computes of two numbers. */
const ARITHMETIC: ReadonlyMap<SyntaxKind, (left: number, right: number) => number> = new Map([
  [SyntaxKind.AsteriskAsteriskToken, (left: number, right: number) => left ** right],
  [SyntaxKind.AsteriskToken, (left: number, right: number) => left * right],
  [SyntaxKind.MinusToken, (left: number, right: number) => left - right],
  [SyntaxKind.PercentToken, (left: number, right: number) => left % right],
  [SyntaxKind.PlusToken, (left: number, right: number) => left + right],
  [SyntaxKind.SlashToken, (left: number, right: number) => left / right],
]);

/** What a name of the code's holds, as the constant it names writes it; none of another name. */
export type Resolve = (name: Identifier) => Expression | undefined;

/** A value the code writes of numbers and text alone. */
export type Constant = number | string;

/** How names are read: what `resolve` answers they hold, but those followed on the way already. */
interface Names {
  readonly resolve: Resolve | undefined;
  readonly following: ReadonlySet<string>;
}

/**
 * The number `node` is where the code writes it of numbers alone — `1 / 0`, `-(2 ** 1024)`,
 * `Infinity - Infinity` — as the language computes it, a name read as what `resolve` answers it
 * holds (`+bad` of `const bad = 'x'`, `1 / zero`); none where it reads anything else.
 */
export function constantNumber(node: Expression, resolve?: Resolve): number | undefined {
  return numberOf(node, { following: new Set(), resolve });
}

/**
 * What the code writes `node` as of numbers and text alone — a number it computes, or text — the
 * names it reads as what `resolve` answers they hold; none of anything else.
 */
export function constantValue(node: Expression, resolve?: Resolve): Constant | undefined {
  return constantOperand(node, { following: new Set(), resolve });
}

function numberOf(node: Expression, names: Names): number | undefined {
  const value = unwrapped(node);
  if (isNumericLiteral(value)) {
    return Number(value.text);
  }
  if (isIdentifier(value)) {
    const operand = nameOperand(value, names);
    return typeof operand === 'number' ? operand : undefined;
  }
  if (
    isPrefixUnaryExpression(value) &&
    (value.operator === SyntaxKind.MinusToken || value.operator === SyntaxKind.PlusToken)
  ) {
    return signedNumber(value.operand, value.operator === SyntaxKind.MinusToken, names);
  }
  if (isCallExpression(value)) {
    return constantCall(value, names);
  }
  if (isPropertyAccessExpression(value)) {
    return languageConstant(value);
  }
  const compute = isBinaryExpression(value) ? ARITHMETIC.get(value.operatorToken.kind) : undefined;
  if (compute === undefined || !isBinaryExpression(value)) {
    return undefined;
  }
  const left = constantOperand(value.left, names);
  const right = left === undefined ? undefined : constantOperand(value.right, names);
  // `'a' + 1` joins text; every other operator computes of numbers, text made one (`'x' * 1`).
  if (
    left === undefined ||
    right === undefined ||
    (value.operatorToken.kind === SyntaxKind.PlusToken &&
      (typeof left === 'string' || typeof right === 'string'))
  ) {
    return undefined;
  }
  return compute(Number(left), Number(right));
}

/**
 * The globals that hold constants of numbers, `Number.MAX_SAFE_INTEGER`, `Math.PI`, by their names:
 * what each holds by a name.
 */
const CONSTANT_HOLDERS: ReadonlyMap<string, (name: string) => unknown> = new Map([
  ['Math', (name: string): unknown => Reflect.get(Math, name)],
  ['Number', (name: string): unknown => Reflect.get(Number, name)],
]);

/**
 * The number a constant of the language's `Number` or `Math` holds — `Number.MAX_SAFE_INTEGER`,
 * `Number.POSITIVE_INFINITY`, `Math.PI` — read by its name; none of another member.
 */
function languageConstant(member: PropertyAccessExpression): number | undefined {
  const held = CONSTANT_HOLDERS.get(globalOf(unwrapped(member.expression)) ?? '')?.(
    member.name.text,
  );
  return typeof held === 'number' ? held : undefined;
}

/** The number of `+operand`, or of `-operand` (`negated`): `+'x'` is text made a number. */
function signedNumber(operand: Expression, negated: boolean, names: Names): number | undefined {
  const value = constantOperand(operand, names);
  const number = value === undefined ? undefined : Number(value);
  return number === undefined || !negated ? number : -number;
}

/** What the code writes as a value: a number it computes of numbers alone, or text. */
function constantOperand(node: Expression, names: Names): Constant | undefined {
  const value = unwrapped(node);
  const text =
    isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
  return text ?? (isIdentifier(value) ? nameOperand(value, names) : numberOf(value, names));
}

/**
 * What the name `name` holds as a value: `NaN` or `Infinity`, the globals'; else what the constant it
 * names writes (`names.resolve`), but a name followed on the way to it already, which holds none.
 */
function nameOperand(name: Identifier, names: Names): Constant | undefined {
  const global = NUMBER_GLOBALS.get(globalOf(name) ?? '');
  const held =
    global !== undefined || names.following.has(name.text) ? undefined : names.resolve?.(name);
  const following = new Set([...names.following, name.text]);
  return (
    global ?? (held === undefined ? undefined : constantOperand(held, { ...names, following }))
  );
}

/** The language's functions that answer a number of what they are given alone, by their names. */
const NUMBER_FUNCTIONS: ReadonlyMap<string, (...given: readonly Constant[]) => number> = new Map([
  // `Number()` is `0`; `Number(undefined)` is `NaN`.
  ['Number', (...given) => (given.length === 0 ? 0 : Number(given[0]))],
  ['parseFloat', (...given) => Number.parseFloat(String(given[0]))],
  // A radix of `0` is none: 10, or 16 of text that starts `0x`.
  [
    'parseInt',
    (...given) => {
      const radix = Number(given[1] ?? 0);
      return Number.parseInt(String(given[0]), radix);
    },
  ],
]);

/**
 * The time `Date.parse` reads of text as the engine reads it — the one the authority and the
 * compile both run, V8 — where every time zone reads it alike (`fixedText`); none of other text,
 * which it reads in the time zone where it runs.
 */
function parsedTime(text: string): number | undefined {
  const time = Date.parse(text);
  return fixedText(text, time) ? time : undefined;
}

/**
 * Whether every time zone reads `text` as the time `time` the compile reads of it: text in a form
 * that names its offset or none (`zonelessText`), or text of no digit, which writes no year, day or
 * time to read — and `NaN` of it alike. A time zone moves a reading by less than a day, so that
 * other text of no time here may hold one elsewhere: a time within a day of the dates the language
 * holds, `+275760-09-13T10:00`, is none in Tokyo and one in Kiritimati.
 */
function fixedText(text: string, time: number): boolean {
  return zonelessText(text) || (Number.isNaN(time) && !/\d/u.test(text));
}

/**
 * The functions of `Date` that answer a number of what they are given alone: `Date.UTC`, as the
 * language defines it, and `Date.parse`, of text (`parsedTime`).
 */
const DATE_FUNCTIONS: ReadonlyMap<string, (...given: readonly Constant[]) => number | undefined> =
  new Map([
    ['parse', (...given) => parsedTime(String(given[0]))],
    ['UTC', (...given) => Reflect.apply(Date.UTC, Date, given.map(Number)) as number],
  ]);

/**
 * The number `JSON.parse` makes of text the code writes alone — `Infinity` of `'1e400'` — as the
 * language reads it; none of text of no number, of which it makes another value, or throws.
 */
function parsedNumber(...given: readonly Constant[]): number | undefined {
  if (given.length !== 1) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(String(given[0]));
    return typeof parsed === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The functions of globals that answer a number of what they are given alone, by the global and
 * their names: `Date`'s (`DATE_FUNCTIONS`), and `JSON.parse`, of no reviver (`parsedNumber`).
 */
const GLOBAL_FUNCTIONS = new Map<
  string,
  ReadonlyMap<string, (...given: readonly Constant[]) => number | undefined>
>([
  ['Date', DATE_FUNCTIONS],
  ['JSON', new Map([['parse', parsedNumber]])],
]);

/**
 * The methods of text that answer a number of what they are given alone: `charCodeAt`, the code
 * unit at an index — of no number, the first — and `NaN` past the text's end.
 */
const TEXT_NUMBERS: ReadonlyMap<string, (text: string, ...given: readonly Constant[]) => number> =
  new Map([
    [
      'charCodeAt',
      (text, index = 0) => {
        const unit = text[Math.trunc(Number(index)) || 0];
        return unit?.codePointAt(0) ?? NaN;
      },
    ],
  ]);

/**
 * The functions of `Math` each engine approximates, of numbers alone, as V8 computes them — the
 * engine the authority and the compile both run: whether what they make of what the code writes is
 * finite, `Math.exp(1000)`, `Math.log(0)`, tells alike.
 */
const APPROXIMATE_MATH: ReadonlyMap<string, (...given: readonly number[]) => number> = new Map([
  ['acos', Math.acos],
  ['acosh', Math.acosh],
  ['asin', Math.asin],
  ['asinh', Math.asinh],
  ['atan2', Math.atan2],
  ['atan', Math.atan],
  ['atanh', Math.atanh],
  ['cbrt', Math.cbrt],
  ['cos', Math.cos],
  ['cosh', Math.cosh],
  ['exp', Math.exp],
  ['expm1', Math.expm1],
  ['hypot', Math.hypot],
  ['log1p', Math.log1p],
  ['log2', Math.log2],
  ['log10', Math.log10],
  ['log', Math.log],
  ['pow', Math.pow],
  ['sin', Math.sin],
  ['sinh', Math.sinh],
  ['tan', Math.tan],
  ['tanh', Math.tanh],
]);

/** The functions of `Math` the language defines exactly, of numbers alone. */
const EXACT_MATH: ReadonlyMap<string, (...given: readonly number[]) => number> = new Map([
  ['abs', Math.abs],
  ['ceil', Math.ceil],
  ['floor', Math.floor],
  ['fround', Math.fround],
  ['max', Math.max],
  ['min', Math.min],
  ['round', Math.round],
  ['sign', Math.sign],
  ['sqrt', Math.sqrt],
  ['trunc', Math.trunc],
]);

/**
 * The methods of a date that answer a number of its time read in no time zone — its time, its parts
 * in UTC — `NaN` of a date of none, `new Date('bad')`.
 */
const DATE_TIMES: ReadonlySet<string> = new Set([
  'getTime',
  'getUTCDate',
  'getUTCDay',
  'getUTCFullYear',
  'getUTCHours',
  'getUTCMilliseconds',
  'getUTCMinutes',
  'getUTCMonth',
  'getUTCSeconds',
  'valueOf',
]);

/**
 * The methods of a date that answer a number of its time read in the time zone where it runs, which
 * the authority's may not be the compile's: `NaN` alike of a date of none.
 */
const LOCAL_TIMES: ReadonlySet<string> = new Set([
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
]);

/** The methods of a date that set its time of what they are given in no time zone, and answer it. */
const SETTING_UTC: ReadonlySet<string> = new Set([
  'setTime',
  'setUTCDate',
  'setUTCFullYear',
  'setUTCHours',
  'setUTCMilliseconds',
  'setUTCMinutes',
  'setUTCMonth',
  'setUTCSeconds',
]);

/** The methods of a date that set its time of what they are given in the time zone where it runs. */
const SETTING_LOCAL: ReadonlySet<string> = new Set([
  'setDate',
  'setFullYear',
  'setHours',
  'setMilliseconds',
  'setMinutes',
  'setMonth',
  'setSeconds',
  'setYear',
]);

/**
 * Whether `method` is one of a date's that set its time, and answer it — `NaN` where it holds none
 * since — of which what made it, `new Date(0)`, tells no more (`local-writes.ts`).
 */
export function setsTime(method: string): boolean {
  return SETTING_UTC.has(method) || SETTING_LOCAL.has(method);
}

/** The most milliseconds a date's time is from the epoch, either way: past them, it holds none. */
const MAX_TIME = 8.64e15;

/**
 * The number a method of text the code writes answers (`TEXT_NUMBERS`), or a method of a date
 * (`dateCall`), `new Date('bad').getTime()`; none of another call.
 */
function textCall(
  callee: PropertyAccessExpression,
  given: readonly Constant[],
  names: Names,
): number | undefined {
  const target = unwrapped(callee.expression);
  const method = callee.name.text;
  if (DATE_TIMES.has(method) || LOCAL_TIMES.has(method) || setsTime(method)) {
    return dateCall(method, target, given, names);
  }
  const text = constantOperand(target, names);
  const compute = TEXT_NUMBERS.get(callee.name.text);
  return typeof text === 'string' && compute !== undefined ? compute(text, ...given) : undefined;
}

/**
 * The number a method of a date answers: of one the code writes, there or through a constant
 * (`timeOf`), of a time the same wherever and whenever the code runs (`fixedTime`), as the engine
 * computes it — but of what it reads or sets in the time zone where it runs, `NaN` alone where no
 * time zone holds a time (`localNaN`); of another, the clock's among them, what a setter answers
 * whatever the date — `NaN` of what is no finite number, `setTime(Infinity)`, or of a time past the
 * dates the language holds, `setTime(9e15)` — but none of what the code writes as no date
 * (`writtenOtherwise`), whose method is its own.
 */
function dateCall(
  method: string,
  target: Expression,
  given: readonly Constant[],
  names: Names,
): number | undefined {
  const time = timeOf(target, names, true);
  if (time === undefined) {
    return setsTime(method) && !writtenOtherwise(target, names)
      ? setWhatever(method, given)
      : undefined;
  }
  if (!DATE_TIMES.has(method) && !SETTING_UTC.has(method)) {
    return localNaN(method, time, given) ? NaN : undefined;
  }
  const date = new Date(time);
  const read = Reflect.get(date, method) as (...given: readonly number[]) => number;
  return Reflect.apply(read, date, given.map(Number));
}

/** The setters of a date's local time that start a date of none over, of the epoch: of a year. */
const RESTARTING: ReadonlySet<string> = new Set(['setFullYear', 'setYear']);

/**
 * Whether a method of a date that reads or sets its time in the time zone where it runs answers
 * `NaN` in every time zone: a read of a date of none, and a setting of one — but `setFullYear`,
 * which starts it over — or of what is no finite number (`setWhatever`). A time zone moves a time
 * by less than a day, so that a time near the dates the language holds is one in some time zones
 * and none in others: of it, none here.
 */
function localNaN(method: string, time: number, given: readonly Constant[]): boolean {
  if (LOCAL_TIMES.has(method)) {
    return Number.isNaN(time);
  }
  return (
    (Number.isNaN(time) && !RESTARTING.has(method)) || Number.isNaN(setWhatever(method, given) ?? 0)
  );
}

/**
 * What a date's setter answers whatever the date: `NaN` of what is no finite number — nothing given
 * first among it — and of `setTime`, of a time past the dates the language holds; none told else.
 */
function setWhatever(method: string, given: readonly Constant[]): number | undefined {
  const numbers = given.map(Number);
  const [first = NaN] = numbers;
  if (!Number.isFinite(first) || numbers.some((each) => !Number.isFinite(each))) {
    return NaN;
  }
  return method === 'setTime' && Math.abs(first) > MAX_TIME ? NaN : undefined;
}

/** What the code writes of a value of its own, whose methods are its own, or none at all. */
const OWN_VALUES: readonly ((node: Expression) => boolean)[] = [
  isArrayLiteralExpression,
  isArrowFunction,
  isClassExpression,
  isFunctionExpression,
  isObjectLiteralExpression,
];

/**
 * Whether the code writes `node` — there, or as what a constant it names holds (`names.resolve`)
 * — as what is no date: an object, an array, a function or a class of its own, whose method of a
 * date's name is its own, `({ setTime: () => 0 }).setTime(Infinity)`; what a class but the global
 * `Date` makes; or a number or text, which hold none. What it does not show is read as a date: a
 * method of a name of the language's, called on what the code does not show, is the language's.
 */
function writtenOtherwise(node: Expression, names: Names): boolean {
  let value = unwrapped(node);
  const following = new Set(names.following);
  while (isIdentifier(value) && !following.has(value.text)) {
    following.add(value.text);
    const held = names.resolve?.(value);
    if (held === undefined) {
      break;
    }
    value = unwrapped(held);
  }
  if (isNewExpression(value)) {
    return globalPathOf(unwrapped(value.expression))?.join('.') !== 'Date';
  }
  return (
    OWN_VALUES.some((own) => own(value)) ||
    constantOperand(value, { ...names, following }) !== undefined
  );
}

/** What `new Date(…)` is given, where it makes the global's of what the code writes alone. */
function dateGiven(made: NewExpression, names: Names): readonly Constant[] | undefined {
  const given = (made.arguments ?? []).map((argument) =>
    isSpreadElement(argument) ? undefined : constantOperand(argument, names),
  );
  return globalOf(unwrapped(made.expression)) !== 'Date' || given.includes(undefined)
    ? undefined
    : (given as readonly Constant[]);
}

/**
 * The time of `new Date(…)` of what the code writes, as the engine both sides run reads it — `NaN`
 * of text of no time, of a number past the dates it holds; none of another. Of no argument, it is
 * the time the compile reads of the clock, and of parts or text of no offset, the time they make in
 * the compile's time zone: a date the code makes, and whether it holds a time, all the same, but a
 * time another run need not hold (`fixedTime`).
 */
function dateTime(made: NewExpression, names: Names): number | undefined {
  const given = dateGiven(made, names);
  return given === undefined ? undefined : (Reflect.construct(Date, given) as Date).getTime();
}

/**
 * The time of `new Date(…)` of what the code writes where it is the same wherever and whenever the
 * code runs: of a number, and of text every time zone reads alike (`fixedText`) — `NaN` of parts
 * that make none in any time zone (`timeless`); none of the clock's, `new Date()`, nor of parts,
 * `new Date(2020, 0, 1)`, or of other text, which it reads in the time zone where it runs.
 */
function fixedTime(made: NewExpression, names: Names): number | undefined {
  const given = dateGiven(made, names);
  const [first] = given ?? [];
  if (given === undefined || first === undefined) {
    return undefined;
  }
  if (given.length > 1) {
    return timeless(given.map(Number)) ? NaN : undefined;
  }
  const time = (Reflect.construct(Date, given) as Date).getTime();
  return typeof first === 'number' || fixedText(first, time) ? time : undefined;
}

/**
 * Whether the parts of a date, `new Date(year, month, …)`, which it reads in the time zone where it
 * runs, make it of no time in any: of what is no finite number, or past the dates the language holds
 * a day either way of them read in UTC (`Date.UTC`), farther than any time zone is from it.
 */
function timeless(parts: readonly number[]): boolean {
  const [year, month, day = 1, ...rest] = parts;
  const whole = Math.trunc(day);
  return [whole - 1, whole + 1].every((near) =>
    Number.isNaN(Reflect.apply(Date.UTC, Date, [year, month, near, ...rest]) as number),
  );
}

/** Text in ISO's form of a date alone, `2020-01-01`, which every time zone reads as UTC. */
const ISO_DATE = /^(?:\d{4}|[+-]\d{6})(?:-\d{2}(?:-\d{2})?)?$/u;

/** The day of text in ISO's form of a day and a time, `2020-01-01` of `2020-01-01T00:00Z`. */
const ISO_DAY = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}$/u;

/** The time of text in ISO's form of a day and a time of an offset, `00:00Z`, `09:00+09:00`. */
const ISO_ZONED_TIME = /^\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Whether every time zone reads `text` alike as a date: in ISO's form of a date alone, or of a day
 * and a time of an offset — but of the year `-000000`, of no form of ISO's, which the engine reads
 * otherwise, in the time zone where it runs.
 */
function zonelessText(text: string): boolean {
  if (text.startsWith('-000000')) {
    return false;
  }
  const at = text.indexOf('T');
  return (
    ISO_DATE.test(text) ||
    (at !== -1 && ISO_DAY.test(text.slice(0, at)) && ISO_ZONED_TIME.test(text.slice(at + 1)))
  );
}

/**
 * The time of a date the code writes — `new Date('bad')`, or the name of a constant that holds one
 * — as `dateTime` reads it, the names it reads as what `resolve` answers they hold; none of another.
 */
export function writtenTime(node: Expression, resolve?: Resolve): number | undefined {
  return timeOf(node, { following: new Set(), resolve });
}

/**
 * The time of a date the code writes (`writtenTime`), but of a name followed on the way already —
 * or, `fixed`, where it is the same wherever and whenever the code runs (`fixedTime`).
 */
function timeOf(node: Expression, names: Names, fixed = false): number | undefined {
  const value = unwrapped(node);
  if (isNewExpression(value)) {
    return fixed ? fixedTime(value, names) : dateTime(value, names);
  }
  if (!isIdentifier(value) || names.following.has(value.text)) {
    return undefined;
  }
  const held = names.resolve?.(value);
  const following = new Set([...names.following, value.text]);
  return held === undefined ? undefined : timeOf(held, { ...names, following }, fixed);
}

/**
 * The number a call of the language's answers of what the code writes alone — `Number('bad')`,
 * `parseInt('x', 10)`, `Math.sqrt(-1)`, `Math.max()`, `Math.exp(1000)`, `Date.parse('bad')`,
 * `'x'.charCodeAt(2)`, `JSON.parse('1e400')` — as it computes it; none of another call,
 * `Math.random()` among them.
 */
function constantCall(call: CallExpression, names: Names): number | undefined {
  const callee = unwrapped(call.expression);
  const member = isPropertyAccessExpression(callee);
  const target = member ? globalOf(unwrapped(callee.expression)) : undefined;
  const given = call.arguments.map((argument) =>
    isSpreadElement(argument) ? undefined : constantOperand(argument, names),
  );
  if (given.includes(undefined)) {
    return undefined;
  }
  // `options.parseFloat('x')`: a method of a value of the application's, none of the language's —
  // but of text the code writes, `'x'.charCodeAt(2)`.
  if (member && target === undefined) {
    return textCall(callee, given as readonly Constant[], names);
  }
  const name = member ? callee.name.text : globalOf(callee);
  if (name === undefined) {
    return undefined;
  }
  const values = given as readonly Constant[];
  const functions = target === undefined ? undefined : GLOBAL_FUNCTIONS.get(target);
  if (functions !== undefined) {
    return functions.get(name)?.(...values);
  }
  if (target === 'Math') {
    const compute = EXACT_MATH.get(name) ?? APPROXIMATE_MATH.get(name);
    return compute === undefined || values.some((each) => typeof each !== 'number')
      ? undefined
      : compute(...(values as readonly number[]));
  }
  const compute =
    target === undefined || target === 'Number' ? NUMBER_FUNCTIONS.get(name) : undefined;
  // `Number.Number` is none of the language's: of `Number`, its `parseInt` and `parseFloat` alone.
  return compute === undefined || (target === 'Number' && name === 'Number')
    ? undefined
    : compute(...values);
}
