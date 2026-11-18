import {
  type ArrayLiteralExpression,
  type Block,
  type CallExpression,
  type Expression,
  type GetAccessorDeclaration,
  type Identifier,
  isComputedPropertyName,
  isElementAccessExpression,
  isForOfStatement,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAssignment,
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
import { assignedNames } from './local-date-inputs.ts';
import type { TagParameterEnv, TagPath } from './render-raw-tag-calls.ts';

/** Array-literal, array-view, loop, rest and mutated-slot expansions for template tag paths. */

const ARRAY_INDEX = { limit: 4_294_967_295 } as const;
const UNSTABLE_ARRAY_METHODS: ReadonlySet<string> = new Set(['at', 'find', 'findLast']);

export type ArrayCallOutcome = 'exhausted' | 'matched' | 'none';
type ObjectStep = 'keep' | 'masked' | 'stop';

export interface ObjectTagSink {
  readonly pending: TagPath[];
  readonly methods: MethodDeclaration[];
  readonly env?: TagParameterEnv | undefined;
}

interface ArrayMutationContext {
  readonly index: number | undefined;
  readonly tail: readonly (string | undefined)[];
  readonly rootRead: Expression;
  readonly pending: TagPath[];
  readonly env: TagParameterEnv | undefined;
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
interface ArrayLiteralTarget {
  readonly rest: readonly (string | undefined)[];
  readonly pending: TagPath[];
  readonly env: TagParameterEnv | undefined;
}

export function pushArrayLiteralTagPaths(
  array: ArrayLiteralExpression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
  env?: TagParameterEnv,
): void {
  const [head, ...rest] = suffix;
  const target: ArrayLiteralTarget = { env, pending, rest };
  if (head === undefined) {
    pushAllArrayLiteralElements(array, target);
    return;
  }
  const index = canonicalArrayTagIndex(head);
  if (index === undefined) return;
  pushIndexedArrayLiteralElements(array, index, target);
}

function pushAllArrayLiteralElements(
  array: ArrayLiteralExpression,
  target: ArrayLiteralTarget,
): void {
  const { env, pending, rest } = target;
  for (const element of array.elements) {
    if (isOmittedExpression(element)) continue;
    if (isSpreadElement(element)) {
      pending.push({ env, node: element.expression, suffix: [undefined, ...rest] });
      continue;
    }
    pending.push({ env, node: element, suffix: rest });
  }
}

function pushIndexedArrayLiteralElements(
  array: ArrayLiteralExpression,
  index: number,
  target: ArrayLiteralTarget,
): void {
  const firstSpread = array.elements.findIndex((element) => isSpreadElement(element));
  if (firstSpread === -1 || index < firstSpread) {
    const element = array.elements[index];
    if (element !== undefined && !isOmittedExpression(element)) {
      target.pending.push({ env: target.env, node: element, suffix: target.rest });
    }
    return;
  }
  pushSpreadShiftedElements(array, index, target);
}

function pushSpreadShiftedElements(
  array: ArrayLiteralExpression,
  index: number,
  target: ArrayLiteralTarget,
): void {
  const { env, pending, rest } = target;
  let fixedBefore = 0;
  for (const element of array.elements) {
    if (fixedBefore > index) return;
    if (isSpreadElement(element)) {
      pending.push({ env, node: element.expression, suffix: [undefined, ...rest] });
      continue;
    }
    if (!isOmittedExpression(element)) pending.push({ env, node: element, suffix: rest });
    fixedBefore += 1;
  }
}

/** Pushes elements selected through `.at`, `.find`, `.findLast`, and shallow array copy/factory calls. */
export function pushArrayCallTagPaths(
  call: CallExpression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
  env?: TagParameterEnv,
): ArrayCallOutcome {
  const pushElement = (element: Expression, keys?: readonly string[]): boolean => {
    pending.push({ env, node: element, suffix: [...(keys ?? []), ...suffix] });
    return false;
  };
  const atMatched = framedArrayAt(call, { error: pushElement, typed: () => false });
  if (atMatched === true) return 'exhausted';
  if (atMatched === false) pushUnstableMethodReceiver(call, suffix, pending, env);
  const findMatched = framedArrayFind(call, { error: pushElement, typed: () => false });
  if (findMatched === true) return 'exhausted';
  if (findMatched === false) pushUnstableMethodReceiver(call, suffix, pending, env);
  if (pushArrayViewCallPaths(call, suffix, pending, env)) return 'matched';
  return atMatched === undefined && findMatched === undefined ? 'none' : 'matched';
}

function pushArrayViewCallPaths(
  call: CallExpression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
  env: TagParameterEnv | undefined,
): boolean {
  if (suffix.length === 0) return false;
  const [head, ...rest] = suffix;
  const index = canonicalArrayTagIndex(head);
  if (head !== undefined && index === undefined) return false;
  const views =
    arrayFactoryViews(call, index, stableTagArray) ??
    arrayProjectedViews(call, index, stableTagArray) ??
    arrayCopyViews(call, index, stableTagArray);
  if (views === undefined) return false;
  pushArrayElementViews(views, rest, pending, env);
  return true;
}

function pushUnstableMethodReceiver(
  call: CallExpression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
  env: TagParameterEnv | undefined,
): void {
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return;
  const method = frameMemberName(callee);
  if (method === undefined || !UNSTABLE_ARRAY_METHODS.has(method)) return;
  const receiver = unwrapped(callee.expression);
  if (!stableTagArray(receiver)) {
    pending.push({ env, node: receiver, suffix: [undefined, ...suffix] });
  }
}

function stableTagArray(expression: Expression): boolean {
  return framedQuietSource(expression) !== undefined;
}

function pushArrayElementViews(
  views: readonly ArrayElementView[],
  rest: readonly (string | undefined)[],
  pending: TagPath[],
  env: TagParameterEnv | undefined,
): void {
  for (const view of views) {
    if (view.element === true) {
      pending.push({ env, node: view.value, suffix: [...(view.keys ?? []), ...rest] });
      continue;
    }
    const slot = view.index === undefined ? undefined : String(view.index);
    pending.push({ env, node: view.value, suffix: [slot, ...(view.keys ?? []), ...rest] });
  }
}

/** Expands `for...of`, rest-element bindings, and mutations on literal-backed array identifiers. */
export function pushArrayIdentifierTagPaths(
  name: Identifier,
  suffix: readonly (string | undefined)[],
  context: {
    readonly rootRead: Expression;
    readonly pending: TagPath[];
    readonly env?: TagParameterEnv | undefined;
  },
): boolean {
  const { env, pending, rootRead } = context;
  pushForOfTagPath(name, suffix, pending, env);
  if (suffix.length === 0) return false;
  const [head, ...tail] = suffix;
  const index = canonicalArrayTagIndex(head);
  if (head !== undefined && index === undefined) return false;
  const restView = arrayRestView(name, index);
  if (restView !== undefined) pushArrayElementViews([restView], tail, pending, env);
  const root = literalArrayBinding(name);
  return (
    root !== undefined &&
    pushMutatedArrayTagPaths(name, root, { env, index, pending, rootRead, tail })
  );
}

function pushForOfTagPath(
  name: Identifier,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
  env: TagParameterEnv | undefined,
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
  pending.push({ env, node: loop.expression, suffix: [undefined, ...keys, ...suffix] });
}

function pushMutatedArrayTagPaths(
  name: Identifier,
  root: FrameBinding,
  context: ArrayMutationContext,
): boolean {
  const { env, index, pending, rootRead, tail } = context;
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
      pending.push({ env, node: source.value, suffix: [undefined, ...tail] });
    } else if (source.keys.length === 0 && isSpreadElement(source.value)) {
      pending.push({ env, node: source.value.expression, suffix: [undefined, ...tail] });
    } else {
      pending.push({ env, node: source.value, suffix: [...source.keys, ...tail] });
    }
  }
  if (index !== undefined && root.initializer !== undefined && hasPositionMovingCall(root)) {
    pending.push({ env, node: root.initializer, suffix: [undefined, ...tail] });
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

/** Right-to-left own-property scan so unconditional later entries override earlier entries and spreads. */
export function pushObjectTagPaths(
  literal: ObjectLiteralExpression,
  suffix: readonly (string | undefined)[],
  sink: ObjectTagSink,
): void {
  let setterMasked = false;
  let prototype: Expression | undefined;
  for (const property of literal.properties.toReversed()) {
    if (isPropertyAssignment(property) && isPrototypeProperty(property)) {
      prototype ??= property.initializer;
      continue;
    }
    const outcome = stepObjectTagProperty(property, suffix, setterMasked, sink);
    if (outcome === 'stop') return;
    if (outcome === 'masked') setterMasked = true;
  }
  if (!setterMasked && prototype !== undefined) {
    sink.pending.push({ env: sink.env, node: prototype, suffix: prototypeSuffix(suffix) });
  }
}

function prototypeSuffix(suffix: readonly (string | undefined)[]): readonly (string | undefined)[] {
  return suffix[0] === '__proto__' ? suffix.slice(1) : suffix;
}

function isPrototypeProperty(property: PropertyAssignment): boolean {
  return (
    !isComputedPropertyName(property.name) && assignedNames(property.name)?.[0] === '__proto__'
  );
}

function stepObjectTagProperty(
  property: ObjectLiteralElementLike,
  suffix: readonly (string | undefined)[],
  setterMasked: boolean,
  sink: ObjectTagSink,
): ObjectStep {
  const [head] = suffix;
  if (isSpreadAssignment(property)) {
    if (!setterMasked) sink.pending.push({ env: sink.env, node: property.expression, suffix });
    return 'keep';
  }
  if (isGetAccessorDeclaration(property)) return stepGetterProperty(property, suffix, sink);
  if (isSetAccessorDeclaration(property)) {
    return exactObjectKey(assignedNames(property.name), head) ? 'masked' : 'keep';
  }
  return stepDataProperty(property, suffix, setterMasked, sink);
}

function stepGetterProperty(
  getter: GetAccessorDeclaration,
  suffix: readonly (string | undefined)[],
  sink: ObjectTagSink,
): ObjectStep {
  const [head, ...rest] = suffix;
  const names = assignedNames(getter.name);
  if (matchesObjectKey(names, head) && getter.body !== undefined) {
    for (const expression of returnedExpressions(getter.body)) {
      sink.pending.push({ env: sink.env, node: expression, suffix: rest });
    }
  }
  return exactObjectKey(names, head) ? 'stop' : 'keep';
}

function returnedExpressions(body: Block): readonly Expression[] {
  const expressions: Expression[] = [];
  const pending: Node[] = [...body.statements];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isFunctionLikeDeclaration(node)) continue;
    if (isReturnStatement(node)) {
      if (node.expression !== undefined) expressions.push(node.expression);
      continue;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return expressions;
}

function stepDataProperty(
  property: ObjectLiteralElementLike,
  suffix: readonly (string | undefined)[],
  setterMasked: boolean,
  sink: ObjectTagSink,
): ObjectStep {
  const [head, ...rest] = suffix;
  if (isShorthandPropertyAssignment(property)) {
    return isIdentifier(property.name)
      ? stepShorthandProperty(property.name, suffix, setterMasked, sink)
      : 'keep';
  }
  if (isMethodDeclaration(property)) {
    const names = assignedNames(property.name);
    if (!setterMasked && rest.length === 0 && matchesObjectKey(names, head)) {
      sink.methods.push(property);
    }
    return exactObjectKey(names, head) ? 'stop' : 'keep';
  }
  if (!isPropertyAssignment(property)) return 'keep';
  const names = assignedNames(property.name);
  if (!setterMasked && matchesObjectKey(names, head)) {
    sink.pending.push({ env: sink.env, node: property.initializer, suffix: rest });
  }
  return exactObjectKey(names, head) ? 'stop' : 'keep';
}

function stepShorthandProperty(
  name: Identifier,
  suffix: readonly (string | undefined)[],
  setterMasked: boolean,
  sink: ObjectTagSink,
): ObjectStep {
  const [head, ...rest] = suffix;
  if (!setterMasked && (head === undefined || head === name.text)) {
    sink.pending.push({ env: sink.env, node: name, suffix: rest });
  }
  return head === name.text ? 'stop' : 'keep';
}

function matchesObjectKey(names: readonly string[] | undefined, head: string | undefined): boolean {
  return head === undefined || names === undefined || names.includes(head);
}

function exactObjectKey(names: readonly string[] | undefined, head: string | undefined): boolean {
  return head !== undefined && names?.length === 1 && names[0] === head;
}
