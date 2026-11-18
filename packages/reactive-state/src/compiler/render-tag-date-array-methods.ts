import {
  type ArrowFunction,
  type Expression,
  type FunctionExpression,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater, parametersOf, returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { literalArrayBinding, writtenArrayElements } from './framed-array-elements.ts';
import { frameMemberName } from './framed-bindings.ts';
import { UnfollowableError } from './framed-getter-writes.ts';

/** What an array method called in a tag's body, or a write to an array, makes of the Date-bearing substitutions it is given. */

/**
 * The array methods that call a callback with the elements of their receiver, which a tag's body
 * reads in place or by a name: the one list of them, for the callback's parameters and for what a
 * named callback writes as text. A method left out of it is taken whatever its callback writes.
 */
export const ELEMENT_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'some',
]);
/** The reductions, whose callback is handed an accumulator, an element, an index and the array. */
export const REDUCE_ARRAY_METHODS: ReadonlySet<string> = new Set(['reduce', 'reduceRight']);
/** The sorts, whose callback is a comparator handed two elements of the receiver. */
export const COMPARATOR_METHODS: ReadonlySet<string> = new Set(['sort', 'toSorted']);

/** What an array method is called with: its arguments, as a direct call, or one unpacked from `call`, `apply` or `Reflect.apply`, writes them. */
export interface CalledWith {
  readonly arguments: readonly Expression[];
}

/** The parameter an element callback (`map`, `filter`, ...) is handed the array in: after the element and the index. */
export const ELEMENT_CALLBACK_ARRAY_SLOT = 2;
/** The parameter a reduction's callback is handed the array in: after the accumulator, the element and the index. */
export const REDUCE_CALLBACK_ARRAY_SLOT = 3;

/**
 * Array methods that answer an element, an array of elements, or an iterator that yields them or
 * pairs that hold them (`entries`), of their receiver. A pair's index is a number, which the walk
 * does not tell from the element: it refuses the index written as text, where `values.map` does not.
 */
export const PASSTHROUGH_ARRAY_METHODS: ReadonlySet<string> = new Set([
  'copyWithin',
  'entries',
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

const ACCUMULATOR_WRITES: ReadonlySet<string> = new Set(['fill', 'push', 'splice', 'unshift']);

/** Whether `node` puts a value `carries` says holds a Date into the array named `name`: `out.push(value)`, `out[index] = value`. */
function writesCarrierInto(
  node: Node,
  name: string,
  carries: (expression: Expression) => boolean,
): boolean {
  if (isCallExpression(node)) {
    const callee = unwrapped(node.expression);
    if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
    const method = frameMemberName(callee);
    return (
      method !== undefined &&
      ACCUMULATOR_WRITES.has(method) &&
      namesArray(callee.expression, name) &&
      node.arguments.some((each) => carries(isSpreadElement(each) ? each.expression : each))
    );
  }
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken) return false;
  const target = unwrapped(node.left);
  return (
    isElementAccessExpression(target) && namesArray(target.expression, name) && carries(node.right)
  );
}

function namesArray(expression: Expression, name: string): boolean {
  const target = unwrapped(expression);
  return isIdentifier(target) && target.text === name;
}

/**
 * Whether a reduction's callback puts a Date into its accumulator, by name: the accumulator is a
 * parameter, whose writes `writtenArrayElements` does not follow, and the callback is the only
 * code that has it.
 */
function callbackKeepsCarrier(
  callback: ArrowFunction | FunctionExpression,
  carries: (expression: Expression) => boolean,
): boolean {
  const [accumulator] = parametersOf(callback);
  if (accumulator === undefined || !isIdentifier(accumulator.name)) return false;
  const pending: Node[] = [callback.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (writesCarrierInto(node, accumulator.name.text, carries)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * `reduce` answers its initial value, what its callback returns, or what the callback puts into its
 * accumulator; with no initial value (or a callback that is not written there), the one element of a one-element array, or what the callback
 * makes of its elements. The receiver is asked once, through the callback's element parameter or
 * here, never both: a chain of reductions stays one question per stage.
 */
function reduceResultCarriesDated(
  call: CalledWith,
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
    return (
      !answersLater(fn) &&
      (returnedBy(fn).some((returned) => carries(returned)) || callbackKeepsCarrier(fn, carries))
    );
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
  call: CalledWith,
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
