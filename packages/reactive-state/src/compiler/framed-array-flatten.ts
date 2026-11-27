import {
  type ArrayLiteralExpression,
  type Expression,
  type Node,
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { joinedRuns, segmentRun, selectedRunViews, type Run } from './framed-array-flatten-runs.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';

/** Finite native flattening retains original scalar nodes and removes only written array layers. */
interface Flattening {
  readonly value: Expression | undefined;
  readonly materialized: boolean;
  readonly depth: number;
  readonly array: boolean;
  /** Whether an array around it may change after it is written, and hold more than it writes. */
  readonly changed?: boolean;
}

/** Known array layers flatten in order; unresolved lengths keep later possible selected values. */
export function flattenedArrayViews(
  receiver: Expression,
  index: number | undefined,
  depth: number | undefined,
  context: { readonly stable: (value: Expression) => boolean; readonly capture: Node },
): readonly ArrayElementView[] {
  if (depth !== undefined) return knownFlattenedArrayViews(receiver, index, depth, context);
  const count = writtenArrayCount(receiver);
  const views: ArrayElementView[] = [];
  for (let at = 0; at <= count; at++)
    views.push(...knownFlattenedArrayViews(receiver, index, at, context));
  return views;
}

/** A finite unknown primitive depth retains each uniform written flattening depth. */
function writtenArrayCount(receiver: Expression): number {
  const seen = new Set<ArrayLiteralExpression>();
  const pending = [receiver];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const array = literalArray(next);
    if (array === undefined || seen.has(array)) continue;
    seen.add(array);
    for (const element of array.elements)
      pending.push(isSpreadElement(element) ? element.expression : element);
  }
  return seen.size;
}

/** A fixed native depth keeps the original flattening and selected-position algorithm. */
function knownFlattenedArrayViews(
  receiver: Expression,
  index: number | undefined,
  depth: number,
  context: { readonly stable: (value: Expression) => boolean; readonly capture: Node },
): readonly ArrayElementView[] {
  const { stable, capture } = context;
  const walk: Walk = {
    stable,
    capture,
    active: new Set(),
    shared: sharedArrays(receiver),
    memo: new Map(),
  };
  const root: Expansion = {
    literal: undefined,
    key: '',
    marker: undefined,
    parts: [],
    pending: [{ value: receiver, depth, array: true, materialized: false }],
  };
  const stack = [root];
  for (let top: Expansion | undefined = root; top !== undefined; top = stack.at(-1)) {
    const task = top.pending.pop();
    if (task !== undefined) {
      const step = flattening(task, walk);
      if ('pending' in step) stack.push(step);
      else top.parts.push(step);
      continue;
    }
    stack.pop();
    const parent = stack.at(-1);
    if (parent === undefined) break;
    finished(top, parent, walk);
  }
  return selectedRunViews(joinedRuns(root.parts), index);
}

/** What the walk of a receiver shares between the places an array stands: what it has read of each. */
interface Walk {
  readonly stable: (value: Expression) => boolean;
  readonly capture: Node;
  /** The written arrays being expanded: the one each place stands in, and those around it. */
  readonly active: Set<ArrayLiteralExpression>;
  /** The arrays that stand in more than one place, none where an array holds itself, which share nothing. */
  readonly shared: ReadonlySet<ArrayLiteralExpression> | undefined;
  /** What each shared array gave where it stood, by the place's depth, spread and change. */
  readonly memo: Map<ArrayLiteralExpression, Map<string, Run>>;
}

/** A written array whose elements are expanded, and the runs they gave so far. */
interface Expansion {
  /** The array, and what it gives where it stands: of the depth, spread and change of the place. */
  readonly literal: ArrayLiteralExpression | undefined;
  readonly key: string;
  /** Where the array may change, the view of the array itself, which comes before its elements. */
  readonly marker: Run | undefined;
  readonly pending: Flattening[];
  readonly parts: Run[];
}

/** One place of a flattening: a run of one segment, or the written array whose elements it holds. */
function flattening(task: Flattening, walk: Walk): Run | Expansion {
  const unchanged = task.changed !== true;
  if (task.value === undefined) return segmentRun([], unchanged);
  const value = unwrapped(task.value);
  const literal = literalArray(value);
  if (literal !== undefined && !walk.active.has(literal) && (task.array || task.depth > 0))
    return expansion(task, { value, literal, unchanged }, walk);
  const { capture } = walk;
  if (task.array) return segmentRun([{ value, index: undefined, capture }], false);
  return segmentRun(
    [{ value, index: undefined, element: true, capture }],
    unchanged && (task.depth === 0 || literal !== undefined || definiteScalar(value)),
  );
}

/**
 * A written array's elements as a run: the one they gave where the array stood before, at the same
 * depth, spread and change, if it stands in more than one place (`sharedArrays`). Its elements are
 * the same wherever it stands, and a run counts the positions without copying them, so each is read
 * once however many paths reach the array.
 */
function expansion(
  task: Flattening,
  found: {
    readonly value: Expression;
    readonly literal: ArrayLiteralExpression;
    readonly unchanged: boolean;
  },
  walk: Walk,
): Run | Expansion {
  const { value, literal, unchanged } = found;
  const stable = walk.stable(value);
  const changed = !unchanged || !stable;
  const depth = task.array ? task.depth : task.depth - 1;
  const marker = stable
    ? undefined
    : segmentRun([{ value, index: undefined, capture: walk.capture }], false);
  const key = `${depth} ${task.materialized} ${changed}`;
  const known = walk.memo.get(literal)?.get(key);
  if (known !== undefined) return marker === undefined ? known : joinedRuns([marker, known]);
  const around = { changed, materialized: task.materialized };
  walk.active.add(literal);
  return {
    literal,
    key,
    marker,
    parts: [],
    pending: [...arrayTasks(literal, depth, around)],
  };
}

/** An expanded array's run joins those of the array it stands in, and is kept for where it stands again. */
function finished(done: Expansion, parent: Expansion, walk: Walk): void {
  const { literal, key, marker } = done;
  const run = joinedRuns(done.parts);
  if (literal !== undefined) {
    walk.active.delete(literal);
    if (walk.shared?.has(literal) === true) {
      const kept = walk.memo.get(literal) ?? new Map<string, Run>();
      walk.memo.set(literal, kept.set(key, run));
    }
  }
  parent.parts.push(marker === undefined ? run : joinedRuns([marker, run]));
}

/**
 * The written arrays the receiver holds, in any element, that stand in more than one place: the
 * ones whose elements a walk reads again. None if one holds itself, as `const a = [...a]` does,
 * which no run of the program reaches: an array met again on the path is then cut, and what an
 * array gives depends on the path to it, so that nothing is shared.
 */
function sharedArrays(receiver: Expression): ReadonlySet<ArrayLiteralExpression> | undefined {
  const root = literalArray(receiver);
  const shared = new Set<ArrayLiteralExpression>();
  if (root === undefined) return shared;
  const settled = new Set<ArrayLiteralExpression>();
  const around = new Set<ArrayLiteralExpression>();
  const pending = [{ array: root, done: false }];
  for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
    const { array } = task;
    if (task.done) {
      around.delete(array);
      settled.add(array);
      continue;
    }
    if (around.has(array)) return undefined;
    if (settled.has(array)) {
      shared.add(array);
      continue;
    }
    around.add(array);
    pending.push({ array, done: true });
    for (const held of arraysWithin(array)) pending.push({ array: held, done: false });
  }
  return shared;
}

/** The written arrays an array holds in its elements, spread into it or not. */
function arraysWithin(array: ArrayLiteralExpression): readonly ArrayLiteralExpression[] {
  return array.elements.flatMap((element) => {
    const held = literalArray(isSpreadElement(element) ? element.expression : element);
    return held === undefined ? [] : [held];
  });
}

/** A flatMap return flattens its direct written array elements once; scalar returns remain scalar. */
export function flattenedReturnValues(value: Expression): readonly Expression[] | undefined {
  const array = literalArray(value);
  if (array === undefined || array.elements.some((element) => isSpreadElement(element)))
    return undefined;
  return array.elements.filter((element) => !isOmittedExpression(element));
}

/** A finite return-array spread materializes its holes while direct return holes stay omitted. */
export function expandedReturnValues(
  value: Expression,
  stable: (value: Expression) => boolean,
): readonly Expression[] | undefined {
  const found: Expression[] = [];
  const pending: {
    readonly value: Expression;
    readonly array: boolean;
    readonly materialized: boolean;
    readonly seen: ReadonlySet<Node>;
  }[] = [{ value, array: true, materialized: false, seen: new Set() }];
  for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
    if (!task.array) {
      if (task.materialized || !isOmittedExpression(task.value)) found.push(task.value);
      continue;
    }
    const array = literalArray(task.value);
    if (array === undefined || task.seen.has(array) || !stable(task.value)) return undefined;
    const seen = new Set(task.seen).add(array);
    for (const each of array.elements.toReversed()) {
      pending.push({
        value: isSpreadElement(each) ? each.expression : each,
        array: isSpreadElement(each),
        materialized: task.materialized || isSpreadElement(each),
        seen,
      });
    }
  }
  return found;
}

/**
 * Written literal spreads contribute elements before their containing array's flattening step; of
 * an array that may change after it is written (`changed`), no element's position is fixed.
 */
function arrayTasks(
  array: ArrayLiteralExpression,
  depth: number,
  around: { readonly changed: boolean; readonly materialized: boolean },
): readonly Flattening[] {
  const { changed, materialized } = around;
  const tasks: Flattening[] = [];
  for (const element of array.elements.toReversed()) {
    if (isOmittedExpression(element)) {
      if (materialized)
        tasks.push({ value: undefined, array: false, materialized: false, depth, changed });
      continue;
    }
    tasks.push({
      value: isSpreadElement(element) ? element.expression : element,
      array: isSpreadElement(element),
      materialized: isSpreadElement(element),
      depth,
      changed,
    });
  }
  return tasks;
}

/** What each node of a file stands for, as `literalArray` reads it: a node reads the same each time. */
const LITERALS = new WeakMap<Node, ArrayLiteralExpression | null>();

/** Whole constant aliases preserve finite array syntax and terminate at repeated original bindings. */
function literalArray(node: Expression): ArrayLiteralExpression | undefined {
  const known = LITERALS.get(node);
  if (known !== undefined) return known ?? undefined;
  const array = writtenLiteralArray(node);
  LITERALS.set(node, array ?? null);
  return array;
}

function writtenLiteralArray(node: Expression): ArrayLiteralExpression | undefined {
  let value = unwrapped(node);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return undefined;
    const binding = selected.binding;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isArrayLiteralExpression(value) ? value : undefined;
}

/** Ordinary object and primitive syntax cannot be flattened as an Array. */
function definiteScalar(value: Expression): boolean {
  return (
    isObjectLiteralExpression(value) ||
    [
      SyntaxKind.BigIntLiteral,
      SyntaxKind.FalseKeyword,
      SyntaxKind.NoSubstitutionTemplateLiteral,
      SyntaxKind.NullKeyword,
      SyntaxKind.NumericLiteral,
      SyntaxKind.StringLiteral,
      SyntaxKind.TrueKeyword,
    ].includes(value.kind)
  );
}

/**
 * Flat mapping skips absent input slots rather than keeping map's output holes. A position from the
 * end counts the slots the receiver holds, as one from the start does: the last is the last held.
 */
export function flatMappedSourceIndex(
  receiver: Expression,
  index: number | undefined,
): number | undefined {
  const array = literalArray(receiver);
  if (array === undefined || array.elements.some((element) => isSpreadElement(element)))
    return undefined;
  const positions = array.elements.flatMap((element, position) =>
    isOmittedExpression(element) ? [] : [position],
  );
  if (positions.length === 0) return Infinity;
  if (index === undefined) return undefined;
  return positions[index < 0 ? positions.length + index : index] ?? Infinity;
}
