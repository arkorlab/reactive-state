import {
  type CallExpression,
  isArrowFunction,
  isFunctionExpression,
  isIdentifier,
  isTypeNode,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { nativePath } from './framed-mutator-calls.ts';

/** The place of the array among the parameters of a reducer: after the accumulator, the element and the index. */
const REDUCER_ARRAY = 3;

/** The methods that call back with the array itself, and the place of the parameter that is given it. */
const ARRAY_PARAMETER: ReadonlyMap<string, number> = new Map([
  ['every', 2],
  ['filter', 2],
  ['find', 2],
  ['findIndex', 2],
  ['findLast', 2],
  ['findLastIndex', 2],
  ['flatMap', 2],
  ['forEach', 2],
  ['map', 2],
  ['reduce', REDUCER_ARRAY],
  ['reduceRight', REDUCER_ARRAY],
  ['some', 2],
]);

/**
 * Whether a method calls a function back with the array as an argument: a function of the program
 * that has a parameter for it (a rest parameter or `arguments` among them), or any callback that is
 * not written out, which may be one.
 */
export function handsArray(call: CallExpression, name: string): boolean {
  const position = ARRAY_PARAMETER.get(name);
  const [first] = call.arguments;
  if (position === undefined || first === undefined) return false;
  const callback = unwrapped(first);
  if (!isArrowFunction(callback) && !isFunctionExpression(callback))
    return call.arguments.length > 1 || nativePath(first) === undefined;
  return (
    callback.parameters.length > position ||
    callback.parameters.some((each) => each.dotDotDotToken !== undefined) ||
    mentionsArguments(callback)
  );
}

/** Whether a function names `arguments` anywhere. */
function mentionsArguments(fn: Node): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && node.text === 'arguments') return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
