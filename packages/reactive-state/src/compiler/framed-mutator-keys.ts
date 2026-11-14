import {
  type Expression,
  isCallExpression,
  isComputedPropertyName,
  isOmittedExpression,
  type PropertyName,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { heldValue } from './framed-held-member-writes.ts';
import { framedKeyNames } from './framed-keys.ts';

/** The keys of the fields a native object mutator writes, and whether one may name an element. */

/** The greatest array index: a larger integer names an ordinary property, no element. */
const ARRAY_INDEX = { last: 4_294_967_294 } as const;

/** Whether a written key may name the slot: its constants and branches decide, an opaque one may. */
export function keyMayBeSlot(key: Expression, index: number | undefined): boolean {
  if (isOmittedExpression(key) || isSymbolKey(key)) return false;
  const names = framedKeyNames(key);
  return (
    names === undefined || names.length === 0 || names.some((each) => possibleKey(each, index))
  );
}

/** The symbols the language gives: the names `Symbol.iterator` and the others read. */
const WELL_KNOWN_SYMBOLS: ReadonlySet<string> = new Set([
  'asyncDispose',
  'asyncIterator',
  'dispose',
  'hasInstance',
  'isConcatSpreadable',
  'iterator',
  'match',
  'matchAll',
  'replace',
  'search',
  'species',
  'split',
  'toPrimitive',
  'toStringTag',
  'unscopables',
]);

/**
 * Whether a key is a symbol the program writes: a well-known one, `Symbol.iterator`, or one made
 * by `Symbol(...)` or `Symbol.for(...)`, through a constant that holds it. A symbol names no index;
 * other members of Symbol, `Symbol.length`, `Symbol.keyFor(...)`, read numbers and strings.
 */
export function isSymbolKey(key: Expression): boolean {
  const value = heldValue(key);
  if (isCallExpression(value)) {
    const made = globalPathOf(unwrapped(value.expression))?.join('.');
    return made === 'Symbol' || made === 'Symbol.for';
  }
  const path = globalPathOf(value);
  return path?.length === 2 && path[0] === 'Symbol' && WELL_KNOWN_SYMBOLS.has(path[1] ?? '');
}

/** Whether an object field's name may name the slot, a computed one by what its key may be. */
export function nameMayBeSlot(name: PropertyName, index: number | undefined): boolean {
  return isComputedPropertyName(name)
    ? keyMayBeSlot(name.expression, index)
    : possibleKey(writtenArrayKey(name), index);
}

/** A key that may name the selected array slot: an unknown one, or a canonical index. */
export function possibleKey(key: string | number | undefined, index: number | undefined): boolean {
  if (key === undefined) return true;
  const text = String(key);
  if (!/^(?:0|[1-9]\d*)$/u.test(text) || Number(text) > ARRAY_INDEX.last) return false;
  return index === undefined || Number(text) === index;
}

/** The opaque numeric path a source's selected slot takes, the first for an unknown one. */
export function slotKey(index: number | undefined): string {
  return index === undefined ? '0' : String(index);
}
