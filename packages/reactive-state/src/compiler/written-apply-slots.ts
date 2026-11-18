import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isSpreadElement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { readsBinding } from './scope.ts';
import { unmutatedTuple } from './tuple-spreads.ts';
import {
  asCallArguments,
  branchOperands,
  type CallArgument,
  slotArguments,
} from './written-arguments.ts';
import {
  type AliasLinks,
  type ArrayHolder,
  arrayHolderOf,
  type ArrayKeyInfo,
  canonicalHoldersOf,
  classifyArrayKey,
  type HolderArrayWrites,
  type ModuleArrayWrites,
} from './written-array-aliases.ts';
import {
  applyHolderWrites,
  projectMemberKeys,
  selectedInitialExpressions,
  type SpreadWork,
} from './written-slot-pushes.ts';

/**
 * Mutated-array-aware positional and tail slot projection across `.apply` argument lists, inline
 * array spreads, branch aliases, reassignments, and post-init `push` / index mutations.
 */

export interface GlobalWriteContext {
  readonly aliases: AliasLinks;
  readonly byHolder: Map<ArrayHolder, HolderArrayWrites>;
}

export interface ResolvedSlotItem {
  readonly expression: Expression;
  readonly spread: boolean;
}

/** Resolves canonical array holders occupying any of `slots` in `given` (including mutated lists). */
export function resolveSlotHolders(
  given: readonly CallArgument[],
  slots: readonly number[],
  ctx: GlobalWriteContext,
): readonly ArrayHolder[] {
  const owners = new Set<ArrayHolder>();
  for (const slot of slots) {
    for (const item of resolveCallSlot(given, slot, ctx.byHolder)) {
      for (const owner of canonicalHoldersOf(item.expression, ctx.aliases)) {
        owners.add(owner);
      }
    }
  }
  return [...owners];
}

/** Classifies resolved key-slot items into integer index, `'length'` or unknown dynamic key. */
export function classifyResolvedSlotKeys(items: readonly ResolvedSlotItem[]): ArrayKeyInfo {
  if (items.length === 0) {
    return { index: undefined, mayBeIndex: false, mayBeLength: false };
  }
  if (items.some((item) => item.spread)) {
    return { index: undefined, mayBeIndex: true, mayBeLength: true };
  }
  let mayBeIndex = false;
  let mayBeLength = false;
  let singleIndex: number | undefined;
  for (const [idx, item] of items.entries()) {
    const info = classifyArrayKey(item.expression);
    mayBeIndex ||= info.mayBeIndex;
    mayBeLength ||= info.mayBeLength;
    if (idx === 0) {
      singleIndex = info.index;
    } else if (singleIndex !== info.index) {
      singleIndex = undefined;
    }
  }
  return { index: singleIndex, mayBeIndex, mayBeLength };
}

/** Resolves positional expressions at `slot` of `given`, expanding `.apply` and mutated array lists. */
export function resolveCallSlot(
  given: readonly CallArgument[],
  slot: number,
  byHolder: ModuleArrayWrites,
): readonly ResolvedSlotItem[] {
  const results: ResolvedSlotItem[] = [];
  for (const candidate of slotArguments(given, slot)) {
    if (candidate.spread) {
      const offset = slot - candidate.index;
      results.push(...resolveListRange(candidate.expression, offset, offset, byHolder));
    } else {
      results.push({ expression: candidate.expression, spread: false });
    }
  }
  return results;
}

/** Resolves all arguments at `slot >= fromSlot` of `given`, expanding `.apply` and spread lists. */
export function resolveCallTail(
  given: readonly CallArgument[],
  fromSlot: number,
  byHolder: ModuleArrayWrites,
): readonly ResolvedSlotItem[] {
  const results: ResolvedSlotItem[] = [];
  let index = 0;
  let shifted = false;
  for (const arg of given) {
    if (arg.spread) {
      const subMin = shifted ? 0 : Math.max(0, fromSlot - index);
      results.push(...resolveListRange(arg.expression, subMin, Number.MAX_SAFE_INTEGER, byHolder));
      shifted = true;
    } else {
      if ((shifted || index >= fromSlot) && arg.expression.kind !== SyntaxKind.OmittedExpression) {
        results.push({ expression: arg.expression, spread: false });
      }
      index += 1;
    }
  }
  return results;
}

/** Resolves elements at `[minOffset, maxOffset]` of an array expression across mutations/pushes. */
function resolveListRange(
  rootExpr: Expression,
  minOffset: number,
  maxOffset: number,
  byHolder: ModuleArrayWrites,
): readonly ResolvedSlotItem[] {
  const results: ResolvedSlotItem[] = [];
  const visited = new Map<Expression, Set<string>>();
  const pending: SpreadWork[] = [
    { expression: rootExpr, held: true, maxOffset, minOffset, reordered: false },
  ];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const plain = unwrapped(current.expression);
    if (!markRangeVisited(plain, current, visited)) {
      continue;
    }
    stepListRangeItem({ ...current, expression: plain }, byHolder, pending, results);
  }
  return results;
}

/** Records `(plain, work)` in `visited` and answers whether this range state is newly visited. */
function markRangeVisited(
  plain: Expression,
  work: SpreadWork,
  visited: Map<Expression, Set<string>>,
): boolean {
  const key = work.reordered ? 'r' : `${String(work.minOffset)}:${String(work.maxOffset)}`;
  let set = visited.get(plain);
  if (set === undefined) {
    set = new Set();
    visited.set(plain, set);
  }
  if (set.has(key)) {
    return false;
  }
  set.add(key);
  return true;
}

/** Expands one `SpreadWork` item into `results` or child `pending` items. */
function stepListRangeItem(
  work: SpreadWork,
  byHolder: ModuleArrayWrites,
  pending: SpreadWork[],
  results: ResolvedSlotItem[],
): void {
  const branches = branchOperands(work.expression);
  if (branches !== undefined) {
    for (const branch of branches.toReversed()) {
      pending.push({ ...work, expression: branch });
    }
    return;
  }
  if (isArrayLiteralExpression(work.expression)) {
    stepRangeArrayLiteral(work.expression, work, pending, results);
    return;
  }
  if (isIdentifier(work.expression) && readsBinding(work.expression)) {
    stepRangeIdentifier(work.expression, work, byHolder, { pending, results });
    return;
  }
  results.push({ expression: work.expression, spread: true });
}

/** Collects elements at `[work.minOffset, work.maxOffset]` from an `ArrayLiteralExpression`. */
function stepRangeArrayLiteral(
  arrayNode: ArrayLiteralExpression,
  work: SpreadWork,
  pending: SpreadWork[],
  results: ResolvedSlotItem[],
): void {
  if (work.reordered) {
    for (const elem of arrayNode.elements) {
      if (isSpreadElement(elem)) {
        pending.push({
          expression: elem.expression,
          held: true,
          maxOffset: Number.MAX_SAFE_INTEGER,
          minOffset: 0,
          reordered: true,
        });
      } else if (elem.kind !== SyntaxKind.OmittedExpression) {
        results.push({ expression: elem, spread: false });
      }
    }
    return;
  }
  scanOrderedRangeArray(arrayNode, work, pending, results);
}

/** Scans ordered elements of `arrayNode` up to `work.maxOffset`, inlining clean tuple spreads. */
function scanOrderedRangeArray(
  arrayNode: ArrayLiteralExpression,
  work: SpreadWork,
  pending: SpreadWork[],
  results: ResolvedSlotItem[],
): void {
  const stack = asCallArguments(arrayNode.elements).toReversed();
  const seen = new Set<ArrayLiteralExpression>([arrayNode]);
  let idx = 0;
  let shifted = false;
  for (
    let current = stack.pop();
    current !== undefined && idx <= work.maxOffset;
    current = stack.pop()
  ) {
    if (current.spread) {
      shifted = stepOrderedRangeSpread(
        current.expression,
        { idx, shifted, work },
        { pending, seen, stack },
      );
    } else {
      if (
        (shifted || idx >= work.minOffset) &&
        current.expression.kind !== SyntaxKind.OmittedExpression
      ) {
        results.push({ expression: current.expression, spread: false });
      }
      idx += 1;
    }
  }
}

/** Expands a tuple spread onto `stack` or queues a bounded child spread, returning `shifted`. */
function stepOrderedRangeSpread(
  expr: Expression,
  cursor: { readonly idx: number; readonly shifted: boolean; readonly work: SpreadWork },
  state: {
    readonly pending: SpreadWork[];
    readonly seen: Set<ArrayLiteralExpression>;
    readonly stack: CallArgument[];
  },
): boolean {
  const tuple = unmutatedTuple(expr);
  if (tuple !== undefined && !state.seen.has(tuple)) {
    state.seen.add(tuple);
    state.stack.push(...asCallArguments(tuple.elements).toReversed());
    return cursor.shifted;
  }
  const subMin = cursor.shifted ? 0 : Math.max(0, cursor.work.minOffset - cursor.idx);
  state.pending.push({
    expression: expr,
    held: true,
    maxOffset: cursor.work.maxOffset - cursor.idx,
    minOffset: subMin,
    reordered: false,
  });
  return true;
}

/** Follows an array-list identifier's initializers, reassignments and indexed/pushed writes. */
function stepRangeIdentifier(
  ident: Identifier,
  work: SpreadWork,
  byHolder: ModuleArrayWrites,
  out: { readonly pending: SpreadWork[]; readonly results: ResolvedSlotItem[] },
): void {
  const holder = arrayHolderOf(ident);
  const selected = frameBindingOf(ident);
  const writes = holder === undefined ? undefined : byHolder.get(holder);
  const reordered = work.reordered || (writes?.reordered ?? false);
  const initialValues = selected === undefined ? [] : selectedInitialExpressions(ident, selected);
  const assignedSources = framedAssignedSources(ident);
  if (writes !== undefined) {
    applyHolderWrites(
      writes,
      { ident, initialValues, owner: holder?.declared, selected },
      { ...work, reordered },
      {
        onPositional: (expr) => {
          out.results.push({ expression: expr, spread: false });
        },
        pending: out.pending,
      },
    );
  }
  for (const source of assignedSources.toReversed()) {
    const projectedList = projectMemberKeys(source.value, source.keys);
    for (const projected of projectedList.toReversed()) {
      out.pending.push({ ...work, expression: projected, reordered });
    }
  }
  for (const initial of initialValues.toReversed()) {
    out.pending.push({ ...work, expression: initial, reordered });
  }
  if (writes === undefined && initialValues.length === 0 && assignedSources.length === 0) {
    out.results.push({ expression: ident, spread: true });
  }
}
