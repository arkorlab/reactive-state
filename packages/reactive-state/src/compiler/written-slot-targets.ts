import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isSpreadElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { readsBinding } from './scope.ts';
import {
  constFollowedValue,
  constInitializerOf,
  spreadOnlyInitializer,
  unmutatedTuple,
} from './tuple-spreads.ts';
import {
  asCallArguments,
  branchOperands,
  type CallArgument,
  slotArguments,
} from './written-arguments.ts';
import { moduleArrayWrites } from './written-array-elements.ts';
import {
  applyHolderWrites,
  projectMemberKeys,
  selectedInitialExpressions,
  type SpreadWork,
} from './written-slot-pushes.ts';

/**
 * Slot-specific write targets (`dispatchEvent`'s 1st argument and `Reflect.set`'s 4th-argument
 * receiver) resolved across positional branches, tuple spreads, and local `apply` or mutated lists.
 */

export interface SlotTargetOptions {
  readonly skipPrimitiveGlobals?: boolean;
}

interface SlotTargetState {
  readonly recorded: Set<Node>;
  readonly skipPrimitiveGlobals: boolean;
  readonly targets: Node[];
  readonly visited: Map<Expression, Set<string>>;
}

const SLOTS = { dispatchEvent: 0, reflectSetReceiver: 3 } as const;
const PRIMITIVE_GLOBALS: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);

/** Explicit 4th-argument receivers of `Reflect.set`, through spreads, `apply` lists or branches. */
export function reflectSetReceivers(given: readonly CallArgument[]): readonly Node[] {
  return slotTargets(given, SLOTS.reflectSetReceiver, { skipPrimitiveGlobals: true });
}

/** Dispatched `Event` targets at slot 0 of `dispatchEvent`, through spreads, `apply` or branches. */
export function dispatchEventTargets(given: readonly CallArgument[]): readonly Node[] {
  return slotTargets(given, SLOTS.dispatchEvent);
}

/** Targets that can occupy `slot`, recording known slot elements before opaque spread holders. */
export function slotTargets(
  given: readonly CallArgument[],
  slot: number,
  options?: SlotTargetOptions,
): readonly Node[] {
  const state: SlotTargetState = {
    recorded: new Set(),
    skipPrimitiveGlobals: options?.skipPrimitiveGlobals ?? false,
    targets: [],
    visited: new Map(),
  };
  const candidates = slotArguments(given, slot);
  let shiftedSpread = false;
  for (const candidate of candidates) {
    if (candidate.spread) {
      const maxOffset = slot - candidate.index;
      const minOffset = shiftedSpread ? 0 : maxOffset;
      shiftedSpread = true;
      collectSpreadSlotTargets(candidate.expression, minOffset, maxOffset, state);
    } else {
      collectPositionalTarget(candidate.expression, state, new Set());
    }
  }
  return state.targets;
}

/** Drains a single spread or `apply` argument candidate, emitting element targets before holders. */
function collectSpreadSlotTargets(
  expression: Expression,
  minOffset: number,
  maxOffset: number,
  state: SlotTargetState,
): void {
  const holders: Expression[] = [];
  const pending: SpreadWork[] = [
    { expression, held: false, maxOffset, minOffset, reordered: false },
  ];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const value = unwrapped(current.expression);
    if (!markSpreadVisited(value, current, state.visited)) {
      continue;
    }
    if (current.held) {
      stepHeldSpread({ ...current, expression: value }, pending, state);
    } else if (!stepCleanSpread({ ...current, expression: value }, pending, state)) {
      holders.push(value);
      pending.push({ ...current, expression: value, held: true });
    }
  }
  for (const holder of holders) {
    recordTarget(holder, state);
  }
}

/** Records `work` in `visited` and answers whether this `(value, work)` state is new. */
function markSpreadVisited(
  value: Expression,
  work: SpreadWork,
  visited: Map<Expression, Set<string>>,
): boolean {
  const rangeKey = work.reordered ? 'r' : `${String(work.minOffset)}:${String(work.maxOffset)}`;
  const key = `${work.held ? '1' : '0'}:${rangeKey}`;
  let keys = visited.get(value);
  if (keys === undefined) {
    keys = new Set();
    visited.set(value, keys);
  }
  if (keys.has(key)) {
    return false;
  }
  keys.add(key);
  return true;
}

/** Expands an unmutated tuple, spread-only alias or branch expression without adding a holder. */
function stepCleanSpread(work: SpreadWork, pending: SpreadWork[], state: SlotTargetState): boolean {
  const tuple = unmutatedTuple(work.expression);
  if (tuple !== undefined) {
    inspectArrayElements(tuple, work, pending, state);
    return true;
  }
  const spreadInit = isIdentifier(work.expression)
    ? spreadOnlyInitializer(work.expression)
    : undefined;
  if (spreadInit !== undefined) {
    pending.push({ ...work, expression: spreadInit, held: false });
    return true;
  }
  const branches = branchOperands(work.expression);
  if (branches === undefined) {
    return false;
  }
  for (const branch of branches.toReversed()) {
    pending.push({ ...work, expression: branch, held: false });
  }
  return true;
}

/** Collects element targets reachable through an `apply` list, mutable array or alias binding. */
function stepHeldSpread(work: SpreadWork, pending: SpreadWork[], state: SlotTargetState): void {
  const branches = branchOperands(work.expression);
  if (branches !== undefined) {
    for (const branch of branches.toReversed()) {
      pending.push({ ...work, expression: branch, held: true });
    }
    return;
  }
  if (isArrayLiteralExpression(work.expression)) {
    inspectArrayElements(work.expression, work, pending, state);
    return;
  }
  if (isIdentifier(work.expression) && readsBinding(work.expression)) {
    stepHeldIdentifier(work.expression, work, pending, state);
  }
}

/** Follows a held array identifier's initializer, reassignments and indexed/pushed writes. */
function stepHeldIdentifier(
  ident: Identifier,
  work: SpreadWork,
  pending: SpreadWork[],
  state: SlotTargetState,
): void {
  const owner = frameDeclarationOf(ident);
  const selected = frameBindingOf(ident);
  const writes =
    owner === undefined ? undefined : moduleArrayWrites(ident.getSourceFile()).get(owner);
  const reordered = work.reordered || (writes?.reordered ?? false);
  const initialValues = selected === undefined ? [] : selectedInitialExpressions(ident, selected);
  if (writes !== undefined) {
    applyHolderWrites(
      writes,
      { ident, initialValues, owner, selected },
      { ...work, reordered },
      {
        onPositional: (expr) => {
          collectPositionalTarget(expr, state, new Set());
        },
        pending,
      },
    );
  }
  const assignedSources = framedAssignedSources(ident).toReversed();
  for (const source of assignedSources) {
    const projected = projectMemberKeys(source.value, source.keys);
    for (const value of projected.toReversed()) {
      pending.push({ ...work, expression: value, held: true, reordered });
    }
  }
  for (const initial of initialValues.toReversed()) {
    pending.push({ ...work, expression: initial, held: true, reordered });
  }
}

/** Inspects an array literal's elements at `[work.minOffset, work.maxOffset]` (or all if reordered). */
function inspectArrayElements(
  arrayNode: ArrayLiteralExpression,
  work: SpreadWork,
  pending: SpreadWork[],
  state: SlotTargetState,
): void {
  if (work.reordered) {
    for (const element of arrayNode.elements) {
      if (isSpreadElement(element)) {
        pending.push({
          expression: element.expression,
          held: true,
          maxOffset: Number.MAX_SAFE_INTEGER,
          minOffset: 0,
          reordered: true,
        });
      } else if (element.kind !== SyntaxKind.OmittedExpression) {
        collectPositionalTarget(element, state, new Set());
      }
    }
    return;
  }
  scanOrderedArrayElements(arrayNode, work, pending, state);
}

/** Walks ordered array elements up to `work.maxOffset`, expanding nested clean tuple spreads. */
function scanOrderedArrayElements(
  arrayNode: ArrayLiteralExpression,
  work: SpreadWork,
  pending: SpreadWork[],
  state: SlotTargetState,
): void {
  const stack = asCallArguments(arrayNode.elements).toReversed();
  const seen = new Set<ArrayLiteralExpression>([arrayNode]);
  let index = 0;
  let shifted = false;
  for (
    let current = stack.pop();
    current !== undefined && index <= work.maxOffset;
    current = stack.pop()
  ) {
    if (current.spread) {
      shifted = stepNestedArraySpread(current.expression, { index, shifted, work }, seen, {
        pending,
        stack,
      });
    } else {
      if (
        (shifted || index >= work.minOffset) &&
        current.expression.kind !== SyntaxKind.OmittedExpression
      ) {
        collectPositionalTarget(current.expression, state, new Set());
      }
      index += 1;
    }
  }
}

/** Expands a nested clean tuple spread onto `stack`, or queues a shifted spread candidate. */
function stepNestedArraySpread(
  expression: Expression,
  cursor: { readonly index: number; readonly shifted: boolean; readonly work: SpreadWork },
  seen: Set<ArrayLiteralExpression>,
  queues: { readonly pending: SpreadWork[]; readonly stack: CallArgument[] },
): boolean {
  const tuple = unmutatedTuple(expression);
  if (tuple === undefined || seen.has(tuple)) {
    const subMin = cursor.shifted ? 0 : Math.max(0, cursor.work.minOffset - cursor.index);
    queues.pending.push({
      expression,
      held: cursor.work.held,
      maxOffset: cursor.work.maxOffset - cursor.index,
      minOffset: subMin,
      reordered: false,
    });
    return true;
  }
  seen.add(tuple);
  queues.stack.push(...asCallArguments(tuple.elements).toReversed());
  return cursor.shifted;
}

/** Collects positional targets across conditional, logical, comma and constant branch aliases. */
function collectPositionalTarget(
  expression: Expression,
  state: SlotTargetState,
  seen: Set<Expression>,
): void {
  const plain = unwrapped(expression);
  if (seen.has(plain)) {
    return;
  }
  seen.add(plain);
  const branches = branchOperands(plain);
  if (branches !== undefined) {
    for (const branch of branches) {
      collectPositionalTarget(branch, state, seen);
    }
    return;
  }
  if (isIdentifier(plain) && readsBinding(plain)) {
    const initial = constInitializerOf(plain);
    const aliasBranches = initial === undefined ? undefined : branchOperands(unwrapped(initial));
    if (aliasBranches !== undefined) {
      for (const branch of aliasBranches) {
        collectPositionalTarget(branch, state, seen);
      }
    }
  }
  recordTarget(plain, state);
}

/** Appends `expression` once unless primitive globals are excluded at this slot. */
function recordTarget(expression: Expression, state: SlotTargetState): void {
  if (state.recorded.has(expression)) {
    return;
  }
  if (state.skipPrimitiveGlobals) {
    const resolved = constFollowedValue(expression);
    if (PRIMITIVE_GLOBALS.has(globalPathOf(resolved)?.join('.') ?? '')) {
      return;
    }
  }
  state.recorded.add(expression);
  state.targets.push(expression);
}
