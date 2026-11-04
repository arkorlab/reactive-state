import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isClassExpression,
  isComputedPropertyName,
  isFunctionExpression,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isSpreadElement,
  isSpreadAssignment,
  isShorthandPropertyAssignment,
  isMethodDeclaration,
  isIdentifier,
  isStringLiteral,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { calledMember, namesNamespace, unwrapped } from './bounded.ts';
import { globalPath } from './global-answers.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { functionReceiverThrows, invokedClassThrows } from './throw-callable-brands.ts';
import { compileReceiverThrows } from './throw-native-next.ts';
import { legacyAccessor, objectNullishReceiver } from './throw-object-methods.ts';
import { promiseReceiverThrows } from './throw-promise-brands.ts';
import { prototypeCycleThrows } from './throw-prototype-cycles.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { stringSymbolReceiverThrows, symbolCallbackThrows } from './throw-symbol-roles.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { registeredWeakEntriesThrow } from './throw-weak-symbols.ts';

/**
 * What a construction of the language's classes throws of the kind of what it is given — a `Proxy`
 * of a target or a handler of no object, a `Promise` or a `FinalizationRegistry` of no function, a
 * `WeakRef` of no object, a `WeakMap` or a `WeakSet` of what holds none — and what a method of a
 * class of its own throws called on what is none of the class's, borrowed:
 * `Date.prototype.getTime.call({})`.
 */

/** Of the classes of what they take, the places of what must be an object, and of what must be a function. */
const TAKING: ReadonlyMap<
  string,
  { readonly functions: readonly number[]; readonly objects: readonly number[] }
> = new Map([
  ['FinalizationRegistry', { functions: [0], objects: [] }],
  ['Promise', { functions: [0], objects: [] }],
  ['Proxy', { functions: [], objects: [0, 1] }],
  ['WeakRef', { functions: [], objects: [0] }],
]);

/** The names a method of a class's prototype goes by: the class, `prototype`, the method. */
const PROTOTYPE_METHOD = 3;

/** What of the kinds of a value is no object. */
const PRIMITIVES: ReadonlySet<string> = new Set(['bigint', 'boolean', 'nothing', 'number', 'text']);

/** The methods that call a function they are given first for each element — throwing of none. */
const CALLING_FIRST: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
]);

/** The methods that compare by a function they are given first — or, of `undefined`, as they will. */
const COMPARING_FIRST: ReadonlySet<string> = new Set(['sort', 'toSorted']);

/** The typed arrays, whose methods are one another's. */
const TYPED_ARRAYS: ReadonlySet<string> = new Set([
  'BigInt64Array',
  'BigUint64Array',
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

/**
 * The classes whose methods throw called on what is none of theirs — a typed array's but
 * `toString`, which is an array's; a pattern's `exec` and `test` alone, which others take of what
 * holds an `exec` of its own — beside which text's and an array's take anything but nothing.
 */
const BRANDED: ReadonlySet<string> = new Set([
  'ArrayBuffer',
  'BigInt',
  'Boolean',
  'DataView',
  'Date',
  'Map',
  'Number',
  'RegExp',
  'Set',
  'SharedArrayBuffer',
  'Symbol',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  ...TYPED_ARRAYS,
]);

/** The classes whose methods take what they are called on of any kind but nothing. */
const GENERIC: ReadonlySet<string> = new Set(['Array', 'String']);

/** What a value the code writes is of where it tells: nothing, a kind of a primitive, a class it makes. */
type Kind =
  | 'array'
  | 'bigint'
  | 'boolean'
  | 'function'
  | 'nothing'
  | 'number'
  | 'object'
  | 'text'
  | `new ${string}`;

/**
 * Whether making the class `path` names throws of the kind of what the code writes it is given
 * (`TAKING`): of no object where it takes one — nothing, a primitive — of no function where it takes
 * one; of what a `WeakMap` or a `WeakSet` is made of, an element of no object.
 */
export function madeKindsThrow(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (given.some((each) => isSpreadElement(each))) {
    return false;
  }
  const taking = TAKING.get(path);
  if (taking !== undefined) {
    const positions = [...taking.objects, ...taking.functions];
    const symbol =
      path !== 'WeakRef' &&
      positions.some((at) => {
        const operand = given[at];
        return operand !== undefined && isSymbolWritten(operand, resolve);
      });
    return (
      symbol ||
      taking.objects.some((at) => isNoObject(kindOf(given[at], resolve))) ||
      taking.functions.some((at) => isNoFunction(kindOf(given[at], resolve)))
    );
  }
  if (path !== 'WeakMap' && path !== 'WeakSet') {
    return false;
  }
  if (registeredWeakEntriesThrow(path, given, resolve)) {
    return true;
  }
  const [entries] = given;
  const value = entries === undefined ? undefined : writtenOf(entries, resolve);
  if (value === undefined || !isArrayLiteralExpression(value)) {
    return false;
  }
  return value.elements.some((element) => {
    if (isSpreadElement(element)) {
      return false;
    }
    if (isOmittedExpression(element)) {
      return true;
    }
    const entry = writtenOf(element, resolve);
    if (path === 'WeakSet' || !isArrayLiteralExpression(entry)) {
      return isNoObject(kindOf(element, resolve));
    }
    const [key] = entry.elements;
    return key === undefined || isOmittedExpression(key) || isNoObject(kindOf(key, resolve));
  });
}

/**
 * Whether a call throws of a function it is given that the code writes no function: `Array.from`'s
 * and a typed array's `from`'s second, of `undefined` alone; an array's, a map's and a set's that
 * call one for each element first (`CALLING_FIRST`); one that compares by one, of `undefined` alone
 * (`COMPARING_FIRST`) — but of what holds methods of its own of those names (`ownsCallers`).
 */
export function callbackKindsThrow(
  callee: Expression,
  path: string,
  given: readonly Expression[],
  {
    resolve,
    borrowed = false,
  }: { readonly resolve: Resolve | undefined; readonly borrowed?: boolean },
): boolean {
  if (given.some((each) => isSpreadElement(each))) {
    return false;
  }
  if (invokedClassThrows(callee, given, resolve)) {
    return true;
  }
  const [root = '', made] = path.split('.', 2);
  if (made === 'from' && (root === 'Array' || TYPED_ARRAYS.has(root))) {
    return isNoCallback(given[1], true, resolve, callee);
  }
  if (legacyAccessor(callee, given, resolve, borrowed)) {
    return isNoCallback(given[1], false, resolve, callee);
  }
  const member = calledMember(callee);
  if (member === undefined || (!borrowed && ownsCallers(member.of, resolve))) {
    return false;
  }
  if (CALLING_FIRST.has(member.name)) {
    return isNoCallback(given[0], false, resolve, callee);
  }
  return COMPARING_FIRST.has(member.name) && isNoCallback(given[0], true, resolve, callee);
}

/**
 * Whether `node`, a function a call is given, is none the code writes: nothing — but `undefined`
 * where `optional` — `null`, a primitive, an array or an object written there; none of what the
 * compile cannot tell.
 */
function isNoCallback(
  node: Expression | undefined,
  optional: boolean,
  resolve: Resolve | undefined,
  callee: Expression,
): boolean {
  const value = node === undefined ? undefined : writtenOf(node, resolve);
  if (value === undefined || primitiveOf(value, resolve) === 'nothing') {
    return !optional || value?.kind === SyntaxKind.NullKeyword;
  }
  return isNoFunction(kindOf(value, resolve)) || symbolCallbackThrows(value, callee, resolve);
}

/**
 * Whether `receiver`, where the code writes it, holds methods of its own of the names of an array's
 * that call a function: an object written there, a module's namespace, a function, an instance of
 * a class of the application's.
 */
function ownsCallers(receiver: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(receiver, resolve);
  if (isNewExpression(value)) {
    return globalPath(unwrapped(value.expression)) === undefined;
  }
  return (
    isObjectLiteralExpression(value) ||
    namesNamespace(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value)
  );
}

/**
 * Whether a method of a class's own, borrowed — `Date.prototype.getTime.call(value)`, `apply`,
 * `Reflect.apply(Map.prototype.get, value, [key])` — throws of what the code writes it is called on:
 * of nothing; of what is none of the class's where it takes its own alone (`BRANDED`).
 */
export function borrowedReceiverThrows(
  callee: Expression,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (given.some((each) => isSpreadElement(each))) {
    return false;
  }
  const lent = lentOf(callee, given);
  if (lent === undefined) {
    return false;
  }
  const compiled = compileReceiverThrows(
    callee,
    {
      brand: lent.brand,
      method: lent.method,
      kind: kindOf(lent.receiver, resolve),
    },
    resolve,
  );
  if (compiled !== undefined) {
    return compiled;
  }
  if (lent.brand === 'Function') {
    return functionReceiverThrows(lent, callee, resolve);
  }
  if (lent.brand === 'Promise') {
    const held: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
    return lent.method === 'then' && promiseReceiverThrows(callee, kindOf(lent.receiver, held));
  }
  if (lent.brand === 'Date' && lent.method === 'toJSON') {
    return dateJsonThrows(lent.receiver, resolve);
  }
  if (lent.brand === 'String' && stringSymbolReceiverThrows(lent, callee, resolve)) {
    return true;
  }
  const kind = lent.receiver === undefined ? 'nothing' : kindOf(lent.receiver, resolve);
  if (kind === undefined) {
    return false;
  }
  if (kind === 'nothing') {
    return (
      BRANDED.has(lent.brand) ||
      GENERIC.has(lent.brand) ||
      (lent.brand === 'Object' && objectNullishReceiver(callee, lent.method, given))
    );
  }
  return takesOwnAlone(lent.brand, lent.method) && !isOwn(lent.brand, kind, lent.receiver);
}

/**
 * Whether generic `Date.prototype.toJSON` throws of a written receiver: nothing, a finite primitive
 * with no `toISOString`, or a plain object with no callable method. A non-finite numeric primitive
 * answers `null` before reading a method, and an object's own conversions remain for the runtime.
 */
function dateJsonThrows(receiver: Expression | undefined, resolve: Resolve | undefined): boolean {
  if (receiver === undefined) {
    return true;
  }
  const value = writtenOf(receiver, resolve);
  const number = constantValue(value, resolve);
  if (typeof number === 'number') {
    return Number.isFinite(number);
  }
  if (primitiveOf(value, resolve) !== undefined || isSymbolWritten(value, resolve)) {
    return true;
  }
  if (!isObjectLiteralExpression(value)) {
    return isArrayLiteralExpression(value) || isRegularExpressionLiteral(value);
  }
  return plainDateJsonThrows(value, resolve);
}

/** Whether a plain object with ordinary primitive conversion lacks a callable `toISOString`. */
function plainDateJsonThrows(
  value: ObjectLiteralExpression,
  resolve: Resolve | undefined,
): boolean {
  let method: Expression | 'callable' | undefined;
  for (const property of value.properties) {
    if (isSpreadAssignment(property) || isComputedPropertyName(property.name)) {
      return false;
    }
    const { name } = property;
    if (
      !(isIdentifier(name) || isStringLiteral(name)) ||
      ['__proto__', 'toString', 'valueOf'].includes(name.text)
    ) {
      return false;
    }
    if (name.text !== 'toISOString') {
      continue;
    }
    if (isMethodDeclaration(property)) {
      method = 'callable';
    } else if (isPropertyAssignment(property)) {
      method = property.initializer;
    } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      method = property.name;
    } else {
      return false;
    }
  }
  return method !== 'callable' && wrongTarget(method, false, resolve);
}

/** Whether Object or Reflect sets a prototype the code writes neither an object nor `null`. */
export function prototypeArgumentThrows(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (
    (path !== 'Object.setPrototypeOf' && path !== 'Reflect.setPrototypeOf') ||
    given.some((each) => isSpreadElement(each))
  ) {
    return false;
  }
  const [, prototype] = given;
  if (prototype === undefined) {
    return true;
  }
  const value = writtenOf(prototype, resolve);
  return (
    (value.kind !== SyntaxKind.NullKeyword &&
      (primitiveOf(value, resolve) !== undefined || isSymbolWritten(value, resolve))) ||
    (path === 'Object.setPrototypeOf' && prototypeCycleThrows(given, resolve))
  );
}

/**
 * Whether Reflect invokes a target the code writes of no callable function or constructor, or
 * constructs with a `newTarget` of no constructor: an arrow, an async function or a generator.
 */
export function reflectedTargetThrows(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (
    (path !== 'Reflect.apply' && path !== 'Reflect.construct') ||
    given.some((each) => isSpreadElement(each))
  ) {
    return false;
  }
  const [target, , customTarget] = given;
  const constructs = path === 'Reflect.construct';
  return (
    wrongTarget(target, constructs, resolve) ||
    (constructs && given.length > 2 && wrongTarget(customTarget, true, resolve))
  );
}

/** Whether a target is statically no callable function, or no constructor where `constructs`. */
function wrongTarget(
  target: Expression | undefined,
  constructs: boolean,
  resolve: Resolve | undefined,
): boolean {
  if (target === undefined) {
    return true;
  }
  const value = writtenOf(target, resolve);
  if (isClassExpression(value)) {
    return !constructs;
  }
  if (isArrowFunction(value)) {
    return constructs;
  }
  if (isFunctionExpression(value)) {
    return (
      constructs &&
      (value.asteriskToken !== undefined ||
        value.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true)
    );
  }
  return (
    isNoFunction(kindOf(value, resolve)) ||
    isRegularExpressionLiteral(value) ||
    isSymbolWritten(value, resolve)
  );
}

/**
 * The class of the method `callee` borrows, the method, and what it calls it on — of `call` and
 * `apply` of `Date.prototype.getTime`, and of `Reflect.apply`; none of another call.
 */
function lentOf(
  callee: Expression,
  given: readonly Expression[],
):
  | { readonly brand: string; readonly method: string; readonly receiver: Expression | undefined }
  | undefined {
  const member = calledMember(callee);
  const reflected = globalPath(unwrapped(callee))?.join('.') === 'Reflect.apply';
  let borrowed: Expression | undefined;
  let receiver: Expression | undefined;
  if (reflected) {
    [borrowed, receiver] = given;
  } else if (member !== undefined && (member.name === 'call' || member.name === 'apply')) {
    borrowed = member.of;
    [receiver] = given;
  }
  const path = borrowed === undefined ? undefined : globalPath(unwrapped(borrowed));
  const [brand, prototype, method] = path ?? [];
  return brand !== undefined &&
    method !== undefined &&
    prototype === 'prototype' &&
    path?.length === PROTOTYPE_METHOD
    ? { brand, method, receiver }
    : undefined;
}

/** Whether the method `method` of `brand`'s takes what it is called on of the class alone. */
function takesOwnAlone(brand: string, method: string): boolean {
  if (brand === 'RegExp') {
    return method === 'exec' || method === 'test';
  }
  return BRANDED.has(brand) && !(method === 'toString' && TYPED_ARRAYS.has(brand));
}

/**
 * Whether what is of `kind` is `brand`'s own: a date of a date, a typed array of any, a number of
 * `Number`; of `RegExp`, a pattern, or an object the code writes of an `exec` of its own.
 */
function isOwn(brand: string, kind: Kind, receiver: Expression | undefined): boolean {
  if (kind.startsWith('new ')) {
    const made = kind.slice('new '.length);
    return made === brand || (TYPED_ARRAYS.has(made) && TYPED_ARRAYS.has(brand));
  }
  if (brand === 'RegExp') {
    return kind === 'object' && receiver !== undefined && holdsExec(receiver);
  }
  return (
    (brand === 'Number' && kind === 'number') ||
    (brand === 'Boolean' && kind === 'boolean') ||
    (brand === 'BigInt' && kind === 'bigint')
  );
}

/** Whether `receiver`, an object the code writes, holds an `exec` of its own. */
function holdsExec(receiver: Expression): boolean {
  const value = unwrapped(receiver);
  return (
    isObjectLiteralExpression(value) &&
    value.properties.some((property) => {
      const named =
        isPropertyAssignment(property) ||
        isMethodDeclaration(property) ||
        isShorthandPropertyAssignment(property);
      const { name } = named ? property : { name: undefined };
      return (
        name !== undefined && (isIdentifier(name) || isStringLiteral(name)) && name.text === 'exec'
      );
    })
  );
}

/**
 * What `node`, where the code writes it, is of: nothing, a primitive's kind, an array, an object or
 * a function written there, a pattern, `new` of a class of the language's; none of what it does not
 * tell, a symbol among it.
 */
function kindOf(node: Expression | undefined, resolve: Resolve | undefined): Kind | undefined {
  if (node === undefined) {
    return 'nothing';
  }
  const value = writtenOf(node, resolve);
  if (isArrowFunction(value) || isFunctionExpression(value) || isClassExpression(value)) {
    return 'function';
  }
  if (isRegularExpressionLiteral(value)) {
    return 'new RegExp';
  }
  if (isNewExpression(value)) {
    const made = globalPath(unwrapped(value.expression))?.join('.');
    return made === undefined ? undefined : `new ${made}`;
  }
  if (isArrayLiteralExpression(value)) {
    return 'array';
  }
  if (isObjectLiteralExpression(value)) {
    return 'object';
  }
  return primitiveKind(value, resolve);
}

/** What primitive `value` is, where the code writes it: nothing, text, a number, a boolean, a `bigint`. */
function primitiveKind(value: Expression, resolve: Resolve | undefined): Kind | undefined {
  const kind = primitiveOf(value, resolve);
  if (kind === 'nothing') {
    return 'nothing';
  }
  if (kind === 'text' || kind === 'empty') {
    return 'text';
  }
  if (value.kind === SyntaxKind.TrueKeyword || value.kind === SyntaxKind.FalseKeyword) {
    return 'boolean';
  }
  if (isBigIntLiteral(value)) {
    return 'bigint';
  }
  return typeof constantValue(value, resolve) === 'number' ? 'number' : undefined;
}

/** Whether what is of `kind` is no object: nothing, a primitive; none of what the compile cannot tell. */
function isNoObject(kind: Kind | undefined): boolean {
  return kind !== undefined && PRIMITIVES.has(kind);
}

/** Whether what is of `kind` is no function: no object, an array, an object written there. */
function isNoFunction(kind: Kind | undefined): boolean {
  return isNoObject(kind) || kind === 'array' || kind === 'object';
}
