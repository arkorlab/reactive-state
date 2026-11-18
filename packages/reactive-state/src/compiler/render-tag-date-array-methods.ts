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

/**
 * `reduce` answers its initial value, or what its callback returns; with no initial value (or a
 * callback that is not written there), the one element of a one-element array, or what the callback
 * makes of its elements. The receiver is asked once, through the callback's element parameter or
 * here, never both: a chain of reductions stays one question per stage.
 */
export function reduceResultCarriesDated(
  call: CallExpression,
  receiver: Expression,
  carries: (expression: Expression) => boolean,
): boolean {
  const [callback, initial] = call.arguments;
  if (initial !== undefined && carries(isSpreadElement(initial) ? initial.expression : initial)) {
    return true;
  }
  const fn = callback === undefined ? undefined : unwrapped(callback);
  if (
    initial !== undefined &&
    fn !== undefined &&
    (isArrowFunction(fn) || isFunctionExpression(fn))
  ) {
    return returnedBy(fn).some((returned) => carries(returned));
  }
  return carries(receiver);
}
