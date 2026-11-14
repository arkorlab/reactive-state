import {
  type BinaryExpression,
  type Expression,
  type CallExpression,
  type Node,
  type VariableDeclaration,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isTypeNode,
  isSourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { emptyArrayFill } from './framed-array-fill-ranges.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { arrayIdentity, isRootLiteral } from './framed-array-identity.ts';
import { framedLogicalElementSkipped } from './framed-array-logical-writes.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { borrowedArrayMutation } from './framed-array-mutators.ts';
import { arrayPatternSources } from './framed-array-pattern-writes.ts';
import type { AssignedFrameSource } from './framed-assignment-patterns.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { heldMemberWrites } from './framed-held-member-writes.ts';
import { consultedKnown } from './framed-known-forms.ts';
import { knownUsesOnly } from './framed-known-mentions.ts';
import {
  invokedTargets,
  type MutatorInvocation,
  mutatorInvocation,
  PATHS,
  returnedTargets,
  soleTarget,
} from './framed-mutator-calls.ts';
import { possibleKey } from './framed-mutator-keys.ts';
import { objectMutatorElements } from './framed-object-mutator-elements.ts';
import { madeWithin } from './framed-recursion.ts';
import { framedCondition } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { constantValue } from './numbers.ts';

export interface WrittenArrayElement extends AssignedFrameSource {
  readonly array?: boolean;
}

/** Source-written element assignments and native mutator inputs for one lexical literal-array identity. */
export function writtenArrayElements(
  value: Expression,
  read: Node,
  index?: number,
): readonly WrittenArrayElement[] {
  const root = literalArrayBinding(value);
  if (root === undefined) return [];
  const candidates = candidatesOf(root, read);
  const selected =
    index !== undefined && index >= 0 && candidates.every((node) => !positionsMove(node, root))
      ? index
      : undefined;
  return candidates.flatMap((node) => {
    return [
      ...elementSources(node, root, selected),
      ...arrayPatternSources(node, (target) => {
        return (
          isElementAccessExpression(target) &&
          literalArrayBinding(target.expression) === root &&
          possibleIndex(target.argumentExpression, selected)
        );
      }),
    ];
  });
}

/** The nodes that may run before the read and may write the array: the program's, as its branches allow. */
function candidatesOf(root: FrameBinding, read: Node): readonly Node[] {
  const owner = executionOwner(read);
  const candidates: Node[] = [];
  const pending: Node[] = [read.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (
      !isSourceFile(node) &&
      possibleBefore(node, read, owner, root) &&
      framedPossibleBranch(node)
    )
      candidates.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return candidates;
}

/**
 * Whether every mention of the array that may run before the read is a use the compile knows. The
 * mention the read selects from, where it is given, hands the array on only after it has read.
 */
function arrayUsesKnown(
  root: VariableDeclaration,
  {
    read,
    owner,
    receiver,
  }: { readonly read: Node; readonly owner: Node; readonly receiver?: Expression },
): boolean {
  return knownUsesOnly(root, 'array', (name) => {
    return (
      (receiver === undefined || unwrapped(receiver) !== name) &&
      possibleBefore(name, read, owner, root) &&
      framedPossibleBranch(name)
    );
  });
}

/**
 * Whether the compile does not follow every write to the array a read names: a mention of it, or of a
 * name that stands for it, that may run before the read and is no use the compile knows, or a native
 * mutator of it that is handed an argument written in a form no reader follows, or a name of the chain
 * the read goes by that is written as a whole elsewhere, which may hold another array than the one it
 * was given. Such an array holds what the compile cannot show, and the read is refused.
 */
export function arrayWritesUnfollowed(value: Expression, read: Node): boolean {
  const root = literalArrayBinding(value);
  if (root === undefined || !isVariableDeclaration(root)) return false;
  if (arrayIdentity(value) === undefined) return true;
  const owner = executionOwner(read);
  if (!arrayUsesKnown(root, { read, owner, receiver: value })) return true;
  const held: VariableDeclaration[] = [];
  const known = candidatesOf(root, read).every((node) => {
    const invoked = isCallExpression(node) ? mutatorInvocation(node) : undefined;
    const target = invoked?.args[0];
    if (invoked === undefined || target === undefined) return true;
    return (
      invokedTargets(invoked).every((each) => !isRootArray(each, root)) ||
      argumentsKnown(invoked, (declaration) => {
        held.push(declaration);
      })
    );
  });
  return !known || held.some((declaration) => writtenValuesUnknown(declaration, read));
}

/** Whether a value written to a member of a held object is in a form no reader follows. */
function writtenValuesUnknown(declaration: VariableDeclaration, read: Node): boolean {
  const { name } = declaration;
  if (!isIdentifier(name)) return false;
  return heldMemberWrites(name, [name], read).some(
    (write) => !consultedKnown(write.value, 'pattern'),
  );
}

/** Whether the sources, the descriptor or the map a native mutator is handed are written in forms followed. */
function argumentsKnown(
  invoked: MutatorInvocation,
  held: (declaration: VariableDeclaration) => void,
): boolean {
  const [, ...rest] = invoked.args;
  if (rest.some((each) => isSpreadElement(each))) return false;
  if (invoked.path === PATHS.assign)
    return rest.every((each) => consultedKnown(each, 'source', held));
  const argument = invoked.path === PATHS.property ? rest[1] : rest[0];
  const role = invoked.path === PATHS.property ? 'descriptor' : 'map';
  return argument === undefined || consultedKnown(argument, role, held);
}

const ELEMENT_WRITES = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Same-owner prefixes constrain writes, including those the read or copy evaluates in its own
 * receiver, key or arguments before it reads; other referenced execution owners remain possible.
 */
function possibleBefore(node: Node, read: Node, owner: Node, root: FrameBinding): boolean {
  const writer = executionOwner(node);
  return writer === owner
    ? (node.pos < read.pos && !writesAfterOperands(node, read, root, owner)) ||
        evaluatedWithin(node, read) ||
        destructuredFirst(node, read) ||
        repeatedFrameRead(node, read, root, owner)
    : !unreferencedLocalFunction(writer, owner);
}

/**
 * Whether a write that holds the read among its operands runs after it: the operands of a call or an
 * assignment run before the write the call or the assignment makes, as `a.push(String(a), error)`
 * reads the array as it was. A function that is run again, or a loop, brings an earlier pass's write
 * back to the read, so the array must be one each run makes, and the loop not repeat it.
 */
function writesAfterOperands(node: Node, read: Node, root: FrameBinding, owner: Node): boolean {
  const holds = node !== read && node.pos <= read.pos && read.end <= node.end;
  return (
    holds &&
    madeWithin(root, owner) &&
    evaluatesBeforeWriting(node, read) &&
    !repeatedFrameRead(node, read, root, owner)
  );
}

/** Whether a node, a call, an assignment or a loop head, makes its write only after the part the read lies in. */
function evaluatesBeforeWriting(node: Node, read: Node): boolean {
  if (isCallExpression(node)) return true;
  if (isForOfStatement(node)) return within(read, node.expression);
  if (!isBinaryExpression(node) || !ELEMENT_WRITES.has(node.operatorToken.kind)) return false;
  const target = unwrapped(node.left);
  const pattern = isArrayLiteralExpression(target) || isObjectLiteralExpression(target);
  return !pattern || within(read, node.right);
}

/** Whether a node lies within another. */
function within(node: Node, container: Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

/** A write the read evaluates first, unless a written left operand short-circuits past it. */
function evaluatedWithin(node: Node, read: Node): boolean {
  if (node === read || node.end > read.end) return false;
  for (let at = node; !isSourceFile(at); at = at.parent) {
    const { parent } = at;
    if (parent === read) return true;
    if (isBinaryExpression(parent) && parent.right === at && shortCircuits(parent)) return false;
  }
  return false;
}

/** Whether a written left side keeps a logical operator from evaluating its right operand. */
function shortCircuits(node: BinaryExpression): boolean {
  const condition = framedCondition(node.left);
  const kind = node.operatorToken.kind;
  return (
    (kind === SyntaxKind.AmpersandAmpersandToken && condition === false) ||
    (kind === SyntaxKind.BarBarToken && condition === true)
  );
}

/**
 * Only indexed assignment positions, the insertion arguments of native mutators and the numeric
 * entries native object mutators install become elements.
 */
export function elementSources(
  node: Node,
  root: FrameBinding,
  index: number | undefined,
): readonly WrittenArrayElement[] {
  if (isBinaryExpression(node) && ELEMENT_WRITES.has(node.operatorToken.kind)) {
    const target = unwrapped(node.left);
    if (
      !isElementAccessExpression(target) ||
      literalArrayBinding(target.expression) !== root ||
      !possibleIndex(target.argumentExpression, index)
    )
      return [];
    return framedLogicalElementSkipped(node, root, (value) => literalArrayBinding(value) === root)
      ? []
      : [{ value: node.right, keys: [] }];
  }
  if (!isCallExpression(node)) return [];
  const mutated = objectMutatorElements(node, index);
  if (mutated !== undefined)
    return mutated.targets.some((target) => isRootArray(target, root)) ? mutated.elements : [];
  const borrowed = borrowedElements(node, root);
  if (borrowed !== undefined) return borrowed;
  const member = unwrapped(node.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    !mayBeArrayOf(member.expression, root) ||
    sourceArrayFunction(member)
  )
    return [];
  const method = frameMemberName(member);
  if (
    method === 'fill' &&
    emptyArrayFill(node.arguments, {
      receiver: member.expression,
      root,
      call: node,
      borrowed: false,
      identity: literalArrayBinding,
    })
  )
    return [];
  const inserted = insertedArguments(method, node.arguments, node);
  return inserted.map((value) => ({ value, keys: [] }));
}

/**
 * Native insertion positions exclude splice's start/delete count and fill's range arguments; a
 * written argument before the first spread keeps its position, later ones may be inserted. Fill
 * writes its first runtime argument, which a spread may supply or leave to a later one.
 */
function insertedArguments(
  method: string | undefined,
  given: readonly Expression[],
  call: CallExpression,
): readonly Expression[] {
  if (method !== 'push' && method !== 'unshift' && method !== 'splice' && method !== 'fill')
    return [];
  if (method === 'fill') return framedConsumedArguments(call, given, 1);
  if (method !== 'splice') return given;
  const spread = given.findIndex((each) => isSpreadElement(each));
  return given.slice(spread === -1 ? 2 : Math.min(spread, 2));
}

const MOVING = new Set(['copyWithin', 'reverse', 'shift', 'sort', 'splice', 'unshift']);

/** Whether an expression is the array a binding holds: its name, or the literal it was initialized with. */
export function isRootArray(expression: Expression, root: FrameBinding): boolean {
  return literalArrayBinding(expression) === root || isRootLiteral(expression, root);
}

/**
 * Whether the array a method is called on may be this one: the name of it, or any of the arrays the
 * expression stands for, a condition, a comma, a logical operand, an assignment, a call that
 * returns what it was called on.
 */
export function mayBeArrayOf(receiver: Expression, root: FrameBinding): boolean {
  return returnedTargets(receiver).some((each) => isRootArray(each, root));
}

/** A possible position-moving mutator leaves every assigned numeric entry reachable. */
export function positionsMove(node: Node, root: FrameBinding): boolean {
  if (!isCallExpression(node)) return false;
  const borrowed = borrowedArrayMutation(node);
  if (borrowed !== undefined)
    return mayBeArrayOf(borrowed.receiver, root) && MOVING.has(borrowed.method);
  const member = unwrapped(node.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    !mayBeArrayOf(member.expression, root) ||
    sourceArrayFunction(member)
  )
    return false;
  return MOVING.has(frameMemberName(member) ?? '');
}

/**
 * Unknown computed positions may be numeric; known non-index own names are not joined elements, and
 * neither is an integer past the greatest array index, which names an ordinary property.
 */
function possibleIndex(key: Expression, index: number | undefined): boolean {
  const value = constantValue(unwrapped(key));
  if (value === undefined) return true;
  return (typeof value === 'number' || typeof value === 'string') && possibleKey(value, index);
}

/** A written literal array behind lexical whole-value aliases, excluding destructured projections. */
export function literalArrayBinding(node: Expression): FrameBinding | undefined {
  let value = unwrapped(node);
  let root: FrameBinding | undefined;
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return undefined;
    root = selected.binding;
    seen.add(root);
    if (root.initializer === undefined) return undefined;
    value = soleTarget(unwrapped(root.initializer));
  }
  return isArrayLiteralExpression(value) ? root : undefined;
}

/** Borrowed insertion calls bypass receiver-owned mutators and retain opaque apply lists as arrays. */
function borrowedElements(
  node: CallExpression,
  root: FrameBinding,
): readonly WrittenArrayElement[] | undefined {
  const borrowed = borrowedArrayMutation(node);
  if (borrowed === undefined) return undefined;
  if (!mayBeArrayOf(borrowed.receiver, root)) return [];
  if (
    borrowed.method === 'fill' &&
    emptyArrayFill(borrowed.given, {
      receiver: borrowed.receiver,
      root,
      call: node,
      borrowed: true,
      identity: literalArrayBinding,
    })
  )
    return [];
  const values = insertedArguments(borrowed.method, borrowed.given, node);
  const possibleArray = ['fill', 'push', 'splice', 'unshift'].includes(borrowed.method)
    ? borrowed.unknownList
    : undefined;
  return [
    ...values.map((value) => ({ value, keys: [] })),
    ...(possibleArray === undefined ? [] : [{ value: possibleArray, keys: [], array: true }]),
  ];
}
