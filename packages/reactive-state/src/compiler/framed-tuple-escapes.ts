import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isAssertionExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { isTrackedCall } from './framed-called-elements.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { UnfollowableError } from './framed-getter-writes.ts';
import { readsBinding } from './scope.ts';

/** Whether the identifier names one of the bindings, whole. */
function namesTuple(node: Node, aliases: ReadonlySet<FrameBinding>): boolean {
  if (!isIdentifier(node) || !readsBinding(node)) return false;
  const selected = frameBindingOf(node);
  return selected?.keys.length === 0 && aliases.has(selected.binding);
}

/** Whether an expression gives the value of an operand as its own: a cast, a branch, a logical operand. */
function passesValue(parent: Node, at: Node): boolean {
  if (
    isParenthesizedExpression(parent) ||
    isAssertionExpression(parent) ||
    isNonNullExpression(parent) ||
    isSatisfiesExpression(parent)
  )
    return true;
  if (isConditionalExpression(parent)) return parent.condition !== at;
  if (!isBinaryExpression(parent)) return false;
  const kind = parent.operatorToken.kind;
  if (kind === SyntaxKind.CommaToken) return parent.right === at;
  return (
    kind === SyntaxKind.AmpersandAmpersandToken ||
    kind === SyntaxKind.BarBarToken ||
    kind === SyntaxKind.QuestionQuestionToken
  );
}

/** Whether an operand is read and its value dropped: the left of a comma, a condition. */
function discardsValue(parent: Node, at: Node): boolean {
  if (isConditionalExpression(parent)) return parent.condition === at;
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.CommaToken &&
    parent.left === at
  );
}

/** Whether an array literal is, through the expressions that give it as their value, the iterable. */
function isIterable(array: Node, call: CallExpression): boolean {
  let at = array;
  while (
    passesValue(at.parent, at) ||
    isArrayLiteralExpression(at.parent) ||
    isSpreadElement(at.parent)
  )
    at = at.parent;
  return at.parent === call && isExpression(at) && call.arguments[0] === at;
}

/**
 * Whether the tuple's value is held in a way that leaves it where the compile can see: the object
 * of a member read or write, a method call a native mutator is, a spread, an element of the
 * iterable, an argument of a native mutator. Any other place hands it to code the compile does not
 * follow, or keeps it where a later write could reach it.
 */
function held(at: Node, call: CallExpression, entry: Expression): boolean {
  const { parent } = at;
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  ) {
    const outer = parent.parent;
    return !(isCallExpression(outer) && outer.expression === parent) || isTrackedCall(outer, entry);
  }
  if (isSpreadElement(parent)) return true;
  if (isArrayLiteralExpression(parent)) return isIterable(parent, call);
  if (parent !== call && isCallExpression(parent))
    return parent.arguments.some((each) => each === at) && isTrackedCall(parent, entry);
  return false;
}

/**
 * Whether a node lies in a function that the argument list only makes, and puts where no call of
 * the list takes it: an element of a list, the value of a field, a branch, as the arguments of the
 * call are. A function that is called, passed to a call, assigned, or returned may run there.
 */
function neverRuns(node: Node, call: CallExpression): boolean {
  for (let at = node; at !== call; at = at.parent)
    if ((isArrowFunction(at) || isFunctionExpression(at)) && onlyStored(at, call)) return true;
  return false;
}

/** Whether a node lies within another. */
function within(node: Node, container: Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

/** Whether a node is one of the arguments of the call. */
function isArgument(call: CallExpression, node: Node): boolean {
  return call.arguments.some((each) => each === node);
}

/** The operators that give the value of one of their operands. */
const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * The expressions an entry (or the list of them) may stand for: itself, or, through a condition, a
 * comma, a logical operand, the operands that give their value on.
 */
function valuesOf(expression: Expression): readonly Expression[] {
  const found: Expression[] = [];
  const pending = [expression];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at);
    if (isConditionalExpression(value)) pending.push(value.whenTrue, value.whenFalse);
    else if (!isBinaryExpression(value)) found.push(value);
    else if (value.operatorToken.kind === SyntaxKind.CommaToken) pending.push(value.right);
    else if (LOGICAL.has(value.operatorToken.kind)) pending.push(value.left, value.right);
    else found.push(value);
  }
  return found;
}

/**
 * The places of one entry that `Object.fromEntries` converts to the name it installs: the first
 * of a list, the field `0` of an object (or one whose name the compile cannot read, or a spread, which
 * may bring one). A list with a spread, whose first is not known, is all of them.
 */
function keySlotsOf(entry: Expression): readonly Node[] {
  if (isArrayLiteralExpression(entry)) {
    const spread = entry.elements.some((each) => isSpreadElement(each));
    return spread ? entry.elements : entry.elements.slice(0, 1);
  }
  if (!isObjectLiteralExpression(entry)) return [];
  return entry.properties.flatMap((property): readonly Node[] => {
    if (isSpreadAssignment(property)) return [property.expression];
    const key = writtenArrayKey(property.name);
    if (key !== undefined && key !== '0') return [];
    return isPropertyAssignment(property) ? [property.initializer] : [property];
  });
}

const KEY_SLOTS = new WeakMap<CallExpression, readonly Node[]>();

/** The places of the entries of the call's argument that are converted to names, whatever the entry is written as. */
function keySlots(call: CallExpression): readonly Node[] {
  const known = KEY_SLOTS.get(call);
  if (known !== undefined) return known;
  const slots: Node[] = [];
  const lists = call.arguments.slice(0, 1).flatMap((each) => valuesOf(each));
  for (let list = lists.pop(); list !== undefined; list = lists.pop()) {
    if (!isArrayLiteralExpression(list)) continue;
    for (const element of list.elements) {
      if (isSpreadElement(element)) lists.push(...valuesOf(element.expression));
      else slots.push(...valuesOf(element).flatMap((entry) => keySlotsOf(entry)));
    }
  }
  KEY_SLOTS.set(call, slots);
  return slots;
}

/**
 * Whether a function the list makes is held only as data the call's own arguments hold. A function an
 * object holds that is converted to the name of an entry (the first of a list, the field `0` of an
 * object, wherever the entry stands) is no such data: the call runs its `Symbol.toPrimitive`, its
 * `toString` or its `valueOf`, or those of the prototype it writes.
 */
function onlyStored(made: Node, call: CallExpression): boolean {
  let at = made;
  for (;;) {
    const { parent } = at;
    if (parent === call) return isArgument(call, at) && !convertedToName(made, call);
    const holds =
      passesValue(parent, at) ||
      isArrayLiteralExpression(parent) ||
      isObjectLiteralExpression(parent) ||
      (isPropertyAssignment(parent) && parent.initializer === at) ||
      (isSpreadElement(parent) && isArrayLiteralExpression(at));
    if (!holds) return false;
    at = parent;
  }
}

/** Whether a function lies within an object that is the name of an entry, and is not that name itself. */
function convertedToName(made: Node, call: CallExpression): boolean {
  return keySlots(call).some((slot) => slot !== made && within(made, slot));
}

/**
 * Whether the argument list of the call lets the tuple go: through a call the compile does not
 * follow, a variable, a list or a new object. A node the call's evaluation never reaches does not.
 */
function tupleEscapes(
  call: CallExpression,
  entry: Expression,
  aliases: ReadonlySet<FrameBinding>,
  reached: (node: Node) => boolean,
): boolean {
  const pending: Node[] = [call];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    node.forEachChild((child) => {
      pending.push(child);
    });
    if (!namesTuple(node, aliases) || !reached(node) || neverRuns(node, call)) continue;
    let at = node;
    while (passesValue(at.parent, at)) at = at.parent;
    if (!discardsValue(at.parent, at) && !held(at, call, entry)) return true;
  }
  return false;
}

/**
 * Whether code the argument list may run elsewhere can write the tuple: a call or a new object
 * within it that is its own, and a function that is not the call's own and is not known never to
 * run, which names the tuple.
 */
function tupleRunsElsewhere(call: CallExpression, aliases: ReadonlySet<FrameBinding>): boolean {
  const file = call.getSourceFile();
  const owner = executionOwner(call);
  let runs = false;
  const inside: Node[] = [call];
  for (let node = inside.pop(); node !== undefined && !runs; node = inside.pop()) {
    runs =
      node !== call &&
      (isCallExpression(node) || isNewExpression(node)) &&
      executionOwner(node) === owner;
    node.forEachChild((child) => {
      inside.push(child);
    });
  }
  if (!runs) return false;
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (namesTuple(node, aliases) && !(within(node, call) && neverRuns(node, call))) {
      const writer = executionOwner(node);
      if (writer !== owner && !unreferencedLocalFunction(writer, owner)) return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * Whether the tuple is exposed to code the argument list runs elsewhere, an error where the list
 * lets it go in a way the compile does not follow.
 */
export function checkedTuple(
  call: CallExpression,
  entry: Expression,
  aliases: ReadonlySet<FrameBinding>,
  reached: (node: Node) => boolean,
): boolean {
  if (aliases.size === 0) return false;
  if (tupleEscapes(call, entry, aliases, reached)) throw new UnfollowableError();
  return tupleRunsElsewhere(call, aliases);
}
