import {
  type BinaryExpression,
  type Expression,
  type CallExpression,
  type Node,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  isTypeNode,
  isSourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { emptyArrayFill } from './framed-array-fill-ranges.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { framedLogicalElementSkipped } from './framed-array-logical-writes.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { borrowedArrayMutation } from './framed-array-mutators.ts';
import { arrayPatternSources } from './framed-array-pattern-writes.ts';
import type { AssignedFrameSource } from './framed-assignment-patterns.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
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

/**
 * Same-owner prefixes constrain writes, including those the read or copy evaluates in its own
 * receiver, key or arguments before it reads; other referenced execution owners remain possible.
 */
function possibleBefore(node: Node, read: Node, owner: Node, root: FrameBinding): boolean {
  const writer = executionOwner(node);
  return writer === owner
    ? node.pos < read.pos ||
        evaluatedWithin(node, read) ||
        destructuredFirst(node, read) ||
        repeatedFrameRead(node, read, root, owner)
    : !unreferencedLocalFunction(writer, owner);
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

const ELEMENT_WRITES = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Only indexed assignment positions and the insertion arguments of native mutators become elements. */
function elementSources(
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
  const borrowed = borrowedElements(node, root);
  if (borrowed !== undefined) return borrowed;
  const member = unwrapped(node.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    literalArrayBinding(member.expression) !== root ||
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

/** A possible position-moving mutator leaves every assigned numeric entry reachable. */
function positionsMove(node: Node, root: FrameBinding): boolean {
  if (!isCallExpression(node)) return false;
  const borrowed = borrowedArrayMutation(node);
  if (borrowed !== undefined)
    return literalArrayBinding(borrowed.receiver) === root && MOVING.has(borrowed.method);
  const member = unwrapped(node.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    literalArrayBinding(member.expression) !== root ||
    sourceArrayFunction(member)
  )
    return false;
  return MOVING.has(frameMemberName(member) ?? '');
}

/** Unknown computed positions may be numeric; known non-index own names are not joined elements. */
function possibleIndex(key: Expression, index: number | undefined): boolean {
  const value = constantValue(unwrapped(key));
  if (value === undefined) return true;
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 && (index === undefined || value === index);
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9]\d*)$/u.test(value) &&
    (index === undefined || Number(value) === index)
  );
}

/** A written literal array behind lexical whole-value aliases, excluding destructured projections. */
function literalArrayBinding(node: Expression): FrameBinding | undefined {
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
    value = unwrapped(root.initializer);
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
  if (literalArrayBinding(borrowed.receiver) !== root) return [];
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
