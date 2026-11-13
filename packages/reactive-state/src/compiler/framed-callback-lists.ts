import {
  type CallExpression,
  type FunctionLikeDeclaration,
  isArrowFunction,
  isFunctionExpression,
  isIdentifier,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/** The places a callback's parameters hand the list at: the third, and the fourth of a reduction. */
const PLACE = { third: 3, fourth: 4 } as const;

/**
 * The native methods that call a function they are given with the list they were called on, and
 * the place the list takes among the parameters of that function: the third, the fourth for a
 * reduction.
 */
const LIST_PARAMETER: ReadonlyMap<string, number> = new Map([
  ['every', PLACE.third],
  ['filter', PLACE.third],
  ['find', PLACE.third],
  ['findIndex', PLACE.third],
  ['findLast', PLACE.third],
  ['findLastIndex', PLACE.third],
  ['flatMap', PLACE.third],
  ['forEach', PLACE.third],
  ['map', PLACE.third],
  ['reduce', PLACE.fourth],
  ['reduceRight', PLACE.fourth],
  ['some', PLACE.third],
]);

/**
 * Whether a call of a native method that takes a callback may hand the list it is called on to
 * the callback: a callback that is not written out, or that takes the parameter the list is given
 * as (or a rest of them, or reads `arguments`), can change the list or let it go.
 */
export function callbackTakesList(method: string, call: CallExpression): boolean {
  const place = LIST_PARAMETER.get(method);
  if (place === undefined) return false;
  const [first] = call.arguments;
  if (first === undefined) return false;
  if (isSpreadElement(first)) return true;
  const callback = unwrapped(first);
  if (!isArrowFunction(callback) && !isFunctionExpression(callback)) return true;
  return takes(callback, place);
}

/** Whether a function written out takes the parameter at the place, a rest, or reads `arguments`. */
function takes(callback: FunctionLikeDeclaration, place: number): boolean {
  if (
    callback.parameters.length >= place ||
    callback.parameters.some((each) => each.dotDotDotToken !== undefined)
  )
    return true;
  return !isArrowFunction(callback) && mentionsArguments(callback);
}

/** Whether a function reads the object of its own arguments. */
function mentionsArguments(callback: Node): boolean {
  const pending: Node[] = [callback];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isIdentifier(node) && node.text === 'arguments') return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
