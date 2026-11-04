import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isClassExpression,
  isComputedPropertyName,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isRegularExpressionLiteral,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { literalKey, type MemberValue } from './exported-values.ts';
import { callsNonJsonGlobal } from './global-answers.ts';
import { constantNumber, type Resolve, writtenTime } from './numbers.ts';
import { fillsWhole } from './retained.ts';

/**
 * How the checks of what no JSON holds read a value (`json-values.ts`): what they follow of a name,
 * what they are told of one, what the language makes that no JSON holds, what of an object
 * `Array.from` reads as an array-like, and what a pattern captures nothing of.
 */

/** The operators that answer one of their operands. */
export const ANSWERING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** How deeply JSON may nest, as the authority holds it to (`authority/canonical.ts`). */
export const MAX_DEPTH = 64;

/** The arrays and objects the checks of what no JSON holds found nested deeper than JSON may. */
const TOO_DEEP = new WeakSet<Node>();

/** The names the checks of what no JSON holds found of constants the code changes since. */
const CHANGED = new WeakSet<Node>();

/** Marks `found` as nested deeper than JSON may (`whyNonJson`). */
export function markTooDeep(found: Node): void {
  TOO_DEEP.add(found);
}

/** Marks `found` as a name of a constant the code changes since it declares it (`whyNonJson`). */
export function markChanged(found: Node): void {
  CHANGED.add(found);
}

/** Why `found` is refused as no JSON: what it is, how deep it nests, or how the code changes it. */
export function whyNonJson(found: Node): string {
  if (CHANGED.has(found)) {
    return 'the code changes after it declares it — a property defined, a value put in that no JSON holds, or handed where the compile does not follow it — so that it may hold what no JSON holds';
  }
  return TOO_DEEP.has(found)
    ? `nests more than ${String(MAX_DEPTH)} arrays and objects deep, which no JSON the authority holds does`
    : 'no JSON holds';
}

/**
 * How `nonJsonOf` reads a value: as an object's entry, which may hold `undefined`, which JSON leaves
 * out; a name of the code's as what `follow` answers it holds, but one `isChanged` says the code
 * changes since, and as what no JSON holds where `holdsNonJson` or `isChanged` says it is so; each
 * name followed on the way to it (`followed`), which it follows no more.
 */
export interface JsonReading {
  readonly entry?: boolean | undefined;
  readonly follow?: ((name: Identifier) => Expression | undefined) | undefined;
  /**
   * Whether the code changes the constant a name names after it declares it, of which what its
   * initializer writes tells no more: a value of no JSON put in, read as `reading` reads where it
   * stands, a property defined (`local-writes.ts`).
   */
  readonly isChanged?: ((name: Identifier, reading: JsonReading) => boolean) | undefined;
  /**
   * Whether a name holds what no JSON holds where it stands — `entry` where it is an object's
   * entry's value — a function the server part declares, an import of one.
   */
  readonly holdsNonJson?: ((name: Identifier, entry: boolean) => boolean) | undefined;
  /**
   * Whether a member read of a name holds what no JSON holds where it stands: `panels.fill` of
   * `import * as panels`, `payload.when` of `export const payload = { when: new Date(0) }`.
   */
  readonly isNonJsonMember?: ((node: Expression, entry: boolean) => boolean) | undefined;
  /**
   * Whether a call answers what no JSON holds — a promise, of an `async` function a module exports,
   * or a function it is given, of `identity<T>(value: T): T` — read, with what it is given, as
   * `reading` reads the call.
   */
  readonly isNonJsonCall?: ((node: CallExpression, reading: JsonReading) => boolean) | undefined;
  readonly followed?: ReadonlySet<string> | undefined;
  /** How deep in the value it stands: its arrays and objects around it. */
  readonly depth?: number | undefined;
  /**
   * How a call reads what it calls where the code stands (`CallScope`): of none, the component's
   * names; of a shared module's function's code, its module's.
   */
  readonly scope?: CallScope | undefined;
  /** The functions whose answers are read on the way to it, of which a call answers as it does. */
  readonly calling?: ReadonlySet<Node> | undefined;
}

/** How a call reads what it calls, of the names where its code stands: a component's, a module's. */
export interface CallScope {
  /** The function a call of `callee` calls, of code the compile reads; none of another. */
  readonly functionOf: (callee: Expression, reading: JsonReading) => Answering | undefined;
  /** What a module declares of what `node` reads of an import; none of anything else. */
  readonly importedOf?: (node: Expression) => MemberValue | undefined;
  /** Whether `node` reads an import, of which the compile tells nothing it does not read. */
  readonly isImport: (node: Expression) => boolean;
}

/**
 * `node` past what answers of what it is of alike — parentheses, a cast — and a name of the code's,
 * as what `reading.follow` answers it holds, but a name followed on the way to it already, or of a
 * constant the code changes since (`isChanged`); and the reading of what it reaches, with each name
 * it followed. `+value` and `-value` make a number of what they are given, and stand as they are
 * (`makesNonFinite`).
 */
export function reached(
  node: Expression,
  reading: JsonReading,
): { readonly at: JsonReading; readonly value: Expression } {
  let value = unwrapped(node);
  let followed = reading.followed ?? new Set<string>();
  for (;;) {
    const name =
      isIdentifier(value) && globalOf(value) === undefined && !followed.has(value.text)
        ? value
        : undefined;
    const held =
      name === undefined || reading.isChanged?.(name, reading) === true
        ? undefined
        : reading.follow?.(name);
    if (name === undefined || held === undefined) {
      return { at: { ...reading, followed }, value };
    }
    followed = new Set([...followed, name.text]);
    value = unwrapped(held);
  }
}

/**
 * What `reading` follows a name to (`JsonReading.follow`), but a constant the code changes since it
 * declares it (`isChanged`) — a date whose time it sets — of which what its initializer writes
 * tells no more: none.
 */
export function followedOf(reading: JsonReading): Resolve {
  return (name) =>
    reading.isChanged?.(name, reading) === true ? undefined : reading.follow?.(name);
}

/**
 * Whether `value`, as `reached` leaves it, names a constant the code changes since it declares it
 * (`JsonReading.isChanged`), which may hold anything.
 */
export function isChangedName(value: Expression, reading: JsonReading): boolean {
  return isIdentifier(value) && reading.isChanged?.(value, reading) === true;
}

/**
 * The names of an object's entries by which `Array.from` reads it as an array-like beside its
 * elements: its `length`, and its prototype, whose elements it inherits.
 */
const ARRAY_LIKE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'length']);

/**
 * Whether `node` may be what `Array.from` reads as an array-like of an element it lacks, which it
 * makes `undefined`: an object the code writes, through its constants, of a `length` — or of an
 * entry it does not name, a key it computes, a prototype, `__proto__:`, whose elements it inherits,
 * and what it spreads, read so in turn — what a spread hands, which may stand at any place, and a
 * constant the code changes since it declares it. An array or text it iterates; a value the code
 * does not show is read as JSON of its type, as ever.
 */
export function lacksElement(node: Expression, reading: JsonReading): boolean {
  if (isSpreadElement(node)) {
    return true;
  }
  const { at, value } = reached(node, reading);
  if (!isObjectLiteralExpression(value)) {
    return isChangedName(value, at);
  }
  return value.properties.some((property) => {
    if (isSpreadAssignment(property)) {
      return lacksElement(property.expression, at);
    }
    const { name } = property;
    const key = literalKey(isComputedPropertyName(name) ? unwrapped(name.expression) : name);
    const named = isIdentifier(name) ? name.text : key;
    return named === undefined || ARRAY_LIKE_NAMES.has(named);
  });
}

/**
 * Whether a call of `at`, `pop`, `shift` or `codePointAt` answers an element of what it is called
 * on, and so no `undefined`, which it answers of an element it finds none of: of an array the code
 * writes there of no spread, or text — not a constant's, which the code may have emptied since — at
 * an index the code writes within its bounds, `['x', 'y'].at(-1)`; never of `find`, which may find
 * none.
 */
export function answersPresent(call: CallExpression, reading: JsonReading): boolean {
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee)) {
    return false;
  }
  const method = callee.name.text;
  const target = unwrapped(callee.expression);
  const length = writtenLength(target);
  if (length === undefined || length === 0) {
    return false;
  }
  if (method === 'pop' || method === 'shift') {
    return isElementAt(target, method === 'pop' ? length - 1 : 0);
  }
  const [given] = call.arguments;
  const number = given === undefined ? 0 : constantNumber(given, followedOf(reading));
  if (number === undefined || (method !== 'at' && method !== 'codePointAt')) {
    return false;
  }
  // An index as the language reads one: `NaN` is `0`, a fraction its whole; of `at` alone, one
  // below zero counts from the end.
  const whole = Math.trunc(number) || 0;
  const index = method === 'at' && whole < 0 ? length + whole : whole;
  return index >= 0 && index < length && isElementAt(target, index);
}

/**
 * Whether what `call` is called on is an array the code writes there of an element it holds — not
 * a hole, nor what a spread hands, which may be none — of which `reduce` of no first value throws
 * not.
 */
export function holdsElement(call: CallExpression): boolean {
  const callee = unwrapped(call.expression);
  const target = isPropertyAccessExpression(callee) ? unwrapped(callee.expression) : undefined;
  return (
    target !== undefined &&
    isArrayLiteralExpression(target) &&
    target.elements.some((each) => !isOmittedExpression(each) && !isSpreadElement(each))
  );
}

/**
 * Whether `with` of what `call` gives it is given an index the code writes within the bounds of an
 * array of no spread the code writes there — one below zero counting from the end — of which it
 * throws not; of any other, the compile tells no bounds, and it may throw.
 */
export function replacesWithin(call: CallExpression, reading: JsonReading): boolean {
  const callee = unwrapped(call.expression);
  const target = isPropertyAccessExpression(callee) ? unwrapped(callee.expression) : undefined;
  const length =
    target !== undefined && isArrayLiteralExpression(target) ? writtenLength(target) : undefined;
  const [given] = call.arguments;
  const number = given === undefined ? 0 : constantNumber(given, followedOf(reading));
  if (length === undefined || number === undefined) {
    return false;
  }
  const whole = Math.trunc(number) || 0;
  return whole >= -length && whole < length;
}

/** The methods whose answer keeps the holes of the array they are called on. */
const KEEPING_HOLES: ReadonlySet<string> = new Set([
  'concat',
  'copyWithin',
  'fill',
  'map',
  'reverse',
  'slice',
  'sort',
]);

/**
 * Whether `node` may be an array of holes, which JSON writes as `null`: one the code writes of a
 * hole, `[, 'x']`; `Array(count)` of one number; what a method keeping them answers of one
 * (`KEEPING_HOLES`) — but `fill` at every index (`fillsWhole`), `Array(3).fill(0)`; a constant the
 * code changes since it declares it, which may hold anything.
 */
export function holdsHoles(node: Expression, reading: JsonReading): boolean {
  const { at, value } = reached(node, reading);
  if (isArrayLiteralExpression(value)) {
    return value.elements.some((each) => isOmittedExpression(each));
  }
  if (isCallExpression(value) || isNewExpression(value)) {
    const callee = unwrapped(value.expression);
    if (globalOf(callee) === 'Array') {
      const given = value.arguments ?? [];
      return given.length === 1 || given.some((each) => isSpreadElement(each));
    }
    return (
      isPropertyAccessExpression(callee) &&
      KEEPING_HOLES.has(callee.name.text) &&
      !(callee.name.text === 'fill' && isCallExpression(value) && fillsWhole(value)) &&
      holdsHoles(callee.expression, at)
    );
  }
  return isChangedName(value, at);
}

/** The methods that answer an array as long as the one they are called on. */
const KEEPING_LENGTH: ReadonlySet<string> = new Set([
  'fill',
  'map',
  'reverse',
  'sort',
  'toReversed',
  'toSorted',
  'with',
]);

/**
 * Whether what `call` answers holds an element at `index`, as the code shows it: the array a
 * method keeping the length (`KEEPING_LENGTH`) answers of an array of no spread the code writes
 * there, at an index within it but a hole's; the first of text `split` divides by text the code
 * writes, or by nothing, of no limit. Of any other call, the compile tells no length, and the
 * element may be lacking: `Object.keys({})[0]`.
 */
export function answersElement(call: CallExpression, index: number): boolean {
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee)) {
    return false;
  }
  const method = callee.name.text;
  if (method === 'split') {
    const [separator, limit] = call.arguments;
    const given = separator === undefined ? undefined : unwrapped(separator);
    const isText =
      given === undefined ||
      ((isStringLiteral(given) || isNoSubstitutionTemplateLiteral(given)) && given.text !== '');
    return index === 0 && isText && limit === undefined;
  }
  const target = unwrapped(callee.expression);
  const length = KEEPING_LENGTH.has(method) ? writtenLength(target) : undefined;
  return length !== undefined && index < length && isElementAt(target, index);
}

/** How long an array of no spread, or text, the code writes there is; none of anything else. */
function writtenLength(node: Expression): number | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text.length;
  }
  const isWhole =
    isArrayLiteralExpression(node) && !node.elements.some((each) => isSpreadElement(each));
  return isWhole ? node.elements.length : undefined;
}

/** Whether what `node` writes holds an element at `index`: text does, an array but at a hole. */
function isElementAt(node: Expression, index: number): boolean {
  const element = isArrayLiteralExpression(node) ? node.elements[index] : undefined;
  return element === undefined ? !isArrayLiteralExpression(node) : !isOmittedExpression(element);
}

/**
 * Whether the name `name` holds what no JSON holds: a global — `NaN`, `Infinity`, a function, an
 * object of functions, `Math` — but `undefined` as an entry, which JSON leaves out; and one of the
 * code's that `reading.holdsNonJson` says does, a function the server part declares, or a constant
 * the code changes since it declares it (`isChanged`).
 */
export function isNonJsonName(name: Identifier, reading: JsonReading): boolean {
  const global = globalOf(name);
  if (global === undefined) {
    return (
      reading.holdsNonJson?.(name, reading.entry === true) === true ||
      reading.isChanged?.(name, reading) === true
    );
  }
  return global !== 'undefined' || reading.entry !== true;
}

/**
 * Whether `node` makes what no JSON holds, as the language and the platform do: an object of a
 * class — `new Date()`, `new Map()` — a regular expression, a symbol — `Symbol()`,
 * `Symbol.for('x')`, `Symbol.iterator` — and what a global's function answers that no JSON holds
 * (`global-answers.ts`): an integer of `BigInt(…)`, a promise of `Promise.resolve(…)`, an error of
 * `Error('x')`.
 */
export function isMadeNonJson(node: Expression): boolean {
  if (isNewExpression(node) || isRegularExpressionLiteral(node)) {
    return true;
  }
  if (isPropertyAccessExpression(node)) {
    return globalOf(unwrapped(node.expression)) === 'Symbol';
  }
  return isCallExpression(node) && callsNonJsonGlobal(node);
}

/** Whether `node` is a function the code writes — an arrow, a function, a class. */
export function isFunctionValue(node: Node): boolean {
  return isArrowFunction(node) || isFunctionExpression(node) || isClassExpression(node);
}

/**
 * Whether `value`, a pattern `split` divides text by, may hold a group that captures nothing, of
 * which `split` answers `undefined` among its text — `'a'.split(/a|(b)/)`: a regular expression the
 * code writes of a group that captures, named or not, or one the code makes, `new RegExp(…)`, whose
 * groups the compile does not read; none of text, nor of what the code does not write, JSON.
 */
export function capturesNothing(value: Node): boolean {
  if (isRegularExpressionLiteral(value)) {
    const { text } = value;
    return captures(text.slice(1, text.lastIndexOf('/')));
  }
  if (isNewExpression(value)) {
    return true;
  }
  return isCallExpression(value) && globalOf(unwrapped(value.expression)) === 'RegExp';
}

/**
 * Whether the pattern `pattern` holds a group that captures, named or not: a `(` that no escape
 * writes as itself, nor a class holds, of none of `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`.
 */
function captures(pattern: string): boolean {
  let inClass = false;
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (inClass) {
      inClass = char !== ']';
    } else if (char === '[') {
      inClass = true;
    } else if (char === '(' && opensCapture(pattern, index + 1)) {
      return true;
    }
    index += 1;
  }
  return false;
}

/** Whether the group whose text past its `(` begins at `at` of `pattern` captures: a named one, or one of no `?`. */
function opensCapture(pattern: string, at: number): boolean {
  if (!pattern.startsWith('?', at)) {
    return true;
  }
  return (
    pattern.startsWith('?<', at) && !pattern.startsWith('?<=', at) && !pattern.startsWith('?<!', at)
  );
}

/**
 * Whether `+value`, or `-value`, of `operand` may make what no JSON holds: `NaN` of `undefined`, of
 * an object, of an array of more than one element, of a function, a pattern, a symbol or what else
 * no JSON holds (`check`) — but a date, which makes its time, `+new Date(0)`; a `BigInt` of one. Of
 * what the code does not write, a number of JSON as its type says, as ever.
 */
export function makesNonFinite(
  operand: Expression,
  reading: JsonReading,
  check: (node: Expression, reading: JsonReading) => boolean,
): boolean {
  const { at, value } = reached(operand, reading);
  if (isNewExpression(value)) {
    return (
      globalOf(unwrapped(value.expression)) !== 'Date' ||
      Number.isNaN(writtenTime(value, followedOf(at)))
    );
  }
  if (isObjectLiteralExpression(value)) {
    return true;
  }
  if (isArrayLiteralExpression(value)) {
    const [only, ...rest] = value.elements;
    if (only === undefined) {
      return false;
    }
    return (
      rest.length > 0 ||
      isOmittedExpression(only) ||
      isSpreadElement(only) ||
      makesNonFinite(only, at, check)
    );
  }
  return check(value, { ...at, entry: false });
}
