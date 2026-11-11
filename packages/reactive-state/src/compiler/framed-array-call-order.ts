import {
  type CallExpression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { patternAfter } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { arrayIdentity } from './framed-array-own-methods.ts';
import { frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { repeatedFrameRead } from './framed-writes.ts';
import { framedWrittenTargets } from './framed-written-targets.ts';

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
 * brings back, comes before the read. A destructuring pattern writes its targets in order, so a
 * read in a later target, default or computed key follows the writes of the array's members before
 * it.
 */
export function writtenAfterRead(node: Node, read: Node, root: FrameBinding): boolean {
  if (node === read || node.pos > read.pos || node.end < read.end) return false;
  if (
    (isForOfStatement(node) || isForInStatement(node)) &&
    (read.pos < node.expression.pos || read.end > node.expression.end)
  )
    return false;
  if (!patternReadsFirst(node, read, root)) return false;
  const owner = executionOwner(read);
  return executionOwner(root) === owner && !repeatedFrameRead(node, read, root, owner);
}

/**
 * Whether the read of a destructuring assignment comes before the writes the pattern makes to the
 * array: in what it destructures, or before the first of its members that the array's.
 */
function patternReadsFirst(node: Node, read: Node, root: FrameBinding): boolean {
  if (
    !isBinaryExpression(node) ||
    node.operatorToken.kind !== SyntaxKind.EqualsToken ||
    (!isArrayLiteralExpression(node.left) && !isObjectLiteralExpression(node.left)) ||
    patternAfter(node.left, read)
  )
    return true;
  return framedWrittenTargets(node).every((target) => {
    const member = unwrapped(target);
    const named =
      (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
      arrayIdentity(member.expression) === root;
    return !named || target.pos >= read.end;
  });
}
