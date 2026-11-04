import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
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
 * The functions of `Date` that answer a number of what they are given alone: `Date.UTC`, as the
 * language defines it, and `Date.parse`, of text, as the engine reads it — the one the authority
 * and the compile both run, V8 — `NaN` of text it reads no time of.
 */
const DATE_FUNCTIONS: ReadonlyMap<string, (...given: readonly Constant[]) => number> = new Map([
  ['parse', (...given) => Date.parse(String(given[0]))],
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
 * (`timeOf`), as the engine computes it — but of what it reads or sets in the time zone where it
 * runs, `NaN` alone; of another, what a setter answers whatever the date — `NaN` of what is no
 * finite number, `setTime(Infinity)`, or of a time past the dates the language holds, `setTime(9e15)`.
 */
function dateCall(
  method: string,
  target: Expression,
  given: readonly Constant[],
  names: Names,
): number | undefined {
  const time = timeOf(target, names);
  if (time === undefined) {
    return setsTime(method) ? setWhatever(method, given) : undefined;
  }
  const date = new Date(time);
  const read = Reflect.get(date, method) as (...given: readonly number[]) => number;
  const answered = Reflect.apply(read, date, given.map(Number));
  const isExact = DATE_TIMES.has(method) || SETTING_UTC.has(method);
  return isExact || Number.isNaN(answered) ? answered : undefined;
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

/**
 * The time of `new Date(…)` of what the code writes, as the engine both sides run reads it — `NaN`
 * of text of no time, of a number past the dates it holds; none of another.
 */
function dateTime(made: NewExpression, names: Names): number | undefined {
  const given = (made.arguments ?? []).map((argument) =>
    isSpreadElement(argument) ? undefined : constantOperand(argument, names),
  );
  if (globalOf(unwrapped(made.expression)) !== 'Date' || given.includes(undefined)) {
    return undefined;
  }
  return (Reflect.construct(Date, given) as Date).getTime();
}

/**
 * The time of a date the code writes — `new Date('bad')`, or the name of a constant that holds one
 * — as `dateTime` reads it, the names it reads as what `resolve` answers they hold; none of another.
 */
export function writtenTime(node: Expression, resolve?: Resolve): number | undefined {
  return timeOf(node, { following: new Set(), resolve });
}

/** The time of a date the code writes (`writtenTime`), but of a name followed on the way already. */
function timeOf(node: Expression, names: Names): number | undefined {
  const value = unwrapped(node);
  if (isNewExpression(value)) {
    return dateTime(value, names);
  }
  if (!isIdentifier(value) || names.following.has(value.text)) {
    return undefined;
  }
  const held = names.resolve?.(value);
  const following = new Set([...names.following, value.text]);
  return held === undefined ? undefined : timeOf(held, { ...names, following });
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
