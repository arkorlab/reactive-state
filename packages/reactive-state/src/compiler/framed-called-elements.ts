import {
  type CallExpression,
  type Expression,
  isElementAccessExpression,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import {
  elementSources,
  literalArrayBinding,
  positionsMove,
  type WrittenArrayElement,
} from './framed-array-elements.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { borrowedArrayMutation } from './framed-array-mutators.ts';
import { frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { mutatorInvocation } from './framed-mutator-calls.ts';

/** What one call does to the elements of a written literal array, wherever the call stands. */
export interface CalledElements {
  /** Whether the call is one whose writes into the array are followed, or reads it. */
  readonly tracked: boolean;
  /** Whether the call may move elements between positions, which leaves no slot as written. */
  readonly moves: boolean;
  /** The values a native mutator or an array method may leave at the index. */
  readonly elements: readonly WrittenArrayElement[];
}

/** The elements a native object mutator or an array insertion call writes into one literal array. */
export function calledArrayElements(
  node: CallExpression,
  value: Expression,
  index: number,
): CalledElements {
  const root = literalArrayBinding(value);
  if (root === undefined) return { tracked: false, moves: false, elements: [] };
  return {
    tracked: trackedCall(node, root),
    moves: positionsMove(node, root),
    elements: elementSources(node, root, index),
  };
}

/** A native object mutator, a borrowed array method on the array itself, or an insertion on it. */
function trackedCall(node: CallExpression, root: FrameBinding): boolean {
  if (mutatorInvocation(node) !== undefined) return true;
  const borrowed = borrowedArrayMutation(node);
  if (borrowed !== undefined) return literalArrayBinding(borrowed.receiver) === root;
  const member = unwrapped(node.expression);
  return (
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    literalArrayBinding(member.expression) === root &&
    !sourceArrayFunction(member) &&
    ['fill', 'push', 'splice', 'unshift'].includes(frameMemberName(member) ?? '')
  );
}

/** Whether the call is one a native object mutator or an array method makes on a written array. */
export function isTrackedCall(node: CallExpression, value: Expression): boolean {
  const root = literalArrayBinding(value);
  return root !== undefined && trackedCall(node, root);
}
