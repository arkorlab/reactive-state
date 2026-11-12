import {
  type CallExpression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { patternAfter } from './destructuring-order.ts';
import { arrayIdentity, mayBeArray } from './framed-array-identity.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { ownMethodAssignment } from './framed-array-own-methods.ts';
import { frameMemberName, type FrameBinding } from './framed-bindings.ts';
import {
  isNamedFunction,
  madeInPlace,
  madeWithin,
  runsItself,
  runsItselfBetween,
} from './framed-recursion.ts';
import { jumpsOver, repeatedFrameRead, repeatingBodies, resumesWithin } from './framed-writes.ts';
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
 * of the array's elsewhere, or in a function that calls itself, may come again, and its arguments'
 * writes then come before it.
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
  const owner = executionOwner(call);
  return executionOwner(root) === owner && !reenteredRead(call, root, owner)
    ? { key: method, call, root }
    : undefined;
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
  return executionOwner(root) === owner && !mayRunAgain(node, read, root, owner);
}

/**
 * Whether a write of `node` may come before the read again within the run around it: a loop brings
 * it back, or a named function that calls itself runs the read once more after it. A function that
 * is called where it is written is read as part of the run around it, and each call of it is a run
 * of its own. Only the loops and functions inside `limit` are counted.
 */
export function mayRunAgain(node: Node, read: Node, root: FrameBinding, limit: Node): boolean {
  return repeatedFrameRead(node, read, root, limit) || reenteredRead(read, root, limit);
}

/**
 * Whether a write that a loop brings back to the read is followed, in the same pass, by a statement
 * that assigns the same method outright: one of a block around the write, after it, inside every
 * loop that brings the write back, that nothing may skip. No continue or break between them lands
 * past it, and no try statement within the loop goes on past it, after an exception or a finally's
 * jump. The next read finds what that statement wrote, and the write comes to nothing.
 */
export function overwrittenInPass(
  write: Node,
  key: string,
  read: Node,
  root: FrameBinding,
): boolean {
  const owner = executionOwner(read);
  if (reenteredRead(read, root, owner)) return false;
  const bodies = repeatingBodies(write, read, root, owner);
  if (
    bodies.length === 0 ||
    bodies.some((body) => !(write.pos >= body.pos && write.end <= body.end))
  )
    return false;
  const outermost = bodies.at(-1) ?? write;
  for (let at = write; !bodies.includes(at); at = at.parent) {
    const { parent } = at;
    if (!isBlock(parent)) continue;
    const later = parent.statements.find((each) => {
      return (
        each.pos >= at.end &&
        isExpressionStatement(each) &&
        ownMethodAssignment(each.expression, root)?.key === key &&
        bodies.every((body) => each.pos >= body.pos && each.end <= body.end) &&
        !jumpsOver(parent, write, each, outermost)
      );
    });
    if (later !== undefined && !resumesWithin(parent, bodies)) return true;
  }
  return false;
}

/**
 * Whether a function that holds the read, from the one `limit` is or holds out, runs itself again,
 * unless the array is made inside it and each run makes its own.
 */
function reenteredRead(read: Node, root: FrameBinding, limit: Node): boolean {
  return enclosingFunctions(read, root, limit).some((fn) => runsItself(fn));
}

/**
 * Whether a function that holds the read runs itself between the position `from`, where a proof was
 * made in it, and the end of the read, whose operands run before it reads: by its name, or through
 * a function that calls it, wherever that function is written, or while it waits. Another run of
 * it, there, writes what it writes after its own read.
 */
export function recursesBetween(
  read: Node,
  root: FrameBinding,
  limit: Node,
  from: number,
): boolean {
  return enclosingFunctions(read, root, limit).some(
    (fn) => runsItselfBetween(fn, from, read.pos) || runsItselfBetween(fn, read.pos + 1, read.end),
  );
}

/**
 * The functions that are called by a name and hold the read, up to `limit`, and not the array. A
 * `limit` that is a function run where it is written, as an immediate one that waits is, is one
 * run of the function around it: that function is counted, up to the first that is not run so.
 */
function enclosingFunctions(read: Node, root: FrameBinding, limit: Node): readonly Node[] {
  const found: Node[] = [];
  let past = false;
  for (let at = read.parent; ; at = at.parent) {
    if (isNamedFunction(at) && !madeWithin(root, at)) found.push(at);
    if (isSourceFile(at)) return found;
    if (at === limit) {
      if (!madeInPlace(at)) return found;
      past = true;
    } else if (past && isFunctionBoundary(at) && !madeInPlace(at)) return found;
  }
}

/** Whether a node holds a body that runs when it is called: a function, a constructor, a setter. */
function isFunctionBoundary(node: Node): boolean {
  return isAnswering(node) || isConstructorDeclaration(node) || isSetAccessorDeclaration(node);
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
      mayBeArray(member.expression, root);
    return !named || target.pos >= read.end;
  });
}
