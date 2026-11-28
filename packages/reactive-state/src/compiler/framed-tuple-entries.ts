import { type Expression, isElementAccessExpression, isIdentifier } from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameBinding, frameBindingOf } from './framed-bindings.ts';
import { type Constant, constantValue } from './numbers.ts';

/** Which writes name an entry of the same lexical tuple or resolved constant alias. */

/** The arguments of the array methods that store a value in it, by the range of each that is stored. */
const STORING: ReadonlyMap<string, readonly [number, number]> = new Map([
  ['fill', [0, 1]],
  ['push', [0, Infinity]],
  ['splice', [2, Infinity]],
  ['unshift', [0, Infinity]],
]);

/** The range of arguments of an array method that it stores in the array, where it stores any. */
export function storedRange(method: string): readonly [number, number] | undefined {
  return STORING.get(method);
}

/** The last canonical index of an array: a larger number, or any other name, is no entry's. */
const ARRAY_INDEX = { last: 4_294_967_294 } as const;

/**
 * Whether a written index may name an entry of an array: one the compile cannot tell, or a canonical
 * one.
 */
function entryIndex(index: Constant | undefined): boolean {
  if (index === undefined) return true;
  const text = String(index);
  return /^(?:0|[1-9]\d*)$/u.test(text) && Number(text) <= ARRAY_INDEX.last;
}

/**
 * Only slot zero of the same lexical tuple or resolved constant alias supplies its receiver; any
 * entry of it, whatever index names it, may supply a value of it, and no property it is given under
 * another name (`sources['meta']`), which a spread of the array never yields.
 */
export function tupleEntry(
  target: Expression,
  aliases: ReadonlySet<FrameBinding>,
  entries: 'any' | 'first',
): boolean {
  const value = unwrapped(target);
  if (!isElementAccessExpression(value)) return false;
  const index = constantValue(value.argumentExpression);
  if (entries === 'first' ? index !== 0 && index !== '0' : !entryIndex(index)) return false;
  const holder = unwrapped(value.expression);
  const selected = isIdentifier(holder) ? frameBindingOf(holder) : undefined;
  return selected?.keys.length === 0 && aliases.has(selected.binding);
}
