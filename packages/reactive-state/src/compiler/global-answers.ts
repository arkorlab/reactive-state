import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';

/**
 * What a call of a global answers, as the language and the platform the browser and the authority
 * run on define it, whatever it is given: what no JSON holds — a promise, an object of a class, a
 * symbol, an integer of `bigint` — of the calls named here (`json-values.ts`), so that a state the
 * authority starts of one, `Promise.resolve(text)`, is refused as it compiles rather than as the
 * page first renders.
 */

/**
 * The globals every function of which answers what no JSON holds, called: an `AbortSignal` of
 * `AbortSignal.timeout(…)`, an array of their class of the typed arrays' `from` and `of`, an
 * iterator of `Iterator.from(…)`, a promise — or an object of one — of `Promise`'s, `caches`' and
 * `scheduler`'s, an object of a proxy and a function of `Proxy.revocable(…)`, a `Response` of
 * `Response.json(…)`, and nothing, `undefined`, of `console`'s.
 */
const NON_JSON_NAMESPACES: ReadonlySet<string> = new Set([
  'AbortSignal',
  'BigInt64Array',
  'BigUint64Array',
  'caches',
  'console',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Iterator',
  'Promise',
  'Proxy',
  'Response',
  'scheduler',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
]);

/**
 * The global functions that answer what no JSON holds, called as they are, without `new`: an error,
 * of `Error` and its kin; an integer of `bigint`, of `BigInt`; a `Buffer`, of Node's `Buffer`; a
 * function, of `Function`; a regular expression, of `RegExp`; a symbol, of `Symbol`; a promise, of
 * `fetch`; a timer, an object of Node's, of `setTimeout` and its kin.
 */
const NON_JSON_FUNCTIONS: ReadonlySet<string> = new Set([
  'AggregateError',
  'BigInt',
  'Buffer',
  'Error',
  'EvalError',
  'fetch',
  'Function',
  'RangeError',
  'ReferenceError',
  'RegExp',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

/**
 * The functions of globals that answer what no JSON holds, by the names they are read by: a
 * promise, of `Array.fromAsync` and of each of `crypto.subtle`'s; an object of one, of
 * `Atomics.waitAsync`; an integer of `bigint`, of `BigInt.asIntN` and `BigInt.asUintN`; a
 * `Buffer`, an array of its class, of Node's `Buffer.from`, `Buffer.alloc` and the rest of its
 * factories; an object of their class, of `Intl.Collator`, `Intl.DateTimeFormat` and `Intl.NumberFormat` called without
 * `new`; a `Map`, of `Map.groupBy`; a prototype, of `Object.getPrototypeOf` and
 * `Reflect.getPrototypeOf`; an object of the class it is given, of `Reflect.construct`; a symbol, of
 * `Symbol.for`; a `URL`, of `URL.parse`; an array of the class it is given, of
 * `crypto.getRandomValues`; symbols, of `Object.getOwnPropertySymbols`; a property's descriptor,
 * none of one it does not hold, an accessor's functions of one it computes, of
 * `Object.getOwnPropertyDescriptor` and `Reflect.getOwnPropertyDescriptor`; raw JSON text, of `JSON.rawJSON`, which JSON writes as the text it holds
 * and a copy of it as an object of an entry.
 */
const NON_JSON_MEMBERS: ReadonlySet<string> = new Set([
  'Array.fromAsync',
  'Atomics.waitAsync',
  'BigInt.asIntN',
  'BigInt.asUintN',
  'Buffer.alloc',
  'Buffer.allocUnsafe',
  'Buffer.allocUnsafeSlow',
  'Buffer.concat',
  'Buffer.copyBytesFrom',
  'Buffer.from',
  'Buffer.of',
  'crypto.getRandomValues',
  'crypto.subtle',
  'Intl.Collator',
  'Intl.DateTimeFormat',
  'Intl.NumberFormat',
  'JSON.rawJSON',
  'Map.groupBy',
  'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertySymbols',
  'Object.getPrototypeOf',
  'Reflect.construct',
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.getPrototypeOf',
  'Symbol.for',
  'URL.parse',
  'WebAssembly.compile',
  'WebAssembly.compileStreaming',
  'WebAssembly.instantiate',
  'WebAssembly.instantiateStreaming',
]);

/**
 * The functions of globals that write entries on the object they are given first, and answer it: of
 * an array, or of what the code does not show, which may be one, an entry beside its elements, or
 * a `length` that makes it one of holes, which no JSON holds — `Object.assign([], { length: 1 })`.
 */
const WRITING: ReadonlySet<string> = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
]);

/**
 * The functions of globals that answer an object of the prototype they are given — which no JSON
 * holds but of `null` or `Object.prototype`, which `JSON.parse` makes — `Object.create(base)`,
 * `Object.setPrototypeOf(value, base)`.
 */
const PROTOTYPING: ReadonlySet<string> = new Set(['Object.create', 'Object.setPrototypeOf']);

/** The members of `NON_JSON_MEMBERS` every function of which answers what no JSON holds: a promise. */
const NON_JSON_WITHIN: ReadonlySet<string> = new Set(['crypto.subtle']);

/** The globals that name the global object itself: `globalThis.fetch` is `fetch`. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'self', 'window']);

/** Whether `call` calls a function of a global's that answers what no JSON holds (`NON_JSON_…`). */
export function callsNonJsonGlobal(call: CallExpression): boolean {
  const path = globalPath(unwrapped(call.expression));
  const [root] = path ?? [];
  if (path === undefined || root === undefined) {
    return false;
  }
  if (path.length === 1) {
    return (
      NON_JSON_FUNCTIONS.has(root) ||
      (root === 'Object' && boxes(call)) ||
      (root === 'Array' && holes(call))
    );
  }
  const name = path.join('.');
  if (WRITING.has(name)) {
    return (
      !isWrittenObject(call.arguments[0]) ||
      (name !== 'Object.assign' && definesHidden(call, name === 'Object.defineProperty'))
    );
  }
  if (PROTOTYPING.has(name)) {
    return prototypes(call, name === 'Object.create');
  }
  // `Intl.NumberFormat(…)` is an object of its class, `Intl.NumberFormat.supportedLocalesOf(…)` text.
  return (
    NON_JSON_NAMESPACES.has(root) ||
    NON_JSON_MEMBERS.has(name) ||
    path.some((_, index) => index > 0 && NON_JSON_WITHIN.has(path.slice(0, index + 1).join('.')))
  );
}

/**
 * Whether `Object.defineProperty(…)` — `alone` — or `Object.defineProperties(…)` of what `call`
 * gives it may define a property JSON leaves out, or computes: of any descriptor but one the code
 * writes of a value, `enumerable: true` — which a descriptor is not unless it says so — and no
 * accessor.
 */
function definesHidden(call: CallExpression, alone: boolean): boolean {
  const [, second, third] = call.arguments;
  if (alone) {
    return !isPlainDescriptor(third);
  }
  const descriptors = second === undefined ? undefined : unwrapped(second);
  if (descriptors === undefined || !isObjectLiteralExpression(descriptors)) {
    return true;
  }
  return descriptors.properties.some(
    (property) => !isPropertyAssignment(property) || !isPlainDescriptor(property.initializer),
  );
}

/** Whether `node` is a descriptor the code writes of a value, `enumerable: true`, no accessor. */
function isPlainDescriptor(node: Expression | undefined): boolean {
  const descriptor = node === undefined ? undefined : unwrapped(node);
  if (descriptor === undefined || !isObjectLiteralExpression(descriptor)) {
    return false;
  }
  let isEnumerable = false;
  for (const property of descriptor.properties) {
    if (
      !isPropertyAssignment(property) ||
      !(isIdentifier(property.name) || isStringLiteral(property.name))
    ) {
      return false;
    }
    const name = property.name.text;
    if (name === 'get' || name === 'set') {
      return false;
    }
    if (name === 'enumerable') {
      isEnumerable = unwrapped(property.initializer).kind === SyntaxKind.TrueKeyword;
    }
  }
  return isEnumerable;
}

/**
 * Whether `Array(…)` of what `call` gives it may answer an array of holes as long as a number says,
 * which no JSON holds: of one argument, or of what a spread hands — but of none, or of more, the
 * array of them (`retained.ts`).
 */
function holes(call: CallExpression): boolean {
  return call.arguments.length === 1 || call.arguments.some((each) => isSpreadElement(each));
}

/**
 * Whether `Object.create(…)` — `creates` — or `Object.setPrototypeOf(…)` of what `call` gives it
 * may answer an object of another prototype than JSON's: of a prototype but `null` or
 * `Object.prototype` written there (`isPlainPrototype`); and, of `Object.create`, of descriptors that
 * define what JSON leaves out, or computes (`definesHidden`).
 */
function prototypes(call: CallExpression, creates: boolean): boolean {
  const [first, second] = call.arguments;
  if (!creates) {
    return !isPlainPrototype(second);
  }
  return !isPlainPrototype(first) || (second !== undefined && definesHidden(call, false));
}

/**
 * Whether `node` is the prototype of an object of JSON, written there: `null`, of an object of no
 * prototype, or `Object.prototype` — none of what a spread hands.
 */
export function isPlainPrototype(node: Expression | undefined): boolean {
  if (node === undefined || isSpreadElement(node)) {
    return false;
  }
  const given = unwrapped(node);
  return (
    given.kind === SyntaxKind.NullKeyword || globalPath(given)?.join('.') === 'Object.prototype'
  );
}

/** Whether `node` is an object the code writes there, `{}`: no array, nor what it does not show. */
function isWrittenObject(node: Expression | undefined): boolean {
  return node !== undefined && isObjectLiteralExpression(unwrapped(node));
}

/**
 * Whether `Object(…)` of what `call` gives it may answer an object of the class of what it is given
 * — `Object('x')`, a `String` — as it does of text, a number, a boolean: of anything but nothing, an
 * object or an array the code writes, which it answers as they are, and `null` and `undefined`, of
 * which it makes an object of no entries.
 */
function boxes(call: CallExpression): boolean {
  const [first] = call.arguments;
  if (first === undefined) {
    return false;
  }
  const given = unwrapped(first);
  return !(
    isObjectLiteralExpression(given) ||
    isArrayLiteralExpression(given) ||
    given.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(given) && globalOf(given) === 'undefined')
  );
}

/**
 * The names a read of a global's member goes by, the global first — `crypto`, `subtle`, `digest`
 * of `crypto.subtle.digest`, of `globalThis.crypto.subtle.digest` too — by its name or by text in
 * brackets; none of what reads no global, or by a key the code computes.
 */
export function globalPath(node: Expression): readonly string[] | undefined {
  const names: string[] = [];
  let each = node;
  for (;;) {
    if (isPropertyAccessExpression(each)) {
      names.unshift(each.name.text);
      each = unwrapped(each.expression);
    } else if (isElementAccessExpression(each)) {
      const key = literalKey(unwrapped(each.argumentExpression));
      if (key === undefined) {
        return undefined;
      }
      names.unshift(key);
      each = unwrapped(each.expression);
    } else {
      break;
    }
  }
  const root = globalOf(each);
  if (root === undefined) {
    return undefined;
  }
  return GLOBAL_OBJECTS.has(root) && names.length > 0 ? names : [root, ...names];
}
