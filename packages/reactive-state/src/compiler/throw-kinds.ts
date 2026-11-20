import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isClassExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { calledMember, unwrapped } from './bounded.ts';
import { globalPath } from './global-answers.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { arrayMethodBoundsThrow, withIndexThrows } from './throw-array-bounds.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { definitionsThrow } from './throw-definitions.ts';
import { primitiveOf, typedOf, wholeOf, writtenOf } from './throw-shapes.ts';
import { typedSymbolElement } from './throw-typed-symbols.ts';
import { typedArrayLikeElements } from './typed-arraylike-elements.ts';

/**
 * What a call or a construction of the language's throws of the kind of what the code writes it is
 * given, beside its shape (`throw-shapes.ts`): a property's descriptor of no object, of a getter or
 * a setter of no function, or of both an accessor and a value; an element of a typed array of
 * integers of `bigint` that makes none, a number, or one of a `bigint` where it holds numbers; a
 * width of bits below none for `BigInt.asIntN`, or a value of no `bigint`; `BigInt` of what makes no
 * integer; a buffer's size below none, or past the most bytes it may grow to.
 */

/** The functions of globals that take a property's descriptor, by the place of it. */
const DESCRIBED: ReadonlyMap<string, number> = new Map([
  ['Object.defineProperty', 2],
  ['Reflect.defineProperty', 2],
]);

/**
 * The functions that take an object of descriptors, by the place of it — and whether nothing given
 * there throws: of `Object.defineProperties`, it does; of `Object.create`, it defines none.
 */
const DESCRIBING: ReadonlyMap<string, { readonly at: number; readonly needed: boolean }> = new Map([
  ['Object.create', { at: 1, needed: false }],
  ['Object.defineProperties', { at: 1, needed: true }],
]);

/** The fields of a descriptor of an accessor, beside which one of a value throws. */
const ACCESSORS: ReadonlySet<string> = new Set(['get', 'set']);

/** The fields of a descriptor of a value, beside which one of an accessor throws. */
const VALUES: ReadonlySet<string> = new Set(['value', 'writable']);

/** The buffers, made of a size and of options of the most bytes they may grow to. */
const BUFFERS: ReadonlySet<string> = new Set(['ArrayBuffer', 'SharedArrayBuffer']);

/** The methods of a buffer that size it anew, by the class whose they are. */
const SIZING: ReadonlyMap<string, string> = new Map([
  ['grow', 'SharedArrayBuffer'],
  ['resize', 'ArrayBuffer'],
  ['transfer', 'ArrayBuffer'],
  ['transferToFixedLength', 'ArrayBuffer'],
]);

/** How a buffer may grow, of its options: to the most bytes they say, or, of none, not at all. */
interface Growth {
  readonly most: number | undefined;
}

/** A buffer that keeps its size. */
const FIXED: Growth = { most: undefined };

/** The typed arrays of integers of `bigint`, of which an element of a number throws. */
const BIG_ARRAYS: ReadonlySet<string> = new Set(['BigInt64Array', 'BigUint64Array']);

/** The typed arrays of numbers, of which an element of a `bigint` throws. */
const NUMBER_ARRAYS: ReadonlySet<string> = new Set([
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
]);

/** The methods of a typed array that make an element of what they are given, by its place. */
const ELEMENT_TAKERS: ReadonlyMap<string, number> = new Map([
  ['fill', 0],
  ['with', 1],
]);

/** The places of what `Atomics`' functions write: the value, and what `compareExchange` puts in its place. */
const PLACES = { replacement: 3, value: 2 } as const;

/** The functions of `Atomics` that write values they are given, by their places. */
const ATOMIC_VALUES: ReadonlyMap<string, readonly number[]> = new Map([
  ['Atomics.add', [PLACES.value]],
  ['Atomics.and', [PLACES.value]],
  ['Atomics.compareExchange', [PLACES.value, PLACES.replacement]],
  ['Atomics.exchange', [PLACES.value]],
  ['Atomics.or', [PLACES.value]],
  ['Atomics.store', [PLACES.value]],
  ['Atomics.sub', [PLACES.value]],
  ['Atomics.xor', [PLACES.value]],
]);

/**
 * Whether a call of `callee`, the global `path`, throws of the kind of what it is given, where the
 * code writes it: a descriptor (`describesThrowing`), a `bigint` (`bigIntThrows`), an element of a
 * typed array (`elementsThrow`), a buffer's size (`sizingThrows`).
 */
export function kindsThrow(
  callee: Expression,
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (given.some((each) => isSpreadElement(each))) {
    return false;
  }
  return (
    descriptorsThrow(path, given, resolve) ||
    definitionsThrow(path, given, resolve) ||
    bigIntThrows(path, given, resolve) ||
    typedCallThrows(callee, path, given, resolve) ||
    sizingThrows(callee, given, resolve)
  );
}

/**
 * Whether making a buffer of the class `path` names throws of the size and the most bytes the code
 * writes it is given: of either below none or past 2⁵³ − 1, or of a size past the most —
 * `new ArrayBuffer(8, { maxByteLength: 4 })`.
 */
export function madeBufferThrows(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (!BUFFERS.has(path)) {
    return false;
  }
  const [size, options] = given;
  const length = sizeOf(size, resolve);
  if (length !== undefined && !isIndex(length)) {
    return true;
  }
  const most = growthOf(options, resolve)?.most;
  return most !== undefined && (!isIndex(most) || (length !== undefined && length > most));
}

/**
 * Whether a method that sizes anew a buffer the code makes there (`SIZING`) throws of it, or of the
 * size the code writes it is given: of a buffer of the other class, which holds no such method;
 * `resize` and `grow` of one of a size it keeps; a size below none or past 2⁵³ − 1; past the most
 * bytes, but of `transferToFixedLength`; below the size, of `grow`.
 */
function sizingThrows(
  callee: Expression,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const member = calledMember(callee);
  const method = member?.name;
  const owner = method === undefined ? undefined : SIZING.get(method);
  const made =
    owner === undefined || member === undefined ? undefined : writtenOf(member.of, resolve);
  const kind =
    made !== undefined && isNewExpression(made)
      ? globalPath(unwrapped(made.expression))?.join('.')
      : undefined;
  if (kind === undefined || made === undefined || !isNewExpression(made) || !BUFFERS.has(kind)) {
    return false;
  }
  if (kind !== owner) {
    return true;
  }
  const [size, options] = made.arguments ?? [];
  const asked =
    given[0] === undefined && method?.startsWith('transfer') === true
      ? undefined
      : sizeOf(given[0], resolve);
  return sizedThrows({
    asked,
    growth: growthOf(options, resolve),
    length: sizeOf(size, resolve),
    method: method ?? '',
  });
}

/** Whether a method of `SIZING` throws of what it is asked to size a buffer of the length and the growth to. */
function sizedThrows({
  asked,
  growth,
  length,
  method,
}: {
  readonly asked: number | undefined;
  readonly growth: Growth | undefined;
  readonly length: number | undefined;
  readonly method: string;
}): boolean {
  if (growth === FIXED && (method === 'resize' || method === 'grow')) {
    return true;
  }
  if (asked === undefined) {
    return false;
  }
  const most = growth?.most;
  return (
    !isIndex(asked) ||
    (most !== undefined && method !== 'transferToFixedLength' && asked > most) ||
    (method === 'grow' && length !== undefined && asked < length)
  );
}

/** The whole bytes `size`, where the code writes it, says — `0` of none given; none of what the compile cannot tell. */
function sizeOf(size: Expression | undefined, resolve: Resolve | undefined): number | undefined {
  if (size === undefined) {
    return 0;
  }
  const written = constantValue(size, resolve);
  return written === undefined ? undefined : wholeOf(written);
}

/**
 * How a buffer made of `options` may grow, where the code writes them: of none, of what is no
 * object, or of no `maxByteLength`, `undefined` among them, a size it keeps; of one, the most bytes
 * — `null` none; none of what the compile cannot tell.
 */
function growthOf(
  options: Expression | undefined,
  resolve: Resolve | undefined,
): Growth | undefined {
  const value = options === undefined ? undefined : writtenOf(options, resolve);
  if (value === undefined || primitiveOf(value, resolve) !== undefined) {
    return FIXED;
  }
  if (
    !isObjectLiteralExpression(value) ||
    value.properties.some((property) => isSpreadAssignment(property))
  ) {
    return undefined;
  }
  const entry = value.properties.find(
    (property) => 'name' in property && keyOf(property.name) === 'maxByteLength',
  );
  if (entry === undefined) {
    return FIXED;
  }
  if (!isPropertyAssignment(entry)) {
    return undefined;
  }
  const written = writtenOf(entry.initializer, resolve);
  if (written.kind === SyntaxKind.NullKeyword) {
    return { most: 0 };
  }
  if (primitiveOf(written, resolve) === 'nothing') {
    return FIXED;
  }
  const most = constantValue(written, resolve);
  return most === undefined ? undefined : { most: wholeOf(most) };
}

/** Whether `bytes` is an index a buffer may be of: none below none, none past 2⁵³ − 1. */
function isIndex(bytes: number): boolean {
  return bytes >= 0 && bytes <= Number.MAX_SAFE_INTEGER;
}

/**
 * Whether a construction of the typed array `path` names throws of the elements of an array the
 * code writes it is made of: `new BigInt64Array([1])`, `new Int32Array([1n])`.
 */
export function madeElementsThrow(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const [first] = given;
  if (first === undefined) {
    return false;
  }
  const value = writtenOf(first, resolve);
  const elements = isArrayLiteralExpression(value)
    ? value.elements
    : (typedArrayLikeElements(first, resolve) ?? []);
  return elementsThrow(path, elements, resolve);
}

/**
 * Whether a function that takes descriptors throws of those the code writes it is given
 * (`DESCRIBED`, `DESCRIBING`): of none where one is needed, of what is no object, or of one that
 * throws (`describesThrowing`).
 */
function descriptorsThrow(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const at = DESCRIBED.get(path);
  if (at !== undefined) {
    const descriptor = given[at];
    return descriptor === undefined || describesThrowing(descriptor, resolve);
  }
  const taking = DESCRIBING.get(path);
  const descriptors = taking === undefined ? undefined : given[taking.at];
  if (taking === undefined || descriptors === undefined) {
    return taking?.needed === true;
  }
  const value = writtenOf(descriptors, resolve);
  const kind = primitiveOf(value, resolve);
  if (kind === 'nothing') {
    return taking.needed || value.kind === SyntaxKind.NullKeyword;
  }
  // Text of characters, made an object, is of entries of no object.
  if (kind === 'text') {
    return true;
  }
  return isObjectLiteralExpression(value) && entriesThrow(value, resolve);
}

/** Whether an object of descriptors the code writes holds one that throws, of no spread among them. */
function entriesThrow(value: ObjectLiteralExpression, resolve: Resolve | undefined): boolean {
  if (value.properties.some((property) => isSpreadAssignment(property))) {
    return false;
  }
  return value.properties.some((property) => {
    if (isPropertyAssignment(property)) {
      return describesThrowing(property.initializer, resolve);
    }
    return (
      isShorthandPropertyAssignment(property) &&
      isIdentifier(property.name) &&
      describesThrowing(property.name, resolve)
    );
  });
}

/**
 * Whether `node`, a property's descriptor where the code writes it, throws as it is read: of a value
 * of no object; of a getter or a setter of no function, nor `undefined`; of an accessor beside a
 * value, `{ get() { … }, value: 1 }` — of no spread among its fields, whose fields may be any.
 */
function describesThrowing(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  if (primitiveOf(value, resolve) !== undefined) {
    return true;
  }
  if (
    !isObjectLiteralExpression(value) ||
    value.properties.some((property) => isSpreadAssignment(property))
  ) {
    return false;
  }
  const fields = value.properties.map((property) =>
    'name' in property ? keyOf(property.name) : undefined,
  );
  const calledNot = value.properties.some((property, index) => {
    return (
      ACCESSORS.has(fields[index] ?? '') &&
      isPropertyAssignment(property) &&
      isCalledNot(property.initializer, resolve)
    );
  });
  return (
    calledNot ||
    (fields.some((field = '') => ACCESSORS.has(field)) &&
      fields.some((field = '') => VALUES.has(field)))
  );
}

/** The name of a field the code writes: of a name, or text; none of another. */
function keyOf(name: Node): string | undefined {
  return isIdentifier(name) || isStringLiteral(name) ? name.text : undefined;
}

/**
 * Whether `node`, a getter or a setter given where the code writes it, is no function nor
 * `undefined`: `null`, a number, text, an array or an object written.
 */
function isCalledNot(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  if (isArrowFunction(value) || isFunctionExpression(value) || isClassExpression(value)) {
    return false;
  }
  const kind = primitiveOf(value, resolve);
  if (kind === 'nothing') {
    return value.kind === SyntaxKind.NullKeyword;
  }
  return kind !== undefined || isArrayLiteralExpression(value) || isObjectLiteralExpression(value);
}

/**
 * Whether `BigInt` throws of what the code writes it is given — nothing, a number of no integer,
 * text of none — or `BigInt.asIntN` and `BigInt.asUintN` of a width of bits below none or past
 * 2⁵³ − 1, or of a value of no `bigint` (`throwsMadeBig`).
 */
function bigIntThrows(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const [first, second] = given;
  if (path === 'BigInt') {
    return first === undefined || makesNoInteger(first, resolve);
  }
  if (path !== 'BigInt.asIntN' && path !== 'BigInt.asUintN') {
    return false;
  }
  const width = first === undefined ? 0 : constantValue(first, resolve);
  const bits = width === undefined ? 0 : wholeOf(width);
  return (
    bits < 0 ||
    bits > Number.MAX_SAFE_INTEGER ||
    second === undefined ||
    throwsMadeBig(second, resolve)
  );
}

/**
 * Whether `BigInt` of `node`, where the code writes it, throws: of nothing, `null` or `undefined`, a
 * number of no integer — `1.5`, `NaN` — or text of none.
 */
function makesNoInteger(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  if (primitiveOf(value, resolve) === 'nothing') {
    return true;
  }
  const written = constantValue(value, resolve);
  if (typeof written === 'number') {
    return !Number.isFinite(written) || Math.trunc(written) !== written;
  }
  return typeof written === 'string' && parsesNoBig(written);
}

/**
 * Whether `node`, where the code writes it, throws made a `bigint` as a typed array of them and
 * `BigInt.asIntN` make one: of nothing, of a number — which no `bigint` is made of so — and of text
 * of no integer; of a `bigint` or a boolean, not.
 */
function throwsMadeBig(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  if (
    isBigIntWritten(value, resolve) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword
  ) {
    return false;
  }
  if (primitiveOf(value, resolve) === 'nothing') {
    return true;
  }
  const written = constantValue(value, resolve);
  return typeof written === 'number' || (typeof written === 'string' && parsesNoBig(written));
}

/** Whether `text` is of no integer `BigInt` reads. */
function parsesNoBig(text: string): boolean {
  try {
    BigInt(text);
    return false;
  } catch {
    return true;
  }
}

/**
 * Whether `elements`, made elements of the typed array `kind` names, throw: of one of integers of
 * `bigint`, a number, nothing, a hole, text of no integer (`throwsMadeBig`); of one of numbers, a
 * `bigint`. What a spread hands, the compile reads not.
 */
function elementsThrow(
  kind: string,
  elements: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const big = BIG_ARRAYS.has(kind);
  if (!big && !NUMBER_ARRAYS.has(kind)) {
    return false;
  }
  return elements.some((each) => {
    if (isSpreadElement(each)) {
      return false;
    }
    if (isOmittedExpression(each)) {
      return big;
    }
    return (
      typedSymbolElement(each, resolve) ||
      (big ? throwsMadeBig(each, resolve) : isBigIntWritten(each, resolve))
    );
  });
}

/**
 * Whether a call of a typed array's throws of what it makes elements of, where the code writes it:
 * `BigInt64Array.of(1)`, `BigInt64Array.from([1])` — of no function to map them — `fill` and `with`
 * of a typed array the code makes, `set` of an array written, `Atomics.store` of one's value.
 */
function typedCallThrows(
  callee: Expression,
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const [root = '', method] = path.split('.', 2);
  if (method === 'of') {
    return elementsThrow(root, given, resolve);
  }
  if (method === 'from' && given.length === 1) {
    return madeElementsThrow(root, given, resolve);
  }
  const places = ATOMIC_VALUES.get(path);
  if (places !== undefined) {
    const array = given[0] === undefined ? undefined : writtenOf(given[0], resolve);
    const kind = array === undefined ? undefined : typedOf(array, resolve)?.kind;
    return (
      kind !== undefined &&
      elementsThrow(
        kind,
        places.flatMap((at) => given.slice(at, at + 1)),
        resolve,
      )
    );
  }
  return methodElementsThrow(callee, given, resolve);
}

/** Whether `fill`, `with` or `set`, called on a typed array the code makes, throws of its index or values. */
function methodElementsThrow(
  callee: Expression,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const member = calledMember(callee);
  if (member === undefined) {
    return false;
  }
  if (arrayMethodBoundsThrow(callee, given, resolve)) {
    return true;
  }
  const receiver = writtenOf(member.of, resolve);
  const typed = isNewExpression(receiver) ? typedOf(receiver, resolve) : undefined;
  if (typed === undefined) {
    return false;
  }
  const method = member.name;
  if (method === 'set') {
    return madeElementsThrow(typed.kind, given, resolve);
  }
  if (method === 'with' && withIndexThrows(given[0], typed.length, resolve)) {
    return true;
  }
  const at = ELEMENT_TAKERS.get(method);
  const value = at === undefined ? undefined : given[at];
  return value !== undefined && elementsThrow(typed.kind, [value], resolve);
}
