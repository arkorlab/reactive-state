import {
  type CallExpression,
  type Expression,
  isArrowFunction,
  isFunctionExpression,
  isSpreadElement,
} from 'typescript/ast';

import { returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';

/** What an array method called in a tag's body answers of the Date-bearing substitutions it is given. */

/** Array methods that answer an element, or an array of elements, of their receiver. */
export const PASSTHROUGH_ARRAY_METHODS: ReadonlySet<string> = new Set([
  'copyWithin',
  'fill',
  'filter',
  'find',
  'findLast',
  'flat',
  'pop',
  'reverse',
  'shift',
  'sort',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'values',
  'with',
]);

/** Whether an expression carries a Date, asked of a fresh path (`fresh`) or the one in hand (`shared`). */
export interface DatedQuery {
  readonly shared: (expression: Expression) => boolean;
  readonly fresh: (expression: Expression) => boolean;
}

/**
 * `reduce` answers its initial value, or what its callback returns; with no initial value, the one
 * element of a one-element array, which no callback is called on. A callback that is not written
 * there is taken to return the element.
 */
export function reduceResultCarriesDated(
  call: CallExpression,
  receiver: Expression,
  carries: DatedQuery,
): boolean {
  const [callback, initial] = call.arguments;
  if (
    initial !== undefined &&
    carries.shared(isSpreadElement(initial) ? initial.expression : initial)
  )
    return true;
  if (!carries.fresh(receiver)) return false;
  const fn = callback === undefined ? undefined : unwrapped(callback);
  if (
    initial === undefined ||
    fn === undefined ||
    !(isArrowFunction(fn) || isFunctionExpression(fn))
  )
    return true;
  return returnedBy(fn).some((returned) => carries.shared(returned));
}
