import {
  type CallExpression,
  type FunctionExpression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isArrowFunction,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isTypeNode,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { patternAfter } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { arrayIdentity, mayBeArray, ownMethodAssignment } from './framed-array-own-methods.ts';
import { frameDeclarationOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import {
  jumpsOver,
  framedPossibleBranch,
  repeatedFrameRead,
  repeatingBodies,
  resumesWithin,
} from './framed-writes.ts';
import { framedWrittenTargets } from './framed-written-targets.ts';
import { readsBinding } from './scope.ts';

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
 * Whether a function inside `limit` that holds the read calls itself by its name, unless the array
 * is made inside it and each call makes its own.
 */
function reenteredRead(read: Node, root: FrameBinding, limit: Node): boolean {
  for (let at = read.parent; at !== limit; at = at.parent)
    if (
      isFunctionExpression(at) &&
      at.name !== undefined &&
      !(root.pos >= at.pos && root.end <= at.end) &&
      namesItself(at, at.name)
    )
      return true;
  return false;
}

/**
 * Whether a function inside `limit` that holds the read runs itself between the position `from`,
 * where a proof was made in it, and the read: by its name, or through a function it holds that
 * calls it, wherever that function is written. Another run of it, there, writes what it writes
 * after its own read.
 */
export function recursesBetween(
  read: Node,
  root: FrameBinding,
  limit: Node,
  from: number,
): boolean {
  for (let at = read.parent; at !== limit; at = at.parent)
    if (
      isFunctionExpression(at) &&
      at.name !== undefined &&
      !(root.pos >= at.pos && root.end <= at.end) &&
      runsItselfBetween(at, at.name, from, read.pos)
    )
      return true;
  return false;
}

/** Whether the function's code names itself, or a helper that does, between two positions. */
function runsItselfBetween(
  fn: FunctionExpression,
  name: Identifier,
  from: number,
  to: number,
): boolean {
  const names = recursiveNames(fn, name);
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (
      isIdentifier(node) &&
      names.has(node.text) &&
      node.pos >= from &&
      node.pos < to &&
      node.parent !== fn &&
      readsBinding(node) &&
      (node.text === name.text ? reachesName(node, fn) : runsWithin(node, fn))
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * The names by which the function runs itself: its own, and those of the functions it holds, a
 * declaration or a variable given one, whose code names one of them. A name that more than one
 * function of the function holds counts if any of them does.
 */
function recursiveNames(fn: FunctionExpression, name: Identifier): ReadonlySet<string> {
  const names = new Set([name.text]);
  const helpers = localHelpers(fn);
  for (let grew = true; grew;) {
    grew = false;
    for (const [helper, bodies] of helpers)
      if (!names.has(helper) && bodies.some((body) => mentionsAny(body, names))) {
        names.add(helper);
        grew = true;
      }
  }
  return names;
}

/** The functions a function holds, each name with the code of every function that has it. */
function localHelpers(fn: FunctionExpression): ReadonlyMap<string, readonly Node[]> {
  const helpers = new Map<string, Node[]>();
  const add = (name: string, body: Node): void => {
    helpers.set(name, [...(helpers.get(name) ?? []), body]);
  };
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (node !== fn && isFunctionDeclaration(node) && node.name !== undefined && node.body)
      add(node.name.text, node.body);
    else if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer) {
      const value = unwrapped(node.initializer);
      if (isArrowFunction(value) || isFunctionExpression(value)) add(node.name.text, value.body);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return helpers;
}

/** Whether the code reads one of the names. */
function mentionsAny(body: Node, names: ReadonlySet<string>): boolean {
  const pending: Node[] = [body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && names.has(node.text) && readsBinding(node)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether the function's code reads the name it is given, as the name of the function itself. */
function namesItself(fn: FunctionExpression, name: Identifier): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (
      isIdentifier(node) &&
      node.text === name.text &&
      node.parent !== fn &&
      readsBinding(node) &&
      reachesName(node, fn)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * Whether a name read inside the function resolves to the function's own name, and the read may
 * run: no parameter, no local, and no function or class within it that is named alike takes the
 * name first, and no arm a written condition rules out holds the read or a function that holds it.
 */
function reachesName(name: Identifier, fn: FunctionExpression): boolean {
  if (frameDeclarationOf(name) !== undefined) return false;
  for (let at = name.parent; at !== fn; at = at.parent)
    if ((isFunctionExpression(at) || isClassExpression(at)) && at.name?.text === name.text)
      return false;
  return runsWithin(name, fn);
}

/** Whether no arm a written condition rules out holds the node, or a function that holds it. */
function runsWithin(node: Node, fn: FunctionExpression): boolean {
  if (!framedPossibleBranch(node)) return false;
  for (let at = node.parent; at !== fn; at = at.parent)
    if (isAnswering(at) && !framedPossibleBranch(at)) return false;
  return true;
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
