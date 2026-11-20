import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type SpreadAssignment,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import { BUILT_INS } from './built-ins.ts';
import { literalKey, memberPath } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import {
  ANSWERING,
  answersElement,
  isChangedName,
  type JsonReading,
  reached,
} from './json-reading.ts';
import { isListingMethod, isNativeConstant, quietListingRead } from './native-member-values.ts';

/**
 * What a member read holds of the objects and the arrays the code writes, as the checks of what no
 * JSON holds read it (`json-values.ts`): what writes the entry it reads, through the code's
 * constants and what they spread — `box.run` of `const box = { run: () => … }`, and
 * `Reflect.get(box, 'run')` — a function an array has, or every object inherits, and nothing where
 * none writes it; of text, a number, a boolean, a pattern the code writes, and of the language's
 * own globals, a method — `'x'.trim`, `Math.max` — but `length`, an element, a finite constant,
 * `Math.PI`; of what the code does not write — a prop, what a call answers — what its type
 * says, as ever, but what every object inherits, `first.toString`.
 */

/**
 * What a member read may hold: what writes it, read where it is written (`written`); a function — a
 * method, an array's, what every object inherits — or what an accessor computes (`computed`); or
 * nothing, `undefined` (`nothing`).
 */
export type Held =
  | { readonly kind: 'computed' }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'written'; readonly value: Expression; readonly at: JsonReading };

/** What a member read holds where it is written. */
type WrittenHeld = Extract<Held, { readonly kind: 'written' }>;

const COMPUTED: Held = { kind: 'computed' };
const NOTHING: Held = { kind: 'nothing' };

/**
 * The names every object inherits of `Object.prototype` — functions, and the prototype itself —
 * which no value of JSON holds an entry of its own by.
 */
const INHERITED: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/** The deepest spreads `writtenIn` reads into: past them, what is spread is read as untold. */
const MAX_SPREADS = 16;

/** What of an object the code writes `writtenIn` finds at a key. */
interface Written {
  readonly held: readonly Held[];
  /** Whether a property writes the key last, by a name the compile reads. */
  readonly settled: boolean;
  /** Whether what the code does not write is spread there, which may write it, as JSON of its type. */
  readonly untold: boolean;
}

/** A property an object is written with, but a spread. */
type Property = Exclude<ObjectLiteralElementLike, SpreadAssignment>;

/**
 * What `node` may hold, where it reads a member by keys the compile reads, in turn — `box.run`,
 * `rows[0].id` — as `heldAt` reads them; none of anything else.
 */
export function memberHeld(node: Expression, reading: JsonReading): readonly Held[] {
  // A member of the language's globals, read through `globalThis` too.
  const global = builtInHeld(globalPath(unwrapped(node)));
  if (global !== undefined) {
    return global;
  }
  const { keys, root } = memberPath(node);
  return keys.length === 0 ? [] : heldAt(root, keys, reading);
}

/**
 * What the member `path` of one of the language's globals holds (`BUILT_INS`): nothing of no JSON,
 * of a finite constant (`CONSTANTS`); a function, a prototype or a symbol (`computed`) of any other;
 * none told of what reads no such member.
 */
function builtInHeld(
  path: readonly string[] | undefined,
  continuing = false,
): readonly Held[] | undefined {
  const parts = path ?? [];
  const [global, member] = parts;
  if (global === undefined || member === undefined || !BUILT_INS.has(global)) {
    return undefined;
  }
  return !continuing && isNativeConstant(parts) ? [] : [COMPUTED];
}

/**
 * What reading `keys` in turn of `root` may hold (`Held`): of an object the code writes, what its
 * properties write; of an array, its element, `length`, or a method of arrays; of what the code does
 * not write, what every object inherits alone (`INHERITED`). A member of nothing throws, of no JSON.
 * Nothing is told of an entry what a constant holds lacks: the code may have written it since,
 * `items.push(…)`; of an object or an array written where it is read, what it lacks is nothing.
 */
function heldAt(root: Expression, keys: readonly string[], reading: JsonReading): readonly Held[] {
  const followed = reading.followed?.size ?? 0;
  let held: readonly Held[] = [{ at: reading, kind: 'written', value: root }];
  for (const [index, key] of keys.entries()) {
    held = held.flatMap((each): readonly Held[] => {
      if (each.kind === 'written') {
        return entryHeld(each, key, followed, index + 1 < keys.length);
      }
      return each.kind === 'nothing' ? [] : [COMPUTED];
    });
  }
  return held;
}

/**
 * What `held`, where it is written, holds at `key` (`heldAt`): nothing of an entry it lacks but
 * where it is written there, of no constant followed past the `followed` names the read began with;
 * anything of a constant the code changes since it declares it (`JsonReading.isChanged`); of either
 * answer of a condition, or operand of `&&`, `||`, `??`, what each holds; and, at an index, an
 * element of what a call computes, which it may lack (`answersElement`).
 */
function entryHeld(
  held: WrittenHeld,
  key: string,
  followed: number,
  continuing = false,
): readonly Held[] {
  const { at, value } = reached(held.value, held.at);
  if (isChangedName(value, at)) {
    return [COMPUTED];
  }
  const either = eitherOf(value);
  if (either !== undefined) {
    return either.flatMap((each) =>
      entryHeld({ at, kind: 'written', value: each }, key, followed, continuing),
    );
  }
  const computed = computedHeld(value, key, at);
  if (computed !== undefined) {
    return computed;
  }
  const inPlace = (at.followed?.size ?? 0) === followed;
  if (isArrayLiteralExpression(value)) {
    return elementHeld(value, key, at, inPlace);
  }
  const path = globalPath(value);
  const global = builtInHeld(path === undefined ? undefined : [...path, key], continuing);
  if (global !== undefined) {
    return global;
  }
  const nested = memberPath(value);
  const namespace = globalPath(reached(nested.root, at).value);
  if (namespace !== undefined && isNativeConstant([...namespace, ...nested.keys])) {
    return [COMPUTED];
  }
  if (!isObjectLiteralExpression(value)) {
    return primitiveHeld(value, key) ?? (INHERITED.has(key) ? [COMPUTED] : []);
  }
  const written = writtenIn(value, key, at, 0);
  if (written.settled) {
    return written.held;
  }
  if (INHERITED.has(key)) {
    return [...written.held, COMPUTED];
  }
  return !inPlace || written.untold ? written.held : [...written.held, NOTHING];
}

/**
 * What an element of what a call or a `new` computes, at the index `key`, may hold: what the answer
 * holds — and nothing, but where the code shows the answer holds it (`answersElement`); and an entry
 * of what a global's function answers, of a name (`globalEntryHeld`); none told of another key, or
 * of what else `value` is.
 */
function computedHeld(
  value: Expression,
  key: string,
  at: JsonReading,
): readonly Held[] | undefined {
  if (!(isCallExpression(value) || isNewExpression(value))) {
    return undefined;
  }
  if (!isIndex(key)) {
    return isCallExpression(value) ? globalEntryHeld(value, key, at) : undefined;
  }
  const answer: Held = { at, kind: 'written', value };
  return isCallExpression(value) && answersElement(value, Number(key))
    ? [answer]
    : [NOTHING, answer];
}

/** The globals whose functions answer an array or text, of a `length` as long as it is. */
const LISTING_GLOBALS: ReadonlySet<string> = new Set([
  'Array',
  'Array.from',
  'Array.of',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'Object.entries',
  'Object.getOwnPropertyNames',
  'Object.keys',
  'Object.values',
  'Reflect.ownKeys',
  'String',
]);

/** The globals whose functions answer what they are given first, or a copy of it: its entries. */
const KEEPING_GLOBALS: ReadonlySet<string> = new Set([
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'structuredClone',
]);

/**
 * What an entry, of the name `key`, of what `call`, of a global's function, answers may hold: a
 * function of what every object inherits; a number, of the `length` of an array or text it answers
 * (`LISTING_GLOBALS`); of what it is given first, as it is or a copy (`KEEPING_GLOBALS`), its entry;
 * and of anything else — `Object.create(null)`, `Object.fromEntries(…)` — what the answer holds, and
 * nothing, which it may hold no entry of. None told of a call of no global's.
 */
function globalEntryHeld(
  call: CallExpression,
  key: string,
  at: JsonReading,
): readonly Held[] | undefined {
  const called = globalPath(unwrapped(call.expression))?.join('.');
  if (called === undefined) {
    return undefined;
  }
  if (INHERITED.has(key)) {
    return [COMPUTED];
  }
  if (key === 'length' && LISTING_GLOBALS.has(called)) {
    return [];
  }
  if (LISTING_GLOBALS.has(called) && isListingMethod(called, key) && quietListingRead(call)) {
    return [COMPUTED];
  }
  const [first] = call.arguments;
  if (first !== undefined && KEEPING_GLOBALS.has(called) && !isSpreadElement(first)) {
    return heldAt(first, [key], at);
  }
  return [NOTHING, { at, kind: 'written', value: call }];
}

/** What a condition may answer, or an operand of `&&`, `||`, `??`: what it stands for, of either. */
function eitherOf(node: Expression): readonly Expression[] | undefined {
  if (isConditionalExpression(node)) {
    return [node.whenTrue, node.whenFalse];
  }
  return isBinaryExpression(node) && ANSWERING.has(node.operatorToken.kind)
    ? [node.left, node.right]
    : undefined;
}

/** Whether reaching `inner` from `outer` followed a constant, which the code may have changed since. */
function followsConstant(inner: JsonReading, outer: JsonReading): boolean {
  return (inner.followed?.size ?? 0) > (outer.followed?.size ?? 0);
}

/**
 * Whether `property` writes the prototype of the object it is written in — `__proto__: base` — of
 * which the object inherits what it holds no entry of its own of; a key computed of the text, or a
 * name written alone, writes an entry of that name.
 */
export function isPrototypeEntry(property: PropertyAssignment): boolean {
  const { name } = property;
  return (isIdentifier(name) || isStringLiteral(name)) && name.text === '__proto__';
}

/**
 * What `object` writes at `key` (`Written`), of its properties, last first: a value, or a method's
 * or an accessor's (`computed`); past a key the code computes of what the compile cannot read, what
 * it writes and what each before it does; past a spread, what what it spreads writes; and, of none
 * of its own, what the prototype it is written of holds (`__proto__:`).
 */
function writtenIn(
  object: ObjectLiteralExpression,
  key: string,
  at: JsonReading,
  depth: number,
): Written {
  const held: Held[] = [];
  let untold = false;
  let prototype: Expression | undefined;
  for (const property of object.properties.toReversed()) {
    if (key !== '__proto__' && isPropertyAssignment(property) && isPrototypeEntry(property)) {
      prototype = property.initializer;
      continue;
    }
    if (isSpreadAssignment(property)) {
      const spread = spreadWritten(property.expression, key, at, depth + 1);
      held.push(...spread.held);
      untold ||= spread.untold;
      if (spread.settled) {
        return { held, settled: true, untold };
      }
      continue;
    }
    const name = nameOf(property, at);
    if (name === undefined || name === key) {
      held.push(propertyHeld(property, at));
    }
    if (name === key) {
      return { held, settled: true, untold };
    }
  }
  return prototype === undefined
    ? { held, settled: false, untold }
    : inheritedFrom(prototype, { at, depth, held, key, untold });
}

/**
 * What an object holds at `key` of the prototype `prototype` it is written of, where it holds no
 * entry of its own of it: what an object the code writes holds there, through its own prototype;
 * nothing of `null`; and, of anything else — an array, what the code does not write — anything
 * (`computed`).
 */
function inheritedFrom(
  prototype: Expression,
  {
    at,
    depth,
    held,
    key,
    untold,
  }: {
    readonly at: JsonReading;
    readonly depth: number;
    readonly held: readonly Held[];
    readonly key: string;
    readonly untold: boolean;
  },
): Written {
  const { at: inner, value } = reached(prototype, at);
  if (value.kind === SyntaxKind.NullKeyword) {
    return { held, settled: false, untold };
  }
  if (depth >= MAX_SPREADS || !isObjectLiteralExpression(value)) {
    return { held: [...held, COMPUTED], settled: true, untold };
  }
  const inherited = writtenIn(value, key, inner, depth + 1);
  return {
    held: [...held, ...inherited.held],
    settled: inherited.settled,
    untold: untold || inherited.untold || followsConstant(inner, at),
  };
}

/**
 * What a spread of `expression` writes at `key` (`Written`): of an object the code writes, what it
 * writes; of an array, any element at an index; of `null` or `undefined`, nothing; of a constant
 * the code changes since it declares it, anything; of anything else, which may write it, nothing
 * the compile tells.
 */
function spreadWritten(
  expression: Expression,
  key: string,
  at: JsonReading,
  depth: number,
): Written {
  const { at: inner, value } = reached(expression, at);
  if (isChangedName(value, inner)) {
    return { held: [COMPUTED], settled: false, untold: true };
  }
  if (depth <= MAX_SPREADS && isObjectLiteralExpression(value)) {
    const written = writtenIn(value, key, inner, depth);
    return followsConstant(inner, at) ? { ...written, untold: true } : written;
  }
  if (isArrayLiteralExpression(value)) {
    return {
      held: isIndex(key) ? [{ at: inner, kind: 'written', value }] : [],
      settled: false,
      untold: true,
    };
  }
  const isNothing =
    value.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(value) && globalOf(value) === 'undefined');
  return { held: [], settled: false, untold: !isNothing };
}

/**
 * The key `property` is written by: its name, text or a number, or what a key the code computes
 * holds of one, through the code's constants; none the compile cannot read.
 */
function nameOf(property: Property, at: JsonReading): string | undefined {
  const { name } = property;
  if (isIdentifier(name)) {
    return name.text;
  }
  return literalKey(isComputedPropertyName(name) ? reached(name.expression, at).value : name);
}

/** What `property` writes: its value, or a method's or an accessor's (`computed`). */
function propertyHeld(property: Property, at: JsonReading): Held {
  if (isPropertyAssignment(property)) {
    return { at, kind: 'written', value: property.initializer };
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? { at, kind: 'written', value: property.name }
    : COMPUTED;
}

/**
 * What the array `array` holds at `key`: its element, nothing at a hole or past its end — where it
 * is written `inPlace` — its `length`, a number; past a spread, any element; any other key, a
 * method of arrays.
 */
function elementHeld(
  array: ArrayLiteralExpression,
  key: string,
  at: JsonReading,
  inPlace: boolean,
): readonly Held[] {
  if (key === 'length') {
    return [];
  }
  if (!isIndex(key)) {
    return [COMPUTED];
  }
  const index = Number(key);
  if (array.elements.slice(0, index + 1).some((each) => isSpreadElement(each))) {
    return [{ at, kind: 'written', value: array }];
  }
  const element = array.elements[index];
  if (element !== undefined && !isOmittedExpression(element)) {
    return [{ at, kind: 'written', value: element }];
  }
  return inPlace ? [NOTHING] : [];
}

/**
 * What a member of text, a number, a boolean or a pattern the code writes holds: of text, its
 * `length` and an element, a character — or nothing past its end — and a method of text of any
 * other key (`computed`), as of the rest; none told of anything else.
 */
function primitiveHeld(value: Expression, key: string): readonly Held[] | undefined {
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
    if (key === 'length') {
      return [];
    }
    if (isIndex(key)) {
      return Number(key) < value.text.length ? [] : [NOTHING];
    }
    return [COMPUTED];
  }
  if (isTemplateExpression(value)) {
    return key === 'length' || isIndex(key) ? [] : [COMPUTED];
  }
  return isPrimitiveLiteral(value) ? [COMPUTED] : undefined;
}

/** Whether `value` is a number, a `bigint`, a boolean or a pattern the code writes. */
function isPrimitiveLiteral(value: Expression): boolean {
  return (
    isNumericLiteral(value) ||
    isRegularExpressionLiteral(value) ||
    value.kind === SyntaxKind.BigIntLiteral ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword
  );
}

/**
 * Whether `Object.assign(…)` of what `call` gives it may make what it is given first an object of
 * another prototype: of what it copies, an entry of its own named `__proto__`, which it sets as the
 * target's setter of that name makes its prototype (`ownsPrototypeKey`).
 */
export function assignsPrototype(call: CallExpression, reading: JsonReading): boolean {
  return call.arguments.slice(1).some((each) => ownsPrototypeKey(each, reading));
}

/**
 * Whether `node` may hold an entry of its own named `__proto__`: of an object the code writes, a key
 * computed of that text or of what the compile cannot read, a name written alone, an accessor's,
 * or what it spreads may; of an array, text, a number, `null` or `undefined`, none; of anything else
 * — what the code does not write, what a spread hands — it may.
 */
function ownsPrototypeKey(node: Expression, reading: JsonReading): boolean {
  if (isSpreadElement(node)) {
    return true;
  }
  const { at, value } = reached(node, reading);
  if (isObjectLiteralExpression(value)) {
    return value.properties.some((property) => {
      if (isSpreadAssignment(property)) {
        return ownsPrototypeKey(property.expression, at);
      }
      // `__proto__:` writes the prototype of the object it is in, no entry of its own.
      if (isPropertyAssignment(property) && isPrototypeEntry(property)) {
        return false;
      }
      const name = nameOf(property, at);
      return name === undefined || name === '__proto__';
    });
  }
  const isNothing =
    value.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(value) && globalOf(value) === 'undefined');
  return (
    !isNothing &&
    !isArrayLiteralExpression(value) &&
    !isPrimitiveLiteral(value) &&
    primitiveHeld(value, 'length') === undefined
  );
}

/** Whether `key` is the index of an array's element, as the language writes one: `0`, `12`. */
function isIndex(key: string): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key;
}

/** Whether a value holds what no JSON holds where it stands, as `json-values.ts` reads it. */
export type Check = (node: Expression, reading: JsonReading) => boolean;

/**
 * Whether what a member read may hold (`Held`) holds what no JSON holds where the read stands, as
 * `check` reads a value: a function, what an accessor computes, nothing — but as an object's entry
 * — or what writes it, read where it is written.
 */
export function heldNonJson(held: readonly Held[], reading: JsonReading, check: Check): boolean {
  return held.some((each) => {
    if (each.kind === 'nothing') {
      return reading.entry !== true;
    }
    return each.kind === 'computed' || check(each.value, each.at);
  });
}

/**
 * Whether `Reflect.get(…)` of what `call` gives it may answer what no JSON holds (`heldNonJson`):
 * what its target holds at its key, as a member read of it does (`heldAt`), the key through the
 * code's constants; of a key the compile cannot read, or of what a spread hands, anything.
 */
export function getsNonJson(call: CallExpression, reading: JsonReading, check: Check): boolean {
  const [target, key] = call.arguments;
  if (
    target === undefined ||
    key === undefined ||
    isSpreadElement(target) ||
    isSpreadElement(key)
  ) {
    return true;
  }
  const name = literalKey(reached(key, reading).value);
  return name === undefined || heldNonJson(heldAt(target, [name], reading), reading, check);
}
