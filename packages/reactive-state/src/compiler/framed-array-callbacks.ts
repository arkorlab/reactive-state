import {
  type CallExpression,
  type Expression,
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isTypeNode,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { nativePath } from './framed-mutator-calls.ts';

/** The methods of an array that the language gives it: those a call of which runs no code of the program. */
export const ARRAY_METHODS: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Array.prototype).filter((name) => {
    return (
      name !== 'constructor' &&
      typeof (Array.prototype as unknown as Record<string, unknown>)[name] === 'function'
    );
  }),
);

/** The fields whose values are functions and data, no object the compile follows: a descriptor's, a list's length. */
export const DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set([
  'configurable',
  'enumerable',
  'get',
  'length',
  'set',
  'value',
  'writable',
]);

/** The fields of a list that hold data: its length. */
export const LIST_FIELDS: ReadonlySet<string> = new Set(['length']);

/** A literal that holds a followed object holds it in every field. */
export const NO_FIELDS: ReadonlySet<string> = new Set();

/** The natives that answer the entries and the values of an object, which are the parts of it. */
const ENTRIES = 'Object.entries';
const VALUES = 'Object.values';

/**
 * The readers that answer the fields of their argument themselves: the descriptor of a field holds
 * it as its `value`, so what is answered is written through where it is kept or used.
 */
export const GIVING_READERS: ReadonlySet<string> = new Set([
  'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertyDescriptors',
]);

/** The natives that read their arguments and run no application code on them. */
export const READERS: ReadonlySet<string> = new Set([
  'Array.isArray',
  'Number.isFinite',
  'Number.isInteger',
  'Number.isNaN',
  'Object.getOwnPropertyNames',
  'Object.isExtensible',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.keys',
  ...GIVING_READERS,
]);

/**
 * The natives that give the elements of an array to a new object: a new list, or the descriptors of its
 * fields, whose `value` is the element itself.
 */
export const COPIERS: ReadonlySet<string> = new Set([
  'Array.from',
  ENTRIES,
  VALUES,
  ...GIVING_READERS,
]);

/** The natives that convert an array to text or copy its elements, running its own methods. */
export const CONVERTERS: ReadonlySet<string> = new Set([
  'Array.from',
  'Boolean',
  ENTRIES,
  'JSON.stringify',
  'Number',
  'String',
  VALUES,
]);

/** Whether a node is the first argument of a call: the position a native reads, and a later one it coerces. */
export function isFirstArgument(call: Node, at: Node): call is CallExpression {
  if (!isCallExpression(call)) return false;
  const first: Node | undefined = call.arguments[0];
  return first === at;
}

/**
 * Whether a native reads or converts its first argument and calls no function of the program with it:
 * the replacer of `JSON.stringify`, its second argument, is called with the value it converts.
 */
export function readsWithoutCallback(call: CallExpression, path: string): boolean {
  if (!READERS.has(path) && !CONVERTERS.has(path)) return false;
  const replacer: Expression | undefined =
    path === 'JSON.stringify' ? call.arguments[1] : undefined;
  return replacer === undefined || unwrapped(replacer).kind === SyntaxKind.NullKeyword;
}

/** The parts of the path of a borrowed method: `Array.prototype.join.call`. */
const BORROWED_PATH = 4;

/** A native method of an array a call borrows: `Array.prototype.join.call(array, …)` or `.apply`. */
export interface Borrowed {
  readonly name: string;
  readonly apply: boolean;
  readonly receiver: Expression;
}

/**
 * The method a call borrows from the array prototype, and the receiver it is given. The callee is
 * written as the readers of borrowed calls read it, whole: `(0, Array.prototype.push).call(array, …)`
 * is a call they cannot follow.
 */
export function borrowedMethod(call: CallExpression): Borrowed | undefined {
  const path = globalPathOf(unwrapped(call.expression))?.join('.').split('.');
  const [receiver] = call.arguments;
  if (receiver === undefined || path?.length !== BORROWED_PATH) return undefined;
  const [owner, prototype, name, how] = path;
  if (name === undefined || !ARRAY_METHODS.has(name)) return undefined;
  const borrows = owner === 'Array' && prototype === 'prototype';
  return borrows && (how === 'call' || how === 'apply')
    ? { name, apply: how === 'apply', receiver }
    : undefined;
}

/**
 * The methods that read the element they are called on and answer a number, a boolean or a text, and
 * call no function of the program: the methods of a text and of a number, and the reads of an array
 * that answer no element. Called on a member of an array they leave the member as it was.
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'charAt',
  'charCodeAt',
  'codePointAt',
  'endsWith',
  'includes',
  'indexOf',
  'join',
  'lastIndexOf',
  'localeCompare',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'startsWith',
  'substring',
  'toExponential',
  'toFixed',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toPrecision',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
]);

/** The methods that answer an element of the array. */
export const ELEMENT_RETURNING: ReadonlySet<string> = new Set([
  'at',
  'find',
  'findLast',
  'pop',
  'shift',
]);

/** The place of the array among the parameters of a reducer: after the accumulator, the element and the index. */
const REDUCER_ARRAY = 3;

/** The methods that call back with the array itself, and the place of the parameter that is given it. */
const ARRAY_PARAMETER: ReadonlyMap<string, number> = new Map([
  ['every', 2],
  ['filter', 2],
  ['find', 2],
  ['findIndex', 2],
  ['findLast', 2],
  ['findLastIndex', 2],
  ['flatMap', 2],
  ['forEach', 2],
  ['map', 2],
  ['reduce', REDUCER_ARRAY],
  ['reduceRight', REDUCER_ARRAY],
  ['some', 2],
]);

/** Whether a method calls a function back, and may hand it the array, or the elements it holds (a comparator). */
export function callsBack(name: string): boolean {
  return ARRAY_PARAMETER.has(name) || name === 'sort' || name === 'toSorted';
}

/** The methods whose answer holds the elements of the array, or is one: an array that holds itself holds itself in it. */
const COPYING: ReadonlySet<string> = new Set([
  'at',
  'concat',
  'entries',
  'filter',
  'find',
  'findLast',
  'flat',
  'flatMap',
  'pop',
  'shift',
  'slice',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'values',
  'with',
]);

/** Whether a method answers elements of the array, in a new array, an iterator or alone. */
export function copiesElements(name: string): boolean {
  return COPYING.has(name);
}

/**
 * The natives that take no more than two arguments, and so ignore the third argument of a callback,
 * which is the array, and the fourth of a reducer. Another native may use it: a callback gets the
 * array as its third argument, or fourth for a reducer, and `Reflect.set` writes through it as the
 * receiver of the write, and a native that takes any number of arguments (`Math.max`, `Math.min`,
 * `Math.hypot`) converts each of them, which runs the methods of the array.
 */
const NON_RECEIVING: ReadonlySet<string> = new Set([
  'Array.isArray',
  'BigInt',
  'Boolean',
  ENTRIES,
  'isFinite',
  'isNaN',
  'Math.abs',
  'Math.acos',
  'Math.acosh',
  'Math.asin',
  'Math.asinh',
  'Math.atan',
  'Math.atan2',
  'Math.atanh',
  'Math.cbrt',
  'Math.ceil',
  'Math.clz32',
  'Math.cos',
  'Math.cosh',
  'Math.exp',
  'Math.expm1',
  'Math.f16round',
  'Math.floor',
  'Math.fround',
  'Math.imul',
  'Math.log',
  'Math.log1p',
  'Math.log2',
  'Math.log10',
  'Math.pow',
  'Math.random',
  'Math.round',
  'Math.sign',
  'Math.sin',
  'Math.sinh',
  'Math.sqrt',
  'Math.tan',
  'Math.tanh',
  'Math.trunc',
  'Number',
  'Number.isFinite',
  'Number.isInteger',
  'Number.isNaN',
  'Number.isSafeInteger',
  'Number.parseFloat',
  'Number.parseInt',
  'Object.getOwnPropertyNames',
  'Object.getOwnPropertySymbols',
  'Object.isExtensible',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.keys',
  'parseFloat',
  'parseInt',
  'String',
  VALUES,
]);

/**
 * Whether a method calls a function back with the array as an argument: a function of the program
 * that has a parameter for it (a rest parameter or `arguments` among them), or any callback that is
 * not written out, which may be one. The callback is the argument at `from`.
 */
export function handsArray(call: CallExpression, name: string, from = 0): boolean {
  const position = ARRAY_PARAMETER.get(name);
  const first = call.arguments[from];
  if (position === undefined || first === undefined) return false;
  const callback = unwrapped(first);
  if (!isArrowFunction(callback) && !isFunctionExpression(callback))
    return call.arguments.length > from + 1 || !NON_RECEIVING.has(nativePath(first) ?? '');
  return (
    callback.parameters.length > position ||
    callback.parameters.some((each) => each.dotDotDotToken !== undefined) ||
    mentionsArguments(callback)
  );
}

/** Whether a function names `arguments` anywhere. */
function mentionsArguments(fn: Node): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && node.text === 'arguments') return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
