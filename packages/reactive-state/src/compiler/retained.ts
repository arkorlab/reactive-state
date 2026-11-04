import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadAssignment,
  isSpreadElement,
} from 'typescript/ast';

import { ownsAccessorDefinition } from './accessor-methods.ts';
import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { ITERATING } from './iterators.ts';

/**
 * What the answer of a call of a global's function or of a value's method holds of what the call
 * hands it, as the language defines it: the elements of what it is called on (`slice`, `filter`,
 * `at`), what it is given (`Array.of`, `concat`, `with`), what the function it is given answers
 * (`map`, `flatMap`, `reduce`) — so that what no JSON holds there is what no JSON holds in its
 * answer (`json-values.ts`): `Array.of(helper)`, `[1].map(() => helper)` of a function `helper`;
 * the elements an array-like it reads lacks, `undefined` — `Array.from({ length: 1 })`; and
 * nothing, `undefined`, of a method that answers an element it may find none of — `at`, `find`,
 * `pop` — or answers nothing, `forEach`.
 */

/** What of what a call hands it a function's answer holds. */
interface Holding {
  /** Whether it holds the elements of what it is called on. */
  readonly target?: boolean;
  /** The places of the arguments it holds, or of the arrays it holds the elements of. */
  readonly values?: readonly number[];
  /** The place from which on it holds each argument. */
  readonly rest?: number;
  /** The places of the functions it is given whose answers it holds. */
  readonly functions?: readonly number[];
  /** Whether it may answer nothing, `undefined`: of an element it finds none of, or of none at all. */
  readonly nothing?: boolean;
  /** The place of the first value it is given: of none given there, it throws of no element. */
  readonly initial?: number;
  /** Whether the array it answers keeps the holes of what it is called on, as `map`'s does. */
  readonly holes?: boolean;
  /**
   * Whether it puts the value it is given at the indexes it is given next, `fill`'s, of which, put at
   * every index (`fillsWhole`), it holds none of the elements of an array the code writes there —
   * the holes of `Array(3)` among them.
   */
  readonly filling?: boolean;
  /** Whether it throws of an index it is given first past the bounds of what it is called on: `with`. */
  readonly bounded?: boolean;
  /**
   * Whether, called on an iterator, it answers another, of no JSON — `map`, `flatMap` — as it
   * answers an array called on one.
   */
  readonly iterating?: boolean;
  /**
   * Whether, called on one of the platform's classes whose methods answer nothing
   * (`VOIDING_CLASSES`), it answers nothing — `delete` — as a `Map`'s answers a boolean.
   */
  readonly voids?: boolean;
  /**
   * Whether, called on one of the platform's objects the code makes (`isPlatformMade`) — a body, a
   * `Response`, a `Request`, a `Blob`; a buffer, an `ArrayBuffer` — it answers what no JSON holds: a
   * promise of what it reads of a body, `json`, `text` and their kin, a stream of it, or another of
   * its kind, of `clone`, `transfer`.
   */
  readonly made?: boolean;
  /** The places of the objects whose entries' values it holds as elements: `Object.values`'s. */
  readonly entries?: readonly number[];
  /** The places of the objects whose keys it holds: `Reflect.ownKeys`'s, of a symbol too. */
  readonly keys?: readonly number[];
  /**
   * The places of the patterns it holds what each group of captures of, `undefined` of one that
   * captures nothing — `split`'s — or what it is called on, a pattern's own `[Symbol.split]`.
   */
  readonly patterns?: readonly (number | 'target')[];
  /**
   * The places of what it reads as an array-like where it does not iterate it — each index below
   * its `length` — of an element it lacks making `undefined`: `Array.from`'s.
   */
  readonly likes?: readonly number[];
  /**
   * What it hands those functions: the places of their parameters it gives what it is handed, an
   * element or the whole, and of what — what it is called on, an argument by its place.
   */
  readonly handing?: {
    readonly parameters: readonly number[];
    readonly of: readonly (number | 'target')[];
  };
}

/** A function a call is given whose answer its answer holds, and what the call hands it. */
export interface HeldFunction {
  readonly fn: Expression;
  /** The places of its parameters the call gives what `of` holds, or the elements of it. */
  readonly parameters: readonly number[];
  readonly of: readonly Expression[];
  /** What the call reads as an array-like, the elements it lacks handed as `undefined`. */
  readonly likes: readonly Expression[];
}

/** What a call's answer holds, as `heldBy` reads it. */
export interface Held {
  /** What it holds, or holds the elements or the entries of. */
  readonly values: readonly Expression[];
  /**
   * What it is called on, whose elements it holds: of nothing, the call throws — or, through `?.`
   * (`optional`), answers nothing — and holds none.
   */
  readonly target?: Expression | undefined;
  /** Whether it is called through `?.`, of which nothing it is called on makes it answer nothing. */
  readonly optional?: boolean;
  /** The functions it is given whose answers it holds. */
  readonly functions: readonly HeldFunction[];
  /** The objects whose entries' values it holds as elements, which no `undefined` of is. */
  readonly entries: readonly Expression[];
  /** The objects whose keys it holds, a symbol among them where one keys an entry. */
  readonly keys: readonly Expression[];
  /** The patterns it holds what each group of captures of, `undefined` of one that captures nothing. */
  readonly patterns: readonly Expression[];
  /**
   * What it reads as an array-like, of which it holds the elements it lacks as `undefined`, where
   * no function it is given answers in their place.
   */
  readonly likes: readonly Expression[];
  /**
   * Whether it answers what no JSON holds, whatever it is handed: an iterator, `items.values()`; an
   * array of a match, of names of its own beside its elements, `text.match(pattern)`; a promise,
   * `promise.then(…)`; an accessor, or nothing, of `__lookupGetter__` — but called on an object the
   * code writes of a method of its own of that name (`ownedBy`, `ownsMethod`).
   */
  readonly nonJson: boolean;
  /**
   * What it is called on, and by what name, where it answers what no JSON holds by its name alone
   * (`nonJson`): an object the code writes of a method of its own of the name answers as its code
   * does.
   */
  readonly ownedBy?: { readonly receiver: Expression; readonly name: string } | undefined;
  /** Whether it may answer nothing, `undefined` (`Holding.nothing`), as an object's entry may hold. */
  readonly nothing: boolean;
  /**
   * Whether it is given no first value (`Holding.initial`) — none there, or past a spread, which may
   * hand none — of which it throws where what it is called on holds no element.
   */
  readonly emptyThrows?: boolean;
  /** What it is called on, whose holes the array it answers keeps (`Holding.holes`), JSON's `null`. */
  readonly keepsHoles?: Expression | undefined;
  /** Whether it throws of an index past the bounds of what it is called on (`Holding.bounded`). */
  readonly bounded?: boolean;
  /**
   * What it is called on, of which an iterator makes it answer another (`Holding.iterating`), of no
   * JSON: `items.values().map(…)`.
   */
  readonly iterates?: Expression | undefined;
  /**
   * What it is called on, of which one of `VOIDING_CLASSES` makes it answer nothing
   * (`Holding.voids`): `params.delete('a')` of `new URLSearchParams()`.
   */
  readonly voidsOn?: Expression | undefined;
  /**
   * What it is called on, of which one of the platform's objects the code makes (`isPlatformMade`)
   * makes it answer what no JSON holds (`Holding.made`): `response.json()` of `new Response(text)`.
   */
  readonly madeOf?: Expression | undefined;
}

/** The functions of globals whose answers hold what they are given, by the names they are read by. */
const HOLDING_GLOBALS: ReadonlyMap<string, Holding> = new Map([
  // Of more than one argument; of one, an array of holes as long as a number says
  // (`global-answers.ts`).
  ['Array', { rest: 0 }],
  [
    'Array.from',
    { functions: [1], handing: { of: [0], parameters: [0] }, likes: [0], values: [0] },
  ],
  ['Array.of', { rest: 0 }],
  // Nothing, of what clears a timer, schedules a function or reports an error.
  ['cancelAnimationFrame', { nothing: true }],
  ['cancelIdleCallback', { nothing: true }],
  ['clearImmediate', { nothing: true }],
  ['clearInterval', { nothing: true }],
  ['clearTimeout', { nothing: true }],
  // What a reviver answers stands in what `JSON.parse` answers.
  ['JSON.parse', { functions: [1] }],
  ['Object.assign', { rest: 0 }],
  // What its descriptors hold, of the entries it defines.
  ['Object.create', { rest: 1 }],
  ['Object.defineProperties', { rest: 0 }],
  ['Object.defineProperty', { rest: 0 }],
  ['Object.entries', { entries: [0] }],
  ['Object.freeze', { values: [0] }],
  ['Object.fromEntries', { values: [0] }],
  // A descriptor of each entry, by its key, of what it holds or the accessor that computes it.
  ['Object.getOwnPropertyDescriptors', { keys: [0], values: [0] }],
  // What its function answers keys the groups: a symbol, an entry no JSON holds.
  ['Object.groupBy', { functions: [1], handing: { of: [0], parameters: [0] }, values: [0] }],
  ['Object.preventExtensions', { values: [0] }],
  ['Object.seal', { values: [0] }],
  ['Object.setPrototypeOf', { values: [0] }],
  ['Object.values', { entries: [0] }],
  ['queueMicrotask', { nothing: true }],
  ['Reflect.ownKeys', { keys: [0] }],
  ['reportError', { nothing: true }],
  ['structuredClone', { values: [0] }],
]);

/** The place of the parameter `reduce` hands the whole array: after what it holds, an element, its index. */
const REDUCED_ARRAY = 3;

/**
 * What `reduce` hands its function: what it holds so far, of the first value or of the elements, an
 * element, and the whole.
 */
const REDUCING: Holding['handing'] = { of: ['target', 1], parameters: [0, 1, REDUCED_ARRAY] };

/** The methods of a value whose answers hold what they are called on, given, or what their function answers. */
const HOLDING_METHODS: ReadonlyMap<string, Holding> = new Map([
  // A promise of what a body the code makes holds, read whole.
  ['arrayBuffer', { made: true }],
  // Of an index past the end, nothing: `['x'].at(1)`, of text too; so `find`'s of no element found,
  // `pop`'s and `shift`'s of an empty array.
  ['at', { nothing: true, target: true }],
  ['blob', { made: true }],
  ['bytes', { made: true }],
  // Of a `Map` or a `Set`, nothing, of which it holds none since.
  ['clear', { nothing: true }],
  // Another body, of one the code makes.
  ['clone', { made: true }],
  // Of text alone: the code point at an index, nothing past the end.
  ['codePointAt', { nothing: true }],
  ['concat', { rest: 0, target: true }],
  ['copyWithin', { target: true }],
  ['delete', { voids: true }],
  // Of an iterator, another of what it is of; so `take`'s.
  ['drop', { target: true }],
  ['fill', { filling: true, target: true, values: [0] }],
  ['filter', { target: true }],
  ['find', { nothing: true, target: true }],
  ['findLast', { nothing: true, target: true }],
  ['flat', { target: true }],
  ['flatMap', { functions: [0], handing: { of: ['target'], parameters: [0, 2] }, iterating: true }],
  ['forEach', { nothing: true }],
  ['formData', { made: true }],
  ['json', { made: true }],
  [
    'map',
    {
      functions: [0],
      handing: { of: ['target'], parameters: [0, 2] },
      holes: true,
      iterating: true,
    },
  ],
  ['pop', { nothing: true, target: true }],
  // Of no first value, the first element stands as it until the function answers otherwise.
  ['reduce', { functions: [0], handing: REDUCING, initial: 1, target: true, values: [1] }],
  ['reduceRight', { functions: [0], handing: REDUCING, initial: 1, target: true, values: [1] }],
  ['reverse', { target: true }],
  ['shift', { nothing: true, target: true }],
  ['slice', { target: true }],
  ['sort', { target: true }],
  ['splice', { target: true }],
  // Of a pattern's groups, what each captures, among the text it divides.
  ['split', { patterns: [0] }],
  // A stream of what a body the code makes holds.
  ['stream', { made: true }],
  // A pattern's own, of the text it is given: what each group of it captures, among the text.
  ['Symbol.split', { patterns: ['target'] }],
  ['take', { target: true }],
  ['text', { made: true }],
  ['toReversed', { target: true }],
  ['toSorted', { target: true }],
  ['toSpliced', { rest: 2, target: true }],
  // Another buffer, of one the code makes, which it detaches.
  ['transfer', { made: true }],
  ['transferToFixedLength', { made: true }],
  ['with', { bounded: true, target: true, values: [1] }],
]);

/**
 * Legacy methods of every object that define an accessor and return nothing, or look one up and
 * return a function or nothing.
 */
const LEGACY_ACCESSORS: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/**
 * The methods of a collection that answer what they are called on, a `Set` or a `Map`, once they
 * put in what they are given — `add`, `set` — and of others of those names, nothing: none JSON.
 */
const PUTTING_IN: ReadonlySet<string> = new Set(['add', 'set']);

/**
 * The methods of a `Set` that answer another `Set`, of what it and what it is given hold —
 * `union`, `intersection`, `difference`, `symmetricDifference` — and of others of those names,
 * whatever they answer: none JSON.
 */
const COMBINING: ReadonlySet<string> = new Set([
  'difference',
  'intersection',
  'symmetricDifference',
  'union',
]);

/**
 * The methods that answer nothing, called on one of the platform's the code makes
 * (`isVoidingReceiver`) — of a `URLSearchParams`, a `Headers`, a `FormData`, an `AbortController`, a
 * `DataView`, what dispatches events — though one of the application's of those names may answer.
 */
const VOIDING: ReadonlySet<string> = new Set([
  'abort',
  'addEventListener',
  'append',
  'grow',
  'prepend',
  'removeEventListener',
  'resize',
  'setBigInt64',
  'setBigUint64',
  'setFloat16',
  'setFloat32',
  'setFloat64',
  'setInt8',
  'setInt16',
  'setInt32',
  'setUint8',
  'setUint16',
  'setUint32',
]);

/**
 * The platform's classes whose methods that change what one holds answer nothing — `append`, `set`,
 * `delete`, `sort`, `abort`, a `DataView`'s setters, a buffer's `resize` and `grow`,
 * `addEventListener` — where a `Map`'s and a `Set`'s `delete` answer a boolean.
 */
const VOIDING_CLASSES: ReadonlySet<string> = new Set([
  'AbortController',
  'ArrayBuffer',
  'DataView',
  'EventTarget',
  'FormData',
  'Headers',
  'SharedArrayBuffer',
  'URLSearchParams',
]);

/** What a call answers that holds nothing of what it is handed, as a name of its alone says. */
const HOLDING_NOTHING: Held = {
  entries: [],
  functions: [],
  keys: [],
  likes: [],
  nonJson: false,
  nothing: false,
  patterns: [],
  values: [],
};

/** The methods of a value that answer a promise, which no JSON holds: `then`, `catch`, `finally`. */
const PROMISING: ReadonlySet<string> = new Set(['catch', 'finally', 'then']);

/**
 * The methods of a value that answer an array of a match — of names of its own beside its elements,
 * `index`, `input`, `groups`, which the authority refuses as no JSON — or `null`: a pattern's
 * `exec`, text's `match`.
 */
const MATCHING: ReadonlySet<string> = new Set(['exec', 'match', 'Symbol.match']);

/**
 * The methods that answer a view of the typed array, or the `Buffer`, they are called on:
 * `subarray`.
 */
const VIEWING: ReadonlySet<string> = new Set(['subarray']);

/** The typed arrays, by their classes' names, whose methods answer another of their kind. */
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

/** The methods that answer what they are called on, a pattern made anew of what they are given: `compile`. */
const COMPILING: ReadonlySet<string> = new Set(['compile']);

/** The names of the methods that answer what no JSON holds, whatever they are handed. */
const ANSWERING_NON_JSON: readonly ReadonlySet<string>[] = [
  COMBINING,
  COMPILING,
  VIEWING,
  ITERATING,
  LEGACY_ACCESSORS,
  MATCHING,
  PROMISING,
  PUTTING_IN,
];

/**
 * What the answer of `call` holds, where it calls a global's function or a value's method this
 * module names (`HOLDING_…`, `ITERATING`, `MATCHING`, `PROMISING`); none of another. A spread
 * hands any argument from it on.
 */
export function heldBy(call: CallExpression): Held | undefined {
  const callee = unwrapped(call.expression);
  const path = globalPath(callee);
  if (path !== undefined) {
    const holding = HOLDING_GLOBALS.get(path.join('.'));
    return holding === undefined ? undefined : handed(call, holding, undefined);
  }
  const name = methodName(callee);
  if (
    name === undefined ||
    !(isPropertyAccessExpression(callee) || isElementAccessExpression(callee))
  ) {
    return undefined;
  }
  // `params.append('a', 'b')` of `new URLSearchParams()`: nothing, of the platform's alone.
  if (VOIDING.has(name)) {
    return { ...HOLDING_NOTHING, voidsOn: callee.expression };
  }
  if (ANSWERING_NON_JSON.some((names) => names.has(name))) {
    return { ...HOLDING_NOTHING, nonJson: true, ownedBy: { name, receiver: callee.expression } };
  }
  const holding = HOLDING_METHODS.get(name);
  return holding === undefined
    ? undefined
    : { ...handed(call, holding, callee.expression), optional: isOptional(callee) };
}

/** The methods of a typed array that answer another of its kind. */
const TYPED_ANSWERS: ReadonlySet<string> = new Set([
  'copyWithin',
  'fill',
  'filter',
  'map',
  'reverse',
  'slice',
  'sort',
  'subarray',
  'toReversed',
  'toSorted',
  'with',
]);

/**
 * Whether `node` is a typed array, where the code makes one: of its class, `new Uint8Array(…)`, its
 * `from` or `of`, or a method of one that answers another — `subarray`, `slice`, `map`, `filter` and
 * their kin — a name read as what `reach` says it holds.
 */
export function isTypedArray(node: Expression, reach: (node: Expression) => Expression): boolean {
  const seen = new Set<Expression>();
  for (let value = reach(node); !seen.has(value);) {
    seen.add(value);
    if (isNewExpression(value)) {
      return TYPED_ARRAYS.has(globalPath(unwrapped(value.expression))?.join('.') ?? '');
    }
    if (!isCallExpression(value)) {
      return false;
    }
    const callee = unwrapped(value.expression);
    const path = globalPath(callee);
    if (path !== undefined) {
      const [made = '', by] = path;
      return path.length === 2 && TYPED_ARRAYS.has(made) && (by === 'from' || by === 'of');
    }
    if (!isPropertyAccessExpression(callee) || !TYPED_ANSWERS.has(callee.name.text)) {
      return false;
    }
    value = reach(callee.expression);
  }
  return false;
}

/**
 * The platform's classes of a body and of a buffer, whose methods that read a body answer a promise
 * of it — `json`, `text` — and that copy one answer another of its kind: `clone`, `transfer`.
 */
const MADE_CLASSES: ReadonlySet<string> = new Set([
  'ArrayBuffer',
  'Blob',
  'File',
  'Request',
  'Response',
  'SharedArrayBuffer',
]);

/** The methods of a body or a buffer that answer another of its kind: `clone`, `slice`, `transfer`. */
const COPYING: ReadonlySet<string> = new Set([
  'clone',
  'slice',
  'transfer',
  'transferToFixedLength',
]);

/** The functions of `Response` that make one: `Response.json(…)` and its kin. */
const MAKING_RESPONSES: ReadonlySet<string> = new Set([
  'Response.error',
  'Response.json',
  'Response.redirect',
]);

/**
 * Whether `node` is one of the platform's objects the code makes (`MADE_CLASSES`) — a `Response`, a
 * `Request`, a `Blob`, a `File`, an `ArrayBuffer` — of its class, `new Response(text)`, of
 * `Response`'s own functions, `Response.json(value)`, or of a copy of one (`COPYING`); a name read as
 * what `reach` says it holds.
 */
export function isPlatformMade(node: Expression, reach: (node: Expression) => Expression): boolean {
  const seen = new Set<Expression>();
  for (let value = reach(node); !seen.has(value);) {
    seen.add(value);
    if (isNewExpression(value)) {
      return MADE_CLASSES.has(globalPath(unwrapped(value.expression))?.join('.') ?? '');
    }
    if (!isCallExpression(value)) {
      return false;
    }
    const callee = unwrapped(value.expression);
    const path = globalPath(callee);
    if (path !== undefined) {
      return MAKING_RESPONSES.has(path.join('.'));
    }
    if (!isPropertyAccessExpression(callee) || !COPYING.has(callee.name.text)) {
      return false;
    }
    value = reach(callee.expression);
  }
  return false;
}

/**
 * Whether `value`, what a method is called on as the code writes it, is an object the code writes
 * that holds an entry of its own named `name`, a method of its own that answers as its code does:
 * `helper.values()` of `const helper = { values() { … } }`, not what an array's `values` answers;
 * none of one that inherits it, `__lookupGetter__`.
 */
export function ownsMethod(
  value: Expression,
  name: string,
  reach: (node: Expression) => Expression,
): boolean {
  if (ownsAccessorDefinition(value, name)) {
    return true;
  }
  return (
    isObjectLiteralExpression(value) &&
    value.properties.some((property) => {
      const key = isSpreadAssignment(property) ? undefined : property.name;
      if (key === undefined) {
        return false;
      }
      const named = isComputedPropertyName(key) ? reach(key.expression) : key;
      return (isIdentifier(key) ? key.text : literalKey(named)) === name;
    })
  );
}

/**
 * Whether `receiver`, as the code writes it, is of one of `VOIDING_CLASSES`: made there,
 * `new URLSearchParams()`, or a URL's own, `url.searchParams`.
 */
export function isVoidingReceiver(receiver: Expression): boolean {
  const value = unwrapped(receiver);
  if (isNewExpression(value)) {
    return VOIDING_CLASSES.has(globalPath(unwrapped(value.expression))?.join('.') ?? '');
  }
  return isPropertyAccessExpression(value) && value.name.text === 'searchParams';
}

/**
 * The name of the method `callee` reads — by its name, by text in brackets, or by a well-known symbol,
 * `Symbol.iterator` of `items[Symbol.iterator]` — none of what reads no member, or by a key the code
 * computes otherwise.
 */
function methodName(callee: Expression): string | undefined {
  if (isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  if (!isElementAccessExpression(callee)) {
    return undefined;
  }
  const key = unwrapped(callee.argumentExpression);
  const symbol = globalPath(key)?.join('.');
  return literalKey(key) ?? (symbol?.startsWith('Symbol.') === true ? symbol : undefined);
}

/** Whether `node`, a member a call reads, stands in an optional chain: `items?.at(0)`, `a?.b.at(0)`. */
function isOptional(node: Expression): boolean {
  let each = node;
  while (
    isPropertyAccessExpression(each) ||
    isElementAccessExpression(each) ||
    isCallExpression(each) ||
    isNonNullExpression(each)
  ) {
    if (!isNonNullExpression(each) && each.questionDotToken !== undefined) {
      return true;
    }
    each = each.expression;
  }
  return false;
}

/**
 * What of what a call is called on its answer holds the elements of (`Holding.target`): of a first
 * value given to `reduce`, none — it answers what its function answers, never an element as it is,
 * `new Uint8Array([1, 2]).reduce(() => 1, 0)` — nor of `fill` at every index of an array the code
 * writes there, `Array(3).fill(0)`, which holds what it puts there alone (`Holding.filling`).
 */
function elementsOf(
  holding: Holding,
  target: Expression | undefined,
  emptyThrows: boolean,
  call: CallExpression,
): Expression | undefined {
  if (
    holding.target !== true ||
    (target !== undefined && holding.filling === true && isWrittenArray(target) && fillsWhole(call))
  ) {
    return undefined;
  }
  return emptyThrows || holding.initial === undefined ? target : undefined;
}

/**
 * Whether `call`, of `fill`, puts the value it is given at every index of what it is called on: of
 * the value alone, or from `0` written, to no end given — `fill(0)`, `fill(0, 0)`.
 */
export function fillsWhole(call: CallExpression): boolean {
  const given = call.arguments;
  if (given.length === 0 || given.length > 2 || given.some((each) => isSpreadElement(each))) {
    return false;
  }
  const start = given[1] === undefined ? undefined : unwrapped(given[1]);
  return start === undefined || (isNumericLiteral(start) && Number(start.text) === 0);
}

/** Whether `node` is an array the code writes there: of its elements, `[1, 2]`, or of `Array(…)`. */
function isWrittenArray(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isArrayLiteralExpression(value) ||
    (isCallExpression(value) && globalPath(unwrapped(value.expression))?.join('.') === 'Array')
  );
}

/** What `call` hands what `holding` says it holds: its target, its arguments, its functions. */
function handed(call: CallExpression, holding: Holding, target: Expression | undefined): Held {
  const given = call.arguments;
  const spread = given.findIndex((each) => isSpreadElement(each));
  // Past a spread, any argument may stand at any place.
  const at = (index: number): readonly Expression[] =>
    spread !== -1 && spread <= index ? given.slice(spread) : given.slice(index, index + 1);
  const values = (holding.values ?? []).flatMap((index) => at(index));
  if (holding.rest !== undefined) {
    values.push(...given.slice(spread === -1 ? holding.rest : Math.min(holding.rest, spread)));
  }
  const spreadOf = (each: Expression): Expression =>
    isSpreadElement(each) ? each.expression : each;
  const of = (holding.handing?.of ?? []).flatMap((each) => {
    if (each === 'target') {
      return target === undefined ? [] : [target];
    }
    return at(each);
  });
  const functions = (holding.functions ?? []).flatMap((index) => at(index));
  // What a spread hands stands as it is: it may hand an array-like at any place.
  const likes = (holding.likes ?? []).flatMap((index) => at(index));
  const emptyThrows =
    holding.initial !== undefined &&
    (given.length <= holding.initial || (spread !== -1 && spread <= holding.initial));
  return {
    entries: (holding.entries ?? []).flatMap((index) => at(index)).map((each) => spreadOf(each)),
    keys: (holding.keys ?? []).flatMap((index) => at(index)).map((each) => spreadOf(each)),
    functions: functions
      .filter((each) => !isSpreadElement(each))
      .map((fn) => {
        return {
          fn,
          likes,
          of: of.map((each) => spreadOf(each)),
          parameters: holding.handing?.parameters ?? [],
        };
      }),
    bounded: holding.bounded === true,
    iterates: holding.iterating === true ? target : undefined,
    voidsOn: holding.voids === true ? target : undefined,
    madeOf: holding.made === true ? target : undefined,
    emptyThrows,
    keepsHoles: holding.holes === true ? target : undefined,
    likes,
    nonJson: false,
    nothing: holding.nothing === true,
    // What a spread hands stands as it is: it may hand a pattern at any place.
    patterns: (holding.patterns ?? []).flatMap((index) => {
      if (index === 'target') {
        return target === undefined ? [] : [target];
      }
      return at(index);
    }),
    target: elementsOf(holding, target, emptyThrows, call),
    values: values.map((each) => spreadOf(each)),
  };
}
