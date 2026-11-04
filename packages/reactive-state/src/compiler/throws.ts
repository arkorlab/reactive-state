import {
  type CallExpression,
  type Expression,
  isBigIntLiteral,
  isCallExpression,
  isNewExpression,
  isPrefixUnaryExpression,
  isRegularExpressionLiteral,
  isSpreadElement,
  isVoidExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { borrowedCall, borrowedResultThrows } from './borrowed-calls.ts';
import { calledMember, globalOf, unwrapped } from './bounded.ts';
import { runsLater } from './deferred-syntax.ts';
import { type Constant, constantValue, type Resolve, writtenTime } from './numbers.ts';
import { skipsEvaluation } from './skipped-evaluation.ts';
import { expandedInvocation } from './throw-arguments.ts';
import { arrayLocaleThrows } from './throw-array-locales.ts';
import { binaryBigIntThrows } from './throw-bigints.ts';
import {
  borrowedReceiverThrows,
  callbackKindsThrow,
  madeKindsThrow,
  prototypeArgumentThrows,
  reflectedTargetThrows,
} from './throw-brands.ts';
import { globalCalleePath } from './throw-callees.ts';
import { heritageThrows, eagerClassExpressions } from './throw-classes.ts';
import { aggregateArgumentThrows, groupingCallbackThrows } from './throw-collections.ts';
import { constructOnlyCallThrows } from './throw-construct-only.ts';
import { deletesLocked } from './throw-deletes.ts';
import { iterationSyntaxThrows } from './throw-iteration-syntax.ts';
import { propertyKeyThrows } from './throw-keys.ts';
import { kindsThrow, madeBufferThrows, madeElementsThrow } from './throw-kinds.ts';
import { LOCALE_TAKERS, localeMethodThrows } from './throw-locales.ts';
import { nativeArgumentThrows } from './throw-native-arguments.ts';
import { nativeCollectionThrows } from './throw-native-collections.ts';
import { abstractIteratorThrows, additionalNativeCallThrows } from './throw-native-next.ts';
import { membershipThrows } from './throw-operators.ts';
import { PLATFORM_SHAPED, platformMadeThrows, platformMethodThrows } from './throw-platform.ts';
import { privateBrandThrows } from './throw-private-brands.ts';
import { rawTemplateThrows } from './throw-raw-templates.ts';
import { dereferenceThrows, shortedReceiver } from './throw-reads.ts';
import { regexpEscapeThrows } from './throw-regexp-escape.ts';
import { registryArgumentThrows } from './throw-registries.ts';
import { setArgumentThrows } from './throw-sets.ts';
import {
  appliesNoList,
  atomicsThrow,
  firstThrows,
  ownsMethods,
  primitiveOf,
  SHAPED,
  typedThrows,
  viewedThrows,
  wholeOf,
  writtenOf,
} from './throw-shapes.ts';
import { staticFactoryThrows } from './throw-static-factories.ts';
import { coercesSymbol, isSymbolWritten, unaryBigIntThrows } from './throw-symbols.ts';
import { tdzCallThrows } from './throw-tdz-reads.ts';
import { throwsTried } from './throw-tried.ts';
import { locksViewThrows } from './throw-views.ts';
import { wasmMadeThrows } from './throw-wasm.ts';
import { lockedWriteThrows } from './throw-writes.ts';

/**
 * What a call of the language's functions, or a construction of its classes, throws of what the code
 * writes, as the engine both sides run, V8, throws it — `String.fromCodePoint(0x110000)`,
 * `decodeURIComponent('%')`, `'x'.repeat(-1)`, `(1).toFixed(101)`, `(1).toString(1)`,
 * `text.normalize('bad')`, `new Date('bad').toISOString()`, `new RegExp('[')`, `'x'.match('[')`,
 * `Array.from({ length: 2 ** 32 })`, `Object.fromEntries([null])` — wherever the code computes it
 * as it computes a value (`throwsWithin`), so that a state that starts of one is refused as it
 * compiles, rather than its value thrown of as the page first renders (the checks of what no JSON
 * holds, `json-values.ts`). Of a value the code does not write, none it tells: the authority meets
 * what it throws of one as it renders.
 */

/** What a call is given, as the code writes it: numbers and text. */
type Given = readonly Constant[];

/** What a method is called on, as the code writes it; none told, `undefined`. */
type Target = Constant | undefined;

/** The longest text V8 makes, 2²⁹ − 24 characters: what would make longer throws. */
const MAX_TEXT = 0x1f_ff_ff_e8;

/** The most digits a number's text is made of by `toFixed`, `toExponential`, `toPrecision`. */
const MOST_DIGITS = 100;

/** The radices a number's `toString` takes, from the least to the most. */
const RADICES = { least: 2, most: 36 } as const;

/** The methods of a date that throw of one of no time, `new Date('bad')`: `toISOString`. */
const TIMED: ReadonlySet<string> = new Set(['toISOString']);

/** The forms `normalize` takes. */
const FORMS: ReadonlySet<string> = new Set(['NFC', 'NFD', 'NFKC', 'NFKD']);

/**
 * The functions of globals that throw of some of what they are given, tried as they are — and
 * `Array` and `RegExp`, which a call makes as `new` does (`TRIED_CONSTRUCTORS`).
 */
const TRIED_GLOBALS: ReadonlyMap<string, (given: Given) => unknown> = new Map([
  ['Array', (given: Given): unknown => Reflect.apply(Array, undefined, given)],
  // Of text of no base64, and of characters past Latin-1, which no base64 is made of.
  ['atob', (given: Given) => atob(String(given[0]))],
  ['btoa', (given: Given) => btoa(String(given[0]))],
  ['decodeURI', (given: Given) => decodeURI(String(given[0]))],
  ['decodeURIComponent', (given: Given) => decodeURIComponent(String(given[0]))],
  ['encodeURI', (given: Given) => encodeURI(String(given[0]))],
  ['encodeURIComponent', (given: Given) => encodeURIComponent(String(given[0]))],
  // Of a key of none of the lists of values it answers: a calendar, a currency and their kin.
  [
    'Intl.supportedValuesOf',
    (given: Given): unknown => Reflect.apply(Intl.supportedValuesOf, Intl, given),
  ],
  ['RegExp', (given: Given): unknown => Reflect.apply(RegExp, undefined, given)],
  ['String.fromCodePoint', (given: Given) => String.fromCodePoint(...given.map(Number))],
]);

/**
 * The globals of no class, which `new` throws of: `BigInt`, `Symbol`, which a call alone makes, and
 * the language's namespaces, `Math`, `JSON`, `Reflect`, `Atomics`, `Intl` — and their functions,
 * `new Math.max()`, but `Intl`'s classes.
 */
const NO_CLASSES: ReadonlySet<string> = new Set([
  'Atomics',
  'BigInt',
  'Intl',
  'JSON',
  'Math',
  'Reflect',
  'Symbol',
]);

/** Whether `new` throws of the global `path` names, of no class (`NO_CLASSES`). */
function isNoClass(path: string): boolean {
  const [root = ''] = path.split('.', 1);
  return NO_CLASSES.has(path) || (root !== 'Intl' && path !== root && NO_CLASSES.has(root));
}

/**
 * The classes of globals whose construction throws of some of what it is given, tried as it is: a
 * length no array holds, `new Array(-1)`; no pattern, `new RegExp('[')`; no URL, `new URL('x')`.
 */
const TRIED_CONSTRUCTORS: ReadonlyMap<string, (given: Given) => unknown> = new Map([
  ['Array', (given: Given): unknown => Reflect.construct(Array, given)],
  ['RegExp', (given: Given): unknown => Reflect.construct(RegExp, given)],
  ['URL', (given: Given): unknown => Reflect.construct(URL, given)],
]);

/**
 * The classes of globals whose construction throws of a size it is given first below none or past
 * 2⁵³ − 1 — a buffer, a typed array — which no size within is tried of, as it would be allocated.
 */
const SIZED: ReadonlySet<string> = new Set([
  'ArrayBuffer',
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'SharedArrayBuffer',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
]);

/** The methods of text that throw of a pattern of no `g` given first: `matchAll`, `replaceAll`. */
const GLOBAL_PATTERNS: ReadonlySet<string> = new Set(['matchAll', 'replaceAll']);

/**
 * The methods of text and of numbers that throw of some of what they are given, by what they are
 * given and what they are called on, where the code writes it.
 */
const TRIED_METHODS: ReadonlyMap<string, (target: Target, given: Given) => boolean> = new Map([
  [
    'compile',
    (_target: Target, given: Given) =>
      patternThrows(given[0], given[1] === undefined ? '' : String(given[1])),
  ],
  ['match', (_target: Target, given: Given) => patternThrows(given[0], '')],
  ['matchAll', (_target: Target, given: Given) => patternThrows(given[0], 'g')],
  [
    'normalize',
    (_target: Target, given: Given) => given.length > 0 && !FORMS.has(String(given[0])),
  ],
  ['padEnd', (_target: Target, given: Given) => padsPast(given)],
  ['padStart', (_target: Target, given: Given) => padsPast(given)],
  ['repeat', repeatsPast],
  ['search', (_target: Target, given: Given) => patternThrows(given[0], '')],
  ['toExponential', (target: Target, given: Given) => digitsPast(target, given, 0)],
  ['toFixed', (_target: Target, given: Given) => outOf(wholeOf(given[0]), 0)],
  ['toPrecision', (target: Target, given: Given) => digitsPast(target, given, 1)],
  ['toString', radixPast],
]);

/**
 * The call or the construction within `node` that throws of what the code writes
 * (`throwsOfWritten`, `constructsThrowing`), wherever the code computes it as it computes `node` —
 * what a method is called on, `new RegExp('[').test(text)`, what a call is given, an operand, a
 * condition — but within a function the code writes there, which runs where it is called, and is
 * read so; none where none throws.
 */
export function throwsWithin(node: Expression, resolve: Resolve | undefined): Node | undefined {
  let found: Node | undefined;
  const visit = (each: Node): void => {
    if (found !== undefined || skipsEvaluation(each, resolve)) {
      return;
    }
    if (heritageThrows(each, resolve)) {
      found = each;
      return;
    }
    const eager = eagerClassExpressions(each);
    if (eager !== undefined) {
      // Static blocks need the callback walker's try/catch-aware statement flow.
      for (const part of eager) {
        visit(part);
      }
      return;
    }
    if (runsLater(each)) {
      return;
    }
    const receiver = shortedReceiver(each, resolve);
    if (receiver !== undefined) {
      visit(receiver);
      return;
    }
    if (operationThrows(each, resolve)) {
      found = each;
      return;
    }
    each.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** A synchronous native operation whose written receiver or operands establish its exception. */
function operationThrows(node: Node, resolve: Resolve | undefined): boolean {
  return (
    privateBrandThrows(node, resolve) ||
    nativeArgumentThrows(node, resolve) ||
    nativeCollectionThrows(node, resolve) ||
    tdzCallThrows(node, resolve) ||
    (isCallExpression(node) && throwsOfWritten(node, resolve)) ||
    (isNewExpression(node) && constructsThrowing(node, resolve)) ||
    coercesSymbol(node, resolve) ||
    unaryBigIntThrows(node, resolve) ||
    binaryBigIntThrows(node, resolve) ||
    propertyKeyThrows(node, resolve) ||
    dereferenceThrows(node, resolve) ||
    membershipThrows(node, resolve) ||
    deletesLocked(node, resolve) ||
    lockedWriteThrows(node, resolve) ||
    iterationSyntaxThrows(node, resolve)
  );
}

/**
 * Whether `made`, a construction of a global's class, throws of what the code writes it is given
 * (`TRIED_CONSTRUCTORS`, `SIZED`, `SHAPED`), the names it reads as what `resolve` answers they
 * hold; of what the code does not write, none it tells.
 */
function constructsThrowing(node: NewExpression, resolve: Resolve | undefined): boolean {
  const made = expandedInvocation(node, resolve);
  const path = globalCalleePath(made.expression, resolve)?.join('.');
  if (cannotConstruct(node, path, resolve)) {
    return true;
  }
  const args = made.arguments ?? [];
  if (path === undefined || args.some((each) => isSpreadElement(each))) {
    return false;
  }
  const shaped = SHAPED.get(path) ?? LOCALE_TAKERS.get(path);
  if (shaped !== undefined) {
    return shaped(args, resolve);
  }
  if (
    aggregateArgumentThrows(path, args, resolve) ||
    wasmMadeThrows(path, args, resolve) ||
    platformMadeThrows(path, args, resolve) ||
    typedThrows(path, args, resolve) ||
    madeElementsThrow(path, args, resolve) ||
    madeBufferThrows(path, args, resolve) ||
    madeKindsThrow(path, args, resolve)
  ) {
    return true;
  }
  const given = args.map((each) => constantValue(each, resolve));
  if (given.includes(undefined)) {
    return false;
  }
  const values = given as Given;
  if (SIZED.has(path)) {
    const size = wholeOf(values[0]);
    return size < 0 || size > Number.MAX_SAFE_INTEGER;
  }
  const tried = TRIED_CONSTRUCTORS.get(path);
  return tried !== undefined && throwsTried(tried, values);
}

/** Nonconstructible namespaces and the abstract direct Iterator construction. */
function cannotConstruct(
  node: NewExpression,
  path: string | undefined,
  resolve: Resolve | undefined,
): boolean {
  return (path !== undefined && isNoClass(path)) || abstractIteratorThrows(node, resolve);
}

/**
 * Whether `call`, of a global's function or of a method of text or of a number, throws of what the
 * code writes it is given (`TRIED_GLOBALS`, `TRIED_METHODS`, `SHAPED`, `GLOBAL_PATTERNS`) — or of a
 * date, of what the code writes it is of (`TIMED`) — the names it reads as what `resolve` answers
 * they hold; of a value the code does not write, none it tells.
 */
export function throwsOfWritten(
  node: CallExpression,
  resolve: Resolve | undefined,
  isBorrowed = false,
): boolean {
  const call = expandedInvocation(node, resolve);
  const callee = unwrapped(call.expression);
  const path = globalCalleePath(callee, resolve)?.join('.') ?? '';
  if (throwsOfShape(call, path, resolve, isBorrowed)) {
    return true;
  }
  const borrowed = borrowedCall(call, resolve);
  if (
    borrowed !== undefined &&
    (borrowedResultThrows(borrowed, resolve) ||
      (borrowed.ordinary && throwsOfWritten(borrowed.call, resolve, true)))
  ) {
    return true;
  }
  const shaped = call.arguments.some((each) => isSpreadElement(each))
    ? undefined
    : (SHAPED.get(path) ?? LOCALE_TAKERS.get(path) ?? PLATFORM_SHAPED.get(path));
  if (
    shaped?.(call.arguments, resolve) === true ||
    takesNoGlobal(callee, call.arguments[0], resolve)
  ) {
    return true;
  }
  const given = call.arguments.map((each) =>
    isSpreadElement(each) ? undefined : constantValue(each, resolve),
  );
  if (given.includes(undefined)) {
    return false;
  }
  const values = given as Given;
  const tried = TRIED_GLOBALS.get(path);
  return tried === undefined
    ? methodThrows(callee, values, resolve, isBorrowed)
    : throwsTried(tried, values);
}

/** Whether a value's method throws of its written receiver and arguments. */
function methodThrows(
  callee: Expression,
  values: Given,
  resolve: Resolve | undefined,
  isBorrowed: boolean,
): boolean {
  const member = calledMember(callee);
  if (member === undefined) {
    return false;
  }
  if (TIMED.has(member.name)) {
    return Number.isNaN(writtenTime(member.of, resolve) ?? 0);
  }
  if (viewedThrows(member.name, member.of, values[0], resolve)) {
    return true;
  }
  // `helpers.normalize(text)` of a module's namespace, an object's own `toFixed`: none of text's.
  const method = TRIED_METHODS.get(member.name);
  const target =
    member.name === 'toString' && numericRadixReceiver(member.of, resolve, isBorrowed)
      ? 0
      : constantValue(member.of, resolve);
  return (
    method !== undefined &&
    (isBorrowed || !ownsMethods(member.of, resolve)) &&
    method(target, values)
  );
}

/**
 * Whether `call`, of `callee` at the global `path`, throws of how it is called or of the shape of what
 * it is given, before what it is given is tried: a class called without `new` (`CONSTRUCTED_ONLY`),
 * nothing where something is needed, `Atomics`' functions, `apply` of no list, locales of no tag,
 * the kind of what it is given — a descriptor, a typed array's element, a `bigint`
 * (`throw-kinds.ts`) — the platform's methods, tried (`platformMethodThrows`), a method of a
 * class's own borrowed for what is none of the class's (`borrowedReceiverThrows`), and a callback of
 * no function (`callbackKindsThrow`).
 */
function throwsOfShape(
  call: CallExpression,
  path: string,
  resolve: Resolve | undefined,
  isBorrowed: boolean,
): boolean {
  const callee = unwrapped(call.expression);
  return (
    nativeSyntaxThrows(call, path, resolve) ||
    aggregateArgumentThrows(path, call.arguments, resolve) ||
    groupingCallbackThrows(path, call.arguments, resolve) ||
    registryArgumentThrows(callee, call.arguments, resolve) ||
    firstThrows(path, call.arguments[0], resolve) ||
    locksViewThrows(path, call.arguments, resolve) ||
    prototypeArgumentThrows(path, call.arguments, resolve) ||
    reflectedTargetThrows(path, call.arguments, resolve) ||
    setArgumentThrows(callee, call.arguments, resolve) ||
    (path === 'Iterator.from' &&
      call.arguments[0] !== undefined &&
      !isSpreadElement(call.arguments[0]) &&
      isSymbolWritten(call.arguments[0], resolve)) ||
    atomicsThrow(path, call.arguments, resolve) ||
    appliesNoList(callee, call.arguments, resolve) ||
    localeMethodThrows(callee, call.arguments, resolve) ||
    kindsThrow(callee, path, call.arguments, resolve) ||
    platformMethodThrows(callee, call.arguments, resolve) ||
    borrowedReceiverThrows(callee, call.arguments, resolve) ||
    writtenCallbackThrows(call, path, resolve, isBorrowed)
  );
}

/** Construct-only and raw-template shapes are independent of ordinary callback positions. */
function nativeSyntaxThrows(
  call: CallExpression,
  path: string,
  resolve: Resolve | undefined,
): boolean {
  return (
    constructOnlyCallThrows(call, path, resolve) ||
    rawTemplateThrows(call, path, resolve) ||
    additionalNativeCallThrows(call, path, resolve) ||
    regexpEscapeThrows(call, resolve) ||
    arrayLocaleThrows(call, resolve)
  );
}

/** Forwarded static factories shift their callback arguments past their explicit receiver. */
function writtenCallbackThrows(
  call: CallExpression,
  path: string,
  resolve: Resolve | undefined,
  borrowed: boolean,
): boolean {
  return (
    staticFactoryThrows(call, resolve) ??
    callbackKindsThrow(unwrapped(call.expression), path, call.arguments, { resolve, borrowed })
  );
}

/** Whether `digits` is past the digits a number's text is made of, from `lowest` to `MOST_DIGITS`. */
function outOf(digits: number, lowest: number): boolean {
  return digits < lowest || digits > MOST_DIGITS;
}

/**
 * Whether `toExponential` or `toPrecision` throws of the digits it is given — past `lowest` to
 * `MOST_DIGITS` — of a number that is finite, or that the code does not write; of no digits given,
 * it throws not.
 */
function digitsPast(target: Target, given: Given, lowest: number): boolean {
  const [digits] = given;
  if (digits === undefined || (typeof target === 'number' && !Number.isFinite(target))) {
    return false;
  }
  return outOf(wholeOf(digits), lowest);
}

/** Whether `padStart` or `padEnd` throws of the length it is given: past `MAX_TEXT`, of any fill. */
function padsPast(given: Given): boolean {
  const [length, fill] = given;
  return fill !== '' && wholeOf(length) > MAX_TEXT;
}

/**
 * Whether `repeat` throws of the count it is given: below zero, or of no end; of text the code
 * writes, past `MAX_TEXT` repeated.
 */
function repeatsPast(target: Target, given: Given): boolean {
  const count = wholeOf(given[0]);
  if (count === Infinity || count < 0) {
    return true;
  }
  return typeof target === 'string' && target.length * count > MAX_TEXT;
}

/**
 * A numeric radix receiver where the syntax proves one, without needing its actual numeric value.
 */
function numericRadixReceiver(
  receiver: Expression,
  resolve: Resolve | undefined,
  borrowed: boolean,
): boolean {
  const value = writtenOf(receiver, resolve);
  if (
    borrowed ||
    isBigIntLiteral(value) ||
    (isPrefixUnaryExpression(value) &&
      [SyntaxKind.MinusToken, SyntaxKind.PlusToken, SyntaxKind.TildeToken].includes(value.operator))
  ) {
    return true;
  }
  if (isCallExpression(value) || isNewExpression(value)) {
    const path = globalCalleePath(value.expression, resolve) ?? [];
    return (
      path[0] === 'Math' ||
      [
        'BigInt',
        'BigInt.asIntN',
        'BigInt.asUintN',
        'Number',
        'Number.parseFloat',
        'Number.parseInt',
        'parseFloat',
        'parseInt',
      ].includes(path.join('.'))
    );
  }
  return false;
}

/**
 * Whether numeric toString throws of its radix. An unknown receiver's nonnumeric text argument may
 * name a different conversion, such as Buffer's encoding, so it is left for runtime checking.
 */
function radixPast(target: Target, given: Given): boolean {
  const [radix] = given;
  if (radix === undefined || typeof target === 'string') {
    return false;
  }
  if (target === undefined && typeof radix === 'string' && Number.isNaN(Number(radix))) {
    return false;
  }
  const whole = wholeOf(radix);
  return whole < RADICES.least || whole > RADICES.most;
}

/** Whether making a pattern of `source`, text, of `flags` throws: `'['`, of no pattern. */
function patternThrows(source: Constant | undefined, flags: string): boolean {
  return (
    typeof source === 'string' &&
    throwsTried((given): unknown => Reflect.construct(RegExp, given), [source, flags])
  );
}

/**
 * Whether `callee`, of text's `matchAll` or `replaceAll` (`GLOBAL_PATTERNS`), throws of the pattern
 * it is given first: one the code writes of no `g`, `/a/`, `new RegExp('a')` — but a method of
 * those names of a value of its own (`ownsMethods`).
 */
function takesNoGlobal(
  callee: Expression,
  first: Expression | undefined,
  resolve: Resolve | undefined,
): boolean {
  const member = calledMember(callee);
  if (
    first === undefined ||
    member === undefined ||
    !GLOBAL_PATTERNS.has(member.name) ||
    ownsMethods(member.of, resolve)
  ) {
    return false;
  }
  const flags = flagsOf(unwrapped(first));
  return flags !== undefined && !flags.includes('g');
}

/**
 * The flags of a pattern the code writes — `/a/g`, `new RegExp('a', 'g')`, `RegExp(/a/g)` — none
 * of what it does not write, or of no pattern.
 */
function flagsOf(pattern: Expression): string | undefined {
  if (isRegularExpressionLiteral(pattern)) {
    return pattern.text.slice(pattern.text.lastIndexOf('/') + 1);
  }
  if (
    !(isNewExpression(pattern) || isCallExpression(pattern)) ||
    globalOf(unwrapped(pattern.expression)) !== 'RegExp'
  ) {
    return undefined;
  }
  const [source, flags] = pattern.arguments ?? [];
  if (
    flags !== undefined &&
    globalOf(unwrapped(flags)) !== 'undefined' &&
    !isVoidExpression(unwrapped(flags))
  ) {
    const written = constantValue(flags);
    return typeof written === 'string' ? written : undefined;
  }
  // Omitted or undefined flags keep a pattern's own; an unknown source may be such a pattern.
  if (source === undefined) {
    return '';
  }
  const written = unwrapped(source);
  if (isRegularExpressionLiteral(written)) {
    return written.text.slice(written.text.lastIndexOf('/') + 1);
  }
  return primitiveOf(written, undefined) === undefined ? undefined : '';
}
