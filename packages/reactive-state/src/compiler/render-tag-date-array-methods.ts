import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrowFunction,
  isFunctionExpression,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { literalArrayBinding, writtenArrayElements } from './framed-array-elements.ts';
import { UnfollowableError } from './framed-getter-writes.ts';

/** What an array method called in a tag's body, or a write to an array, makes of the Date-bearing substitutions it is given. */

const REDUCE_ARRAY_METHODS: ReadonlySet<string> = new Set(['reduce', 'reduceRight']);

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
function reduceResultCarriesDated(
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

/** The methods whose answer is a copy of the receiver that holds an argument. */
const HOLDING_ARRAY_METHODS: ReadonlySet<string> = new Set(['fill', 'toSpliced', 'with']);

/**
 * What `reduce` answers, and what the methods that answer an element, or an array of elements, of
 * their receiver do: a Date the receiver carries, or the argument `fill`, `with` and `toSpliced`
 * put in. `carries` asks one expression.
 */
export function elementMethodCarriesDated(
  call: CallExpression,
  receiver: Expression,
  method: string,
  carries: (expression: Expression) => boolean,
): boolean {
  if (REDUCE_ARRAY_METHODS.has(method)) return reduceResultCarriesDated(call, receiver, carries);
  if (!PASSTHROUGH_ARRAY_METHODS.has(method)) return false;
  return (
    carries(receiver) ||
    (HOLDING_ARRAY_METHODS.has(method) &&
      call.arguments.some((argument) =>
        carries(isSpreadElement(argument) ? argument.expression : argument),
      ))
  );
}

/** What is written to an array a tag builds, found once for the array: a walk of the file each. */
const BUILT = new WeakMap<Node, readonly Expression[] | undefined>();

/**
 * Every value that may be written to the array a name stands for (`push`, `unshift`, `splice`,
 * `fill`, an index assignment), at any time: none where a name is not a literal array of the code,
 * and `undefined` where a native object mutator writes it, which is not followed. An array that is
 * handed to a call, or reassigned, keeps the writes the code shows.
 */
function builtArrayValues(name: Identifier): readonly Expression[] | undefined {
  const root = literalArrayBinding(name);
  if (root === undefined) return [];
  if (BUILT.has(root)) return BUILT.get(root);
  let values: readonly Expression[] | undefined;
  try {
    values = writtenArrayElements(name, name.getSourceFile().endOfFileToken).map((written) =>
      isSpreadElement(written.value) ? written.value.expression : written.value,
    );
  } catch (error) {
    if (!(error instanceof UnfollowableError)) throw error;
  }
  BUILT.set(root, values);
  return values;
}

/**
 * Whether an array a tag builds holds a Date: what its writes put in carries one, and a write by a
 * native object mutator, which is not followed, is taken to. The array is asked once, not at each mention of it.
 */
export function writtenArrayCarriesDated(
  name: Identifier,
  carries: (expression: Expression) => boolean,
): boolean {
  const values = builtArrayValues(name);
  return values === undefined || values.some((value) => carries(value));
}
