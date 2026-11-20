import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isClassExpression,
  isComputedPropertyName,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSpreadElement,
  isVoidExpression,
  type NewExpression,
  SyntaxKind,
} from 'typescript/ast';

import { calledMember, globalOf, namesNamespace, unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { type Constant, constantNumber, constantValue, type Resolve } from './numbers.ts';

/**
 * What a call of the language's functions, or a construction of its classes, throws of the shape of
 * what the code writes it is given — an array-like of a length past what an array holds, entries of
 * no object, nothing where something is needed, a `DataView` read past its bytes — beside what
 * `throws.ts` tries of numbers and text.
 */

/** The most elements an array holds, 2³² − 1: of a length past it, `new Array(…)` throws. */
const MAX_ELEMENTS = 0xff_ff_ff_ff;

/**
 * The functions and the classes of globals that throw of the shape of what they are given, where the
 * code writes it, of no number or text alone: of what `Array.from` reads as an array-like, of the
 * entries `Object.fromEntries` and a `Map` are made of, of what a `Set` iterates.
 */
export const SHAPED: ReadonlyMap<
  string,
  (given: readonly Expression[], resolve: Resolve | undefined) => boolean
> = new Map([
  ['Array.from', (given, resolve) => lengthPast(given[0], resolve)],
  ['DataView', (given, resolve) => viewOf(given, resolve).throws],
  ['Map', (given, resolve) => entriesThrow(given[0], false, resolve)],
  ['Object.fromEntries', (given, resolve) => entriesThrow(given[0], true, resolve)],
  ['Reflect.apply', (given, resolve) => listThrows(given[0], given[2], resolve)],
  ['Reflect.construct', (given, resolve) => listThrows(given[0], given[1], resolve)],
  ['Set', (given, resolve) => notIterable(given[0], resolve)],
]);

/**
 * The functions of `Atomics` that read or write an element of the typed array they are given first,
 * at the index given next — which throw of what is no typed array of integers, and of an index past
 * its elements.
 */
const ATOMICS: ReadonlySet<string> = new Set([
  'Atomics.add',
  'Atomics.and',
  'Atomics.compareExchange',
  'Atomics.exchange',
  'Atomics.load',
  'Atomics.notify',
  'Atomics.or',
  'Atomics.store',
  'Atomics.sub',
  'Atomics.waitAsync',
  'Atomics.xor',
]);

/**
 * The functions of `Atomics` that wait but block not, or wake what waits: of a typed array of 32 or
 * 64 bits alone — `Atomics.wait`, which blocks, answering of none (`atomicsThrow`).
 */
const WAITING: ReadonlySet<string> = new Set(['Atomics.notify', 'Atomics.waitAsync']);

/** The typed arrays `WAITING`'s functions take. */
const WAITABLE: ReadonlySet<string> = new Set(['BigInt64Array', 'Int32Array']);

/** The typed arrays of integers, which `Atomics`' functions take. */
const INTEGER_ARRAYS: ReadonlySet<string> = new Set([
  'BigInt64Array',
  'BigUint64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
]);

/**
 * The functions of `Object` that throw of nothing given first, `null` or `undefined`, of which they
 * make no object: `Object.keys(null)` and its kin.
 */
const OF_SOMETHING: ReadonlySet<string> = new Set([
  'Object.assign',
  'Object.entries',
  'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertyDescriptors',
  'Object.getOwnPropertyNames',
  'Object.getOwnPropertySymbols',
  'Object.getPrototypeOf',
  'Object.hasOwn',
  'Object.keys',
  'Object.setPrototypeOf',
  'Object.values',
]);

/**
 * The functions of `Object` and of `Reflect` that throw of any value of no object given first —
 * nothing, text, a number — of which they make none: `Reflect.ownKeys('x')`, `Object.defineProperty(1, …)`.
 */
const OF_OBJECTS: ReadonlySet<string> = new Set([
  'Object.defineProperties',
  'Object.defineProperty',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.get',
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.getPrototypeOf',
  'Reflect.has',
  'Reflect.isExtensible',
  'Reflect.ownKeys',
  'Reflect.preventExtensions',
  'Reflect.set',
  'Reflect.setPrototypeOf',
]);

/** The functions that group what they iterate, which throw of nothing, or of a number, given first. */
const GROUPING: ReadonlySet<string> = new Set(['Map.groupBy', 'Object.groupBy']);

/** The bytes of a value of 8, 16, 32 and 64 bits. */
const WIDTH = { 8: 1, 16: 2, 32: 4, 64: 8 } as const;

/** The bytes each of a `DataView`'s methods reads or writes at the index it is given, by its name. */
const VIEWED: ReadonlyMap<string, number> = new Map([
  ['getBigInt64', WIDTH[64]],
  ['getBigUint64', WIDTH[64]],
  ['getFloat16', WIDTH[16]],
  ['getFloat32', WIDTH[32]],
  ['getFloat64', WIDTH[64]],
  ['getInt8', WIDTH[8]],
  ['getInt16', WIDTH[16]],
  ['getInt32', WIDTH[32]],
  ['getUint8', WIDTH[8]],
  ['getUint16', WIDTH[16]],
  ['getUint32', WIDTH[32]],
  ['setBigInt64', WIDTH[64]],
  ['setBigUint64', WIDTH[64]],
  ['setFloat16', WIDTH[16]],
  ['setFloat32', WIDTH[32]],
  ['setFloat64', WIDTH[64]],
  ['setInt8', WIDTH[8]],
  ['setInt16', WIDTH[16]],
  ['setInt32', WIDTH[32]],
  ['setUint8', WIDTH[8]],
  ['setUint16', WIDTH[16]],
  ['setUint32', WIDTH[32]],
]);

/**
 * What a `DataView` the code makes holds: whether making it throws, and the bytes it holds where the
 * code writes them.
 */
interface Viewed {
  readonly throws: boolean;
  readonly bytes?: number | undefined;
}

/** A view whose making throws. */
const THROWS: Viewed = { throws: true };

/** A view of what the compile cannot tell. */
const UNTOLD: Viewed = { throws: false };

/** The buffers a `DataView` or a typed array is made over, by their classes' names. */
const BUFFERS: ReadonlySet<string> = new Set(['ArrayBuffer', 'SharedArrayBuffer']);

/** An integer as the language reads one it is given: `NaN` and nothing are `0`, a fraction its whole. */
export function wholeOf(value: Constant = 0): number {
  return Math.trunc(Number(value)) || 0;
}

/** `node` past parentheses and casts, and a name of a constant followed to what it writes (`resolve`). */
export function writtenOf(node: Expression, resolve: Resolve | undefined): Expression {
  let value = unwrapped(node);
  const followed = new Set<string>();
  while (isIdentifier(value) && !followed.has(value.text)) {
    followed.add(value.text);
    const held = resolve?.(value);
    if (held === undefined) {
      return value;
    }
    value = unwrapped(held);
  }
  return value;
}

/**
 * What of no object `value` is where the code writes it: nothing, `null` or `undefined`; text, or
 * text of no character; another, a number, a boolean, an integer of `bigint`; none of anything else.
 */
export function primitiveOf(
  value: Expression,
  resolve: Resolve | undefined,
): 'empty' | 'nothing' | 'other' | 'text' | undefined {
  if (
    value.kind === SyntaxKind.NullKeyword ||
    isVoidExpression(value) ||
    (isIdentifier(value) && globalOf(value) === 'undefined')
  ) {
    return 'nothing';
  }
  if (
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    isBigIntLiteral(value)
  ) {
    return 'other';
  }
  const written = constantValue(value, resolve);
  if (typeof written === 'string') {
    return written === '' ? 'empty' : 'text';
  }
  return written === undefined ? undefined : 'other';
}

/**
 * Whether what is made of entries — `Object.fromEntries`, `new Map(…)` — throws of what it is given,
 * where the code writes it: of nothing, as `Object.fromEntries` throws (`nothingThrows`) and a
 * `Map` holds none; of a number, which iterates not; of text, each character of which is no entry;
 * of an array of an element of no object, or of a hole.
 */
function entriesThrow(
  given: Expression | undefined,
  nothingThrows: boolean,
  resolve: Resolve | undefined,
): boolean {
  if (given === undefined) {
    return nothingThrows;
  }
  const value = writtenOf(given, resolve);
  const kind = primitiveOf(value, resolve);
  if (kind !== undefined) {
    return kind === 'nothing' ? nothingThrows : kind !== 'empty';
  }
  return (
    isArrayLiteralExpression(value) &&
    value.elements.some((element) => {
      if (isOmittedExpression(element)) {
        return true;
      }
      return (
        !isSpreadElement(element) && primitiveOf(writtenOf(element, resolve), resolve) !== undefined
      );
    })
  );
}

/** Whether a `Set` made of `given` throws of it, where the code writes it: a number, which iterates not. */
function notIterable(given: Expression | undefined, resolve: Resolve | undefined): boolean {
  return given !== undefined && primitiveOf(writtenOf(given, resolve), resolve) === 'other';
}

/**
 * Whether `Array.from` throws of what it is given, where the code writes it: nothing, which it
 * iterates not; an object whose `length` says more elements than an array holds (`MAX_ELEMENTS`),
 * `{ length: 2 ** 32 }`, of no key the compile cannot read beside it.
 */
function lengthPast(given: Expression | undefined, resolve: Resolve | undefined): boolean {
  const value = given === undefined ? undefined : writtenOf(given, resolve);
  if (value === undefined || primitiveOf(value, resolve) === 'nothing') {
    return true;
  }
  if (
    !isObjectLiteralExpression(value) ||
    value.properties.some(
      (property) => !isPropertyAssignment(property) || isComputedPropertyName(property.name),
    )
  ) {
    return false;
  }
  const length = value.properties.findLast((property) => {
    if (!isPropertyAssignment(property)) {
      return false;
    }
    const { name } = property;
    return (isIdentifier(name) ? name.text : literalKey(name)) === 'length';
  });
  const said =
    length !== undefined && isPropertyAssignment(length)
      ? constantNumber(length.initializer, resolve)
      : undefined;
  return said !== undefined && Math.min(wholeOf(said), Number.MAX_SAFE_INTEGER) > MAX_ELEMENTS;
}

/**
 * Whether a call of the global function `path` throws of what it is given first, where the code
 * writes it: of nothing, of `OF_SOMETHING`, `GROUPING`, `Iterator.from`, and `Object.create`; of
 * no object, of `OF_OBJECTS`; of a number, which iterates not, of `GROUPING` and `Iterator.from`;
 * of what is neither an object nor `null`, of `Object.create`, whose prototype it is.
 */
export function firstThrows(
  path: string,
  first: Expression | undefined,
  resolve: Resolve | undefined,
): boolean {
  const known =
    OF_SOMETHING.has(path) ||
    OF_OBJECTS.has(path) ||
    GROUPING.has(path) ||
    path === 'Iterator.from' ||
    path === 'Object.create';
  if (!known || (first !== undefined && isSpreadElement(first))) {
    return false;
  }
  const value = first === undefined ? undefined : writtenOf(first, resolve);
  // Of none given, `undefined`.
  const kind = value === undefined ? 'nothing' : primitiveOf(value, resolve);
  if (kind === undefined) {
    return false;
  }
  if (OF_OBJECTS.has(path)) {
    return true;
  }
  if (path === 'Object.create') {
    return value?.kind !== SyntaxKind.NullKeyword;
  }
  return (
    kind === 'nothing' || ((GROUPING.has(path) || path === 'Iterator.from') && kind === 'other')
  );
}

/**
 * What a `DataView` the code makes holds, where it writes it — over a buffer it makes there,
 * `new DataView(new ArrayBuffer(8), 2)` — of which making it throws over what is no buffer, from an
 * offset below none or past the buffer's bytes, or for a length below none or past them.
 */
function viewOf(given: readonly Expression[], resolve: Resolve | undefined): Viewed {
  const [first, offset, length] = given;
  const held = bufferBytes(first, resolve);
  const from = offset === undefined ? 0 : constantValue(offset, resolve);
  const counted = length === undefined ? undefined : constantValue(length, resolve);
  if (held.throws || held.bytes === undefined) {
    return held;
  }
  if (from === undefined || (length !== undefined && counted === undefined)) {
    return UNTOLD;
  }
  const start = wholeOf(from);
  const viewed = counted === undefined ? held.bytes - start : wholeOf(counted);
  return start < 0 || start > held.bytes || viewed < 0 || start + viewed > held.bytes
    ? THROWS
    : { bytes: viewed, throws: false };
}

/**
 * What `given`, what a `DataView` is made over, holds where the code writes it — a buffer it makes
 * there of a size it writes — of which the view's making throws of what is no buffer: nothing, a
 * value of no object, an array or an object written.
 */
function bufferBytes(given: Expression | undefined, resolve: Resolve | undefined): Viewed {
  const buffer = given === undefined ? undefined : writtenOf(given, resolve);
  if (buffer === undefined || primitiveOf(buffer, resolve) !== undefined) {
    return THROWS;
  }
  if (
    !isNewExpression(buffer) ||
    !BUFFERS.has(globalPath(unwrapped(buffer.expression))?.join('.') ?? '')
  ) {
    return isArrayLiteralExpression(buffer) || isObjectLiteralExpression(buffer) ? THROWS : UNTOLD;
  }
  const [size] = buffer.arguments ?? [];
  const sized = size === undefined ? 0 : constantValue(size, resolve);
  return sized === undefined ? UNTOLD : { bytes: wholeOf(sized), throws: false };
}

/**
 * Whether `method`, one of a `DataView`'s that reads or writes as many bytes as `VIEWED` says at the
 * index it is given, throws of it, called on a view the code makes (`viewOf`): of an index below
 * none, or of one past what the view holds.
 */
export function viewedThrows(
  method: string,
  receiver: Expression,
  index: Constant | undefined,
  resolve: Resolve | undefined,
): boolean {
  const bytes = VIEWED.get(method);
  const view = bytes === undefined ? undefined : writtenOf(receiver, resolve);
  if (
    bytes === undefined ||
    view === undefined ||
    !isNewExpression(view) ||
    globalPath(unwrapped(view.expression))?.join('.') !== 'DataView'
  ) {
    return false;
  }
  const held = viewOf(view.arguments ?? [], resolve);
  const at = wholeOf(index);
  return held.throws || at < 0 || (held.bytes !== undefined && at + bytes > held.bytes);
}

/**
 * Whether a call of a function of `Atomics` (`ATOMICS`) throws of what it is given, where the code
 * writes it: of what is no typed array — nothing, a value of no object, an array or an object
 * written — or one of no integers, or of no 32 or 64 bits where it waits (`WAITING`); of an index
 * below none, or past the elements of a typed array the code makes (`typedOf`). `Atomics.wait`
 * answers of none: it blocks the thread it runs on until what it waits for, a render's too, and
 * throws on a page's.
 */
export function atomicsThrow(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (path === 'Atomics.wait') {
    return true;
  }
  if (!ATOMICS.has(path) || given.some((each) => isSpreadElement(each))) {
    return false;
  }
  const [array, index] = given;
  const value = array === undefined ? undefined : writtenOf(array, resolve);
  if (
    value === undefined ||
    primitiveOf(value, resolve) !== undefined ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value)
  ) {
    return true;
  }
  const typed = typedOf(value, resolve);
  if (typed === undefined) {
    return false;
  }
  if (!INTEGER_ARRAYS.has(typed.kind) || (WAITING.has(path) && !WAITABLE.has(typed.kind))) {
    return true;
  }
  const at = index === undefined ? 0 : constantValue(index, resolve);
  const whole = at === undefined ? undefined : wholeOf(at);
  return (
    whole !== undefined && (whole < 0 || (typed.length !== undefined && whole >= typed.length))
  );
}

/** What a typed array the code makes is: its class, and how many elements it holds, where the code writes them. */
interface Typed {
  readonly kind: string;
  readonly length?: number | undefined;
}

/** The bytes of an element of each typed array, by its class's name. */
const ELEMENT_BYTES: ReadonlyMap<string, number> = new Map([
  ['BigInt64Array', WIDTH[64]],
  ['BigUint64Array', WIDTH[64]],
  ['Float16Array', WIDTH[16]],
  ['Float32Array', WIDTH[32]],
  ['Float64Array', WIDTH[64]],
  ['Int8Array', WIDTH[8]],
  ['Int16Array', WIDTH[16]],
  ['Int32Array', WIDTH[32]],
  ['Uint8Array', WIDTH[8]],
  ['Uint8ClampedArray', WIDTH[8]],
  ['Uint16Array', WIDTH[16]],
  ['Uint32Array', WIDTH[32]],
]);

/**
 * What `value`, written, is of a typed array the code makes — `new Int32Array(4)`, of the elements
 * of an array written there, or over a buffer it makes, `new Int32Array(new SharedArrayBuffer(8))` —
 * with the elements it holds where the code writes them; none of another value.
 */
export function typedOf(
  value: Expression,
  resolve: Resolve | undefined,
  path?: string,
): Typed | undefined {
  const kind =
    path ??
    (isNewExpression(value) ? globalPath(unwrapped(value.expression))?.join('.') : undefined);
  const bytes = kind === undefined ? undefined : ELEMENT_BYTES.get(kind);
  if (kind === undefined || bytes === undefined || !isNewExpression(value)) {
    return undefined;
  }
  const [first, offset, length] = value.arguments ?? [];
  if (first === undefined) {
    return { kind, length: 0 };
  }
  const written = writtenOf(first, resolve);
  if (isArrayLiteralExpression(written)) {
    const spread = written.elements.some((each) => isSpreadElement(each));
    return { kind, length: spread ? undefined : written.elements.length };
  }
  const count = constantValue(first, resolve);
  if (count !== undefined) {
    return { kind, length: wholeOf(count) };
  }
  const buffer = bufferBytes(first, resolve);
  const from = offset === undefined ? 0 : constantValue(offset, resolve);
  const counted = length === undefined ? undefined : constantValue(length, resolve);
  if (counted !== undefined) {
    return { kind, length: wholeOf(counted) };
  }
  if (length !== undefined || from === undefined || buffer.bytes === undefined) {
    return { kind };
  }
  return { kind, length: Math.floor((buffer.bytes - wholeOf(from)) / bytes) };
}

/** Whether a global class constructs one of the language's typed arrays. */
export function isTypedKind(path: string): boolean {
  return ELEMENT_BYTES.has(path);
}

/**
 * Whether a typed array of the class `path` names, made over a buffer the code makes there —
 * `new Int32Array(new ArrayBuffer(8), 2)` — throws of where it is made from or of how long: of an
 * offset below none, of no whole elements, or past the buffer's bytes; of a length below none, or
 * past them; of a buffer of no whole elements, of a size it keeps.
 */
export function typedThrows(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const bytes = ELEMENT_BYTES.get(path);
  const [first, offset, length] = given;
  const buffer = first === undefined ? undefined : madeBuffer(first, resolve);
  const held = bufferBytes(first, resolve);
  const from = offset === undefined ? 0 : constantValue(offset, resolve);
  const counted = length === undefined ? undefined : constantValue(length, resolve);
  if (
    bytes === undefined ||
    buffer === undefined ||
    from === undefined ||
    held.bytes === undefined ||
    (length !== undefined && counted === undefined)
  ) {
    return false;
  }
  const start = wholeOf(from);
  if (start < 0 || start % bytes !== 0) {
    return true;
  }
  if (counted !== undefined) {
    const count = wholeOf(counted);
    return count < 0 || start + count * bytes > held.bytes;
  }
  // Over a buffer that may grow, `new ArrayBuffer(8, { maxByteLength: 16 })`, it tracks its length.
  const fixed = (buffer.arguments ?? []).length < 2;
  return start > held.bytes || (fixed && held.bytes % bytes !== 0);
}

/** `given`, written, where it is a buffer the code makes there: `new ArrayBuffer(8)`; none of another. */
function madeBuffer(given: Expression, resolve: Resolve | undefined): NewExpression | undefined {
  const buffer = writtenOf(given, resolve);
  return isNewExpression(buffer) &&
    BUFFERS.has(globalPath(unwrapped(buffer.expression))?.join('.') ?? '')
    ? buffer
    : undefined;
}

/**
 * Whether `Reflect.apply` or `Reflect.construct` throws of what it is given, where the code writes it:
 * of what it calls, a value of no object; of the list of arguments it calls it with, none, or a
 * value of no object, of which it makes no list.
 */
function listThrows(
  target: Expression | undefined,
  list: Expression | undefined,
  resolve: Resolve | undefined,
): boolean {
  const called = target === undefined ? undefined : writtenOf(target, resolve);
  const listed = list === undefined ? undefined : writtenOf(list, resolve);
  return (
    called === undefined ||
    primitiveOf(called, resolve) !== undefined ||
    listed === undefined ||
    primitiveOf(listed, resolve) !== undefined
  );
}

/**
 * Whether `callee` called with `given` is `apply` of a function the code writes, there or through its
 * constants — an arrow, a function — which throws of the list of arguments it is given next, where
 * the code writes it: a value of no object but nothing, of which it makes no list,
 * `(() => 1).apply(null, 'ab')` — beside `null` and `undefined`, of which it calls with none. An
 * object's own `apply`, and `Reflect.apply`, take what they are given otherwise.
 */
export function appliesNoList(
  callee: Expression,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const [, list] = given;
  const member = calledMember(callee);
  if (
    list === undefined ||
    member?.name !== 'apply' ||
    given.some((each) => isSpreadElement(each))
  ) {
    return false;
  }
  const called = writtenOf(member.of, resolve);
  const kind = primitiveOf(writtenOf(list, resolve), resolve);
  return (
    kind !== undefined &&
    kind !== 'nothing' &&
    (isArrowFunction(called) || isFunctionExpression(called))
  );
}

/** The classes whose instances' methods of the names of text's, numbers' and patterns' are those. */
const TRIED_CLASSES: ReadonlySet<string> = new Set(['Number', 'RegExp', 'String']);

/**
 * Whether `receiver`, where the code writes it, is a value whose methods of the names of text's,
 * numbers' and patterns' are its own, which take what they are given otherwise — a module's
 * namespace, `helpers.normalize(…)`, an object, an array, a function, a class, what one makes but
 * `Number`, `String` and `RegExp`, a boolean — none of what the code does not write.
 */
export function ownsMethods(receiver: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(receiver, resolve);
  if (isNewExpression(value)) {
    return !TRIED_CLASSES.has(globalPath(unwrapped(value.expression))?.join('.') ?? '');
  }
  return (
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    namesNamespace(value) ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value)
  );
}
