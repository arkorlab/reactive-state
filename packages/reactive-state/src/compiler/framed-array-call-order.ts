import {
  type CallExpression,
  isCallExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { arrayIdentity } from './framed-array-own-methods.ts';
import { frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { repeatedFrameRead } from './framed-writes.ts';

/** The call that selects a method of the array before it evaluates its arguments. */
export interface SelectedMethod {
  readonly key: string;
  readonly call: CallExpression;
  readonly root: FrameBinding;
}

/**
 * A direct call of the method on the array selects it before its arguments run (ECMA-262, call
 * evaluation: the callee's value is taken first), where the array was made in the same run: a call
 * of the array's elsewhere may come again, and its arguments' writes then come before it.
 */
export function selectedMethod(
  call: Node,
  method: string | undefined,
  root: FrameBinding,
): SelectedMethod | undefined {
  if (method === undefined || !isCallExpression(call)) return undefined;
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  if (frameMemberName(member) !== method || arrayIdentity(member.expression) !== root)
    return undefined;
  return executionOwner(root) === executionOwner(call) ? { key: method, call, root } : undefined;
}

/**
 * Whether a write of the selected method lies in the call's arguments and no loop around the call
 * brings it back before the next selection.
 */
export function writtenAfterSelection(node: Node, key: string, selected: SelectedMethod): boolean {
  if (key !== selected.key) return false;
  const { call, root } = selected;
  const within = call.arguments.some((each) => node.pos >= each.pos && node.end <= each.end);
  return within && !repeatedFrameRead(node, call, root, executionOwner(call));
}

/**
 * Whether a write holds the read among its own operands, which run before it writes: an
 * assignment's right side, a mutator's arguments, a loop's iterable before its head is written. A
 * loop's body comes after the head, and a write of another run, or one a loop around the read
 * brings back, comes before the read.
 */
export function writtenAfterRead(node: Node, read: Node, root: FrameBinding): boolean {
  if (node === read || node.pos > read.pos || node.end < read.end) return false;
  if (
    (isForOfStatement(node) || isForInStatement(node)) &&
    (read.pos < node.expression.pos || read.end > node.expression.end)
  )
    return false;
  const owner = executionOwner(read);
  return executionOwner(root) === owner && !repeatedFrameRead(node, read, root, owner);
}
