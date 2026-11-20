import {
  isCallExpression,
  isExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';

import { useOf } from './uses.ts';

/**
 * Whether a function written as an argument of a call is run by the call, where the call runs, as
 * the code around it is: the methods of an array that call the function they are given for each
 * element, `Array.from`'s mapping function, and the functions React's hooks call as a component
 * renders — the one that makes a memo, a state, a reducer's state. A function a call hands on, to
 * run later or elsewhere, is not: an effect, a callback, an event's handler, a promise's, a
 * subscription's. The calls are told by the names they go by, as the tree reads a method's name
 * elsewhere.
 */

/** The methods of an array that run their first argument as they are called. */
const ARRAY_METHODS: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'sort',
  'toSorted',
]);

/** The hooks that run one of their arguments as the component renders, by its place. */
const HOOKS: ReadonlyMap<string, number> = new Map([
  ['useMemo', 0],
  ['useReducer', 2],
  ['useState', 0],
]);

/** Whether `fn`, a function, is the argument of a call that runs it as it is made. */
export function runsAsGiven(fn: Node): boolean {
  const { at, parent: call } = useOf(fn);
  if (!isCallExpression(call)) {
    return false;
  }
  const { expression: callee } = call;
  const place = isExpression(at) ? call.arguments.indexOf(at) : -1;
  if (isIdentifier(callee)) {
    return HOOKS.get(callee.text) === place;
  }
  if (!isPropertyAccessExpression(callee) || !isIdentifier(callee.expression)) {
    return isPropertyAccessExpression(callee) && ARRAY_METHODS.has(callee.name.text) && place === 0;
  }
  const { name, expression: owner } = callee;
  if (owner.text === 'Array') {
    return name.text === 'from' && place === 1;
  }
  return (
    (ARRAY_METHODS.has(name.text) && place === 0) ||
    (owner.text === 'React' && HOOKS.get(name.text) === place)
  );
}
