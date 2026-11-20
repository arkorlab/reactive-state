import {
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
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVoidExpression,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering, returnedBy } from './answers.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import {
  ANSWERING,
  followedOf,
  isChangedName,
  isFunctionValue,
  isMadeNonJson,
  type JsonReading,
  MAX_DEPTH,
  reached,
} from './json-reading.ts';
import { assignsPrototype, type Check, getsNonJson } from './member-reads.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { primitiveOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { throwsOfWritten } from './throws.ts';

/**
 * What the language's `JSON` answers of what the code writes, as the checks of what no JSON holds
 * read it (`json-values.ts`): `JSON.stringify`'s `undefined` — of nothing, of `undefined`, a
 * function or a symbol, as it stands or as its replacer returns it, and of an object whose `toJSON`,
 * which it calls in the object's place, may answer it — and what it throws of, an integer of
 * `BigInt`; and what `JSON.parse` makes of text the code writes that no JSON the authority holds
 * is: a number past those it holds, `JSON.parse('1e400')`. So too what `get` of a `Map` the code
 * makes answers, which it may hold no entry of.
 */

/** Whether a value read — a name, a member, a call — holds what no JSON holds (`json-values.ts`). */
export type Refers = (value: Expression, reading: JsonReading) => boolean;

/** The globals whose objects hold entries `get` answers, by key: `Map`, `WeakMap`. */
const MAPS: ReadonlySet<string> = new Set(['Map', 'WeakMap']);

/**
 * Whether a call the checks read apart answers what no JSON holds — of `JSON.stringify`, nothing
 * (`stringifiesNothing`); of `Reflect.get`, what its target holds at its key; of `JSON.parse`, what
 * it makes of text the code writes (`parsesNonJson`); of `Object.assign`, an object of another
 * prototype; of `Symbol.keyFor`, nothing, of a symbol of no key (`keysNothing`); of `get` of a
 * `Map` the code makes, nothing or what its entries hold (`getsFromMap`); of a function of the
 * language's, what it throws of what the code writes it is given (`throws.ts`) —
 * as `refers` reads a value, and `check` what it holds; none told of another call, or of one of
 * those that holds no JSON of the kind, which a call is read of as ever.
 */
export function knownCallNonJson(
  call: CallExpression,
  reading: JsonReading,
  { check, refers }: { readonly check: Check; readonly refers: Refers },
): boolean | undefined {
  const called = globalPath(unwrapped(call.expression))?.join('.');
  if (called === 'JSON.stringify') {
    return stringifiesNothing(call, reading, refers);
  }
  if (called === 'Reflect.get') {
    return getsNonJson(call, reading, check);
  }
  const isNonJson =
    (called === 'JSON.parse' && parsesNonJson(call, reading)) ||
    (called === 'Object.assign' && assignsPrototype(call, reading)) ||
    (called === 'Symbol.keyFor' && keysNothing(call, reading)) ||
    getsFromMap(call, reading, check) ||
    throwsOfWritten(call, followedOf(reading));
  return isNonJson ? true : undefined;
}

/**
 * Whether `Symbol.keyFor` of what `call` gives it may answer nothing, `undefined` — of a symbol of
 * no key in the registry, `Symbol()` — where no JSON holds it: but of one `Symbol.for(…)` makes,
 * there or through the code's constants, whose key it answers.
 */
function keysNothing(call: CallExpression, reading: JsonReading): boolean {
  const [symbol] = call.arguments;
  const value =
    symbol === undefined || isSpreadElement(symbol) ? undefined : reached(symbol, reading).value;
  const isRegistered =
    value !== undefined &&
    isCallExpression(value) &&
    globalPath(unwrapped(value.expression))?.join('.') === 'Symbol.for';
  return reading.entry !== true && !isRegistered;
}

/**
 * Whether `call`, a `get` of a `Map` or a `WeakMap` the code makes — `new Map(entries)` there or
 * through its constants, or `Map.groupBy(…)` — may answer what no JSON holds: nothing, of a key it
 * holds no entry of, but where the code shows it does — entries it writes there of the key the call
 * gives, `new Map([['a', 1]]).get('a')` — and what the entries it is made of hold; of one the code
 * changes since, anything.
 */
function getsFromMap(call: CallExpression, reading: JsonReading, check: Check): boolean {
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee) || callee.name.text !== 'get') {
    return false;
  }
  const { at, value } = reached(callee.expression, reading);
  if (isChangedName(value, at)) {
    return true;
  }
  const isMade = isNewExpression(value) && MAPS.has(globalOf(unwrapped(value.expression)) ?? '');
  const isGrouped =
    isCallExpression(value) && globalPath(unwrapped(value.expression))?.join('.') === 'Map.groupBy';
  if (!isMade && !isGrouped) {
    return false;
  }
  const [entries] = value.arguments ?? [];
  const holds = entries !== undefined && check(entries, { ...at, entry: false });
  const [key] = call.arguments;
  const isHeld = isMade && entries !== undefined && key !== undefined && holdsKey(entries, key, at);
  return holds || (reading.entry !== true && !isHeld);
}

/**
 * Whether `entries`, an array the code writes there of no spread, of pairs of a key it writes, holds
 * one of the key `key` the code writes — text as text, a number as a number, as a `Map` tells keys
 * apart.
 */
function holdsKey(entries: Expression, key: Expression, reading: JsonReading): boolean {
  const { at, value } = reached(entries, reading);
  const sought = keyOf(reached(key, reading).value);
  if (sought === undefined || !isArrayLiteralExpression(value)) {
    return false;
  }
  return value.elements.some((element) => {
    const pair = reached(element, at).value;
    const [first] = isArrayLiteralExpression(pair) ? pair.elements : [];
    return first !== undefined && keyOf(reached(first, at).value) === sought;
  });
}

/** A key a `Map` holds that `node` writes, told apart by its kind: text, a number; none of another. */
function keyOf(node: Expression): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return `text:${node.text}`;
  }
  return isNumericLiteral(node) ? `number:${String(Number(node.text))}` : undefined;
}

/**
 * Whether `JSON.stringify` of what `call` gives it may answer `undefined`, which no JSON holds, or
 * throw: of nothing, or of what it is given as it stands (`answersNothing`), or as the function it
 * is given, its replacer, returns in its place.
 */
function stringifiesNothing(call: CallExpression, reading: JsonReading, refers: Refers): boolean {
  const [value, replacer] = call.arguments;
  if (value === undefined || isSpreadElement(value)) {
    return true;
  }
  const given = replacer === undefined ? undefined : unwrapped(replacer);
  const isReplaced =
    given !== undefined &&
    isAnswering(given) &&
    returnedBy(given).some((each) => answersNothing(each, reading, refers));
  return isReplaced || answersNothing(value, reading, refers);
}

/**
 * Whether `node` may be what `JSON.stringify` writes nothing of, as it stands — either answer of a
 * condition, an operand of `&&`, `||`, `??` too: `undefined`, `void …`, a function, a symbol, what a
 * global makes that no JSON holds, a name, a member or a call that holds what no JSON holds; an
 * object whose `toJSON` may answer it (`definesToJson`), of a class of the application's too — or
 * what it throws of, an integer of `BigInt` anywhere in it (`holdsBigInt`). What stands on the left
 * of `??` and `||` answers nothing of `undefined`, which they answer their right in place of
 * (`replaced`).
 */
function answersNothing(
  node: Expression,
  reading: JsonReading,
  refers: Refers,
  replaced = false,
): boolean {
  const { at, value } = reached(node, reading);
  if (isConditionalExpression(value)) {
    return (
      answersNothing(value.whenTrue, at, refers, replaced) ||
      answersNothing(value.whenFalse, at, refers, replaced)
    );
  }
  if (isBinaryExpression(value) && ANSWERING.has(value.operatorToken.kind)) {
    const replaces = value.operatorToken.kind !== SyntaxKind.AmpersandAmpersandToken;
    return (
      answersNothing(value.left, at, refers, replaced || replaces) ||
      answersNothing(value.right, at, refers, replaced)
    );
  }
  if (isVoidExpression(value)) {
    return !replaced;
  }
  const boxed = stringifiesBox(value, at);
  if (boxed !== undefined) {
    return boxed;
  }
  if (isFunctionValue(value) || holdsBigInt(value, at)) {
    return true;
  }
  if (isObjectLiteralExpression(value)) {
    return definesToJson(value, at, refers);
  }
  // An object of a class of the language's writes what it holds; one of the application's may
  // define `toJSON`.
  if (isNewExpression(value)) {
    return globalOf(unwrapped(value.expression)) === undefined;
  }
  return (
    (isMadeNonJson(value) && !isRegularExpressionLiteral(value)) ||
    refers(value, { ...at, entry: replaced })
  );
}

/** A written primitive boxed by Object serializes, apart from a bigint that JSON cannot unbox. */
function stringifiesBox(node: Expression, reading: JsonReading): boolean | undefined {
  if (
    !(isCallExpression(node) || isNewExpression(node)) ||
    globalPath(unwrapped(node.expression))?.join('.') !== 'Object'
  ) {
    return undefined;
  }
  const [argument] = node.arguments ?? [];
  if (argument === undefined) {
    return false;
  }
  if (isSpreadElement(argument)) {
    return undefined;
  }
  const { at, value } = reached(argument, reading);
  const resolve = followedOf(at);
  if (isBigIntWritten(value, resolve)) {
    return true;
  }
  return primitiveOf(value, resolve) !== undefined || isSymbolWritten(value, resolve)
    ? false
    : undefined;
}

/**
 * Whether `object`, written there, may hold `toJSON`, which `JSON.stringify` calls in its place: an
 * entry of that name, or of a key the compile cannot read; or what it spreads — an object the code
 * writes, read so, or what holds what no JSON holds, which may be a function of that name.
 */
function definesToJson(
  object: ObjectLiteralExpression,
  reading: JsonReading,
  refers: Refers,
): boolean {
  return object.properties.some((property) => {
    if (isSpreadAssignment(property)) {
      const { at, value } = reached(property.expression, reading);
      return isObjectLiteralExpression(value)
        ? definesToJson(value, at, refers)
        : refers(value, { ...at, entry: false });
    }
    const { name } = property;
    if (isIdentifier(name)) {
      return name.text === 'toJSON';
    }
    const written = isComputedPropertyName(name) ? reached(name.expression, reading).value : name;
    const key = literalKey(written);
    return key === undefined || key === 'toJSON';
  });
}

/**
 * Whether `node`, read through the code's constants, holds an integer of `BigInt` — `1n`, `-1n`,
 * `BigInt(1)` — as it stands, or in an array or an object the code writes there, of which
 * `JSON.stringify` throws; a constant the code changes since it declares it may.
 */
function holdsBigInt(node: Expression, reading: JsonReading): boolean {
  let { at, value } = reached(node, reading);
  while (isPrefixUnaryExpression(value) && value.operator === SyntaxKind.MinusToken) {
    ({ at, value } = reached(value.operand, at));
  }
  if (value.kind === SyntaxKind.BigIntLiteral || isChangedName(value, at)) {
    return true;
  }
  if (isCallExpression(value)) {
    return globalPath(unwrapped(value.expression))?.[0] === 'BigInt';
  }
  if (isArrayLiteralExpression(value)) {
    return value.elements.some((element) => {
      return (
        !isOmittedExpression(element) &&
        holdsBigInt(isSpreadElement(element) ? element.expression : element, at)
      );
    });
  }
  if (!isObjectLiteralExpression(value)) {
    return false;
  }
  return value.properties.some((property) => {
    if (isPropertyAssignment(property)) {
      return holdsBigInt(property.initializer, at);
    }
    if (isShorthandPropertyAssignment(property)) {
      return isIdentifier(property.name) && holdsBigInt(property.name, at);
    }
    return isSpreadAssignment(property) && holdsBigInt(property.expression, at);
  });
}

/**
 * Whether `JSON.parse` of what `call` gives it — text the code writes, or a number, read through
 * the code's constants — makes what no JSON the authority holds is: a number past those it holds,
 * `JSON.parse('1e400')`; arrays and objects nested deeper than it holds, where the parse stands
 * `reading.depth` deep — or throws, of text of no JSON. Of text the code does not write, none it
 * tells: the authority refuses what is not JSON where it meets it.
 */
function parsesNonJson(call: CallExpression, reading: JsonReading): boolean {
  const [text] = call.arguments;
  if (text === undefined || isSpreadElement(text)) {
    return false;
  }
  const { value } = reached(text, reading);
  let written: string | undefined;
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
    written = value.text;
  } else if (isNumericLiteral(value)) {
    written = String(Number(value.text));
  }
  if (written === undefined) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(written);
  } catch {
    return true;
  }
  return parsedNonJson(parsed, reading.depth ?? 0);
}

/** Whether what `JSON.parse` made holds a number that is not finite, or nests past `MAX_DEPTH`. */
function parsedNonJson(value: unknown, depth: number): boolean {
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return depth >= MAX_DEPTH || Object.values(value).some((each) => parsedNonJson(each, depth + 1));
}
