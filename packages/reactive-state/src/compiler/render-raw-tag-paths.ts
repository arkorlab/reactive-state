import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isElementAccessExpression,
  isForOfStatement,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { arrayCopyViews } from './framed-array-copies.ts';
import {
  arrayWritesUnfollowed,
  literalArrayBinding,
  positionsMove,
  writtenArrayElements,
} from './framed-array-elements.ts';
import { arrayFactoryViews } from './framed-array-factories.ts';
import { arrayProjectedViews } from './framed-array-projections.ts';
import { arrayRestView, type ArrayElementView } from './framed-array-rest.ts';
import { framedArrayAt, framedArrayFind } from './framed-array-selections.ts';
import {
  frameBindingOf,
  frameDeclarationOf,
  frameMemberName,
  type FrameBinding,
} from './framed-bindings.ts';
import { UnfollowableError } from './framed-getter-writes.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';
import type { TagPath } from './render-raw-tag-calls.ts';

/** Array-literal, array-view, loop, rest and mutated-slot expansions for template tag paths. */

const ARRAY_INDEX = { limit: 4_294_967_295 } as const;

interface ArrayMutationContext {
  readonly index: number | undefined;
  readonly tail: readonly (string | undefined)[];
  readonly rootRead: Expression;
  readonly pending: TagPath[];
}

export function canonicalArrayTagIndex(key: string | undefined): number | undefined {
  if (key === undefined) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) &&
    index >= 0 &&
    index < ARRAY_INDEX.limit &&
    String(index) === key
    ? index
    : undefined;
}

/** Pushes candidate elements for exact, dynamic, or spread-shifted array-literal selections. */
export function pushArrayLiteralTagPaths(
  array: ArrayLiteralExpression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  const [head, ...rest] = suffix;
  if (head === undefined) {
    pushAllArrayLiteralElements(array, rest, pending);
    return;
  }
  const index = canonicalArrayTagIndex(head);
  if (index === undefined) return;
  pushIndexedArrayLiteralElements(array, index, rest, pending);
}

function pushAllArrayLiteralElements(
  array: ArrayLiteralExpression,
  rest: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  for (const element of array.elements) {
    if (isOmittedExpression(element)) continue;
    if (isSpreadElement(element)) {
      pending.push({ node: element.expression, suffix: [undefined, ...rest] });
      continue;
    }
    pending.push({ node: element, suffix: rest });
  }
}

function pushIndexedArrayLiteralElements(
  array: ArrayLiteralExpression,
  index: number,
  rest: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  const firstSpread = array.elements.findIndex((element) => isSpreadElement(element));
  if (firstSpread === -1 || index < firstSpread) {
    const element = array.elements[index];
    if (element !== undefined && !isOmittedExpression(element)) {
      pending.push({ node: element, suffix: rest });
    }
    return;
  }
  pushSpreadShiftedElements(array, index, rest, pending);
}

function pushSpreadShiftedElements(
  array: ArrayLiteralExpression,
  index: number,
  rest: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  let fixedBefore = 0;
  for (const element of array.elements) {
    if (fixedBefore > index) return;
    if (isSpreadElement(element)) {
      pending.push({ node: element.expression, suffix: [undefined, ...rest] });
      continue;
    }
    if (!isOmittedExpression(element)) pending.push({ node: element, suffix: rest });
    fixedBefore += 1;
  }
}

/** Pushes elements selected through `.at`, `.find`, `.findLast`, and shallow array copy/factory calls. */
export function pushArrayCallTagPaths(
  call: CallExpression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): boolean {
  const pushElement = (element: Expression, keys?: readonly string[]): boolean => {
    pending.push({ node: element, suffix: [...(keys ?? []), ...suffix] });
    return false;
  };
  const atMatched = framedArrayAt(call, { error: pushElement, typed: () => false });
  if (atMatched === true) return true;
  if (atMatched === false) pushUnstableAtReceiver(call, suffix, pending);
  if (framedArrayFind(call, { error: pushElement, typed: () => false }) === true) return true;
  if (suffix.length === 0) return false;
  const [head, ...rest] = suffix;
  const index = canonicalArrayTagIndex(head);
  if (head !== undefined && index === undefined) return false;
  const views =
    arrayFactoryViews(call, index, stableTagArray) ??
    arrayProjectedViews(call, index, stableTagArray) ??
    arrayCopyViews(call, index, stableTagArray);
  if (views !== undefined) pushArrayElementViews(views, rest, pending);
  return false;
}

function pushUnstableAtReceiver(
  call: CallExpression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return;
  if (frameMemberName(callee) !== 'at') return;
  const receiver = unwrapped(callee.expression);
  if (!stableTagArray(receiver)) pending.push({ node: receiver, suffix: [undefined, ...suffix] });
}

function stableTagArray(expression: Expression): boolean {
  return framedQuietSource(expression) !== undefined;
}

function pushArrayElementViews(
  views: readonly ArrayElementView[],
  rest: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  for (const view of views) {
    if (view.element === true) {
      pending.push({ node: view.value, suffix: [...(view.keys ?? []), ...rest] });
      continue;
    }
    const slot = view.index === undefined ? undefined : String(view.index);
    pending.push({ node: view.value, suffix: [slot, ...(view.keys ?? []), ...rest] });
  }
}

/** Expands `for...of`, rest-element bindings, and mutations on literal-backed array identifiers. */
export function pushArrayIdentifierTagPaths(
  name: Identifier,
  suffix: readonly (string | undefined)[],
  rootRead: Expression,
  pending: TagPath[],
): boolean {
  pushForOfTagPath(name, suffix, pending);
  if (suffix.length === 0) return false;
  const [head, ...tail] = suffix;
  const index = canonicalArrayTagIndex(head);
  if (head !== undefined && index === undefined) return false;
  const restView = arrayRestView(name, index);
  if (restView !== undefined) pushArrayElementViews([restView], tail, pending);
  const root = literalArrayBinding(name);
  return (
    root !== undefined && pushMutatedArrayTagPaths(name, root, { index, pending, rootRead, tail })
  );
}

function pushForOfTagPath(
  name: Identifier,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  const declared = frameDeclarationOf(name);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isVariableDeclarationList(declared.parent)
  )
    return;
  const loop = declared.parent.parent;
  if (!isForOfStatement(loop) || loop.initializer !== declared.parent) return;
  const keys = frameBindingOf(name)?.keys ?? [];
  pending.push({ node: loop.expression, suffix: [undefined, ...keys, ...suffix] });
}

function pushMutatedArrayTagPaths(
  name: Identifier,
  root: FrameBinding,
  context: ArrayMutationContext,
): boolean {
  const { index, pending, rootRead, tail } = context;
  if (arrayWritesUnfollowed(name, rootRead)) return true;
  let written: ReturnType<typeof writtenArrayElements>;
  try {
    written = writtenArrayElements(name, rootRead, index);
  } catch (error) {
    if (error instanceof UnfollowableError) return true;
    throw error;
  }
  for (const source of written) {
    if (source.array === true) {
      pending.push({ node: source.value, suffix: [undefined, ...tail] });
    } else if (source.keys.length === 0 && isSpreadElement(source.value)) {
      pending.push({ node: source.value.expression, suffix: [undefined, ...tail] });
    } else {
      pending.push({ node: source.value, suffix: [...source.keys, ...tail] });
    }
  }
  if (index !== undefined && root.initializer !== undefined && hasPositionMovingCall(root)) {
    pending.push({ node: root.initializer, suffix: [undefined, ...tail] });
  }
  return false;
}

function hasPositionMovingCall(root: FrameBinding): boolean {
  const pending: Node[] = [root.getSourceFile()];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (positionsMove(current, root)) return true;
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
