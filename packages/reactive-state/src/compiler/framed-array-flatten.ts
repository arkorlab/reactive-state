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
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';

/** Finite native flattening retains original scalar nodes and removes only written array layers. */
interface Segment {
  readonly views: readonly ArrayElementView[];
  readonly fixed: boolean;
}

interface Flattening {
  readonly value: Expression | undefined;
  readonly materialized: boolean;
  readonly depth: number;
  readonly array: boolean;
  readonly seen: ReadonlySet<Node>;
  /** Whether an array around it may change after it is written, and hold more than it writes. */
  readonly changed?: boolean;
}

/**
 * Known array layers flatten in order; unresolved lengths keep later possible selected values. An
 * unresolved depth keeps each uniform depth down to one past the receiver's written nesting
 * (`writtenArrayLayers`): one more layer leaves no position of an element that is no written array
 * known, as it may be an array of any length, and a deeper flat reads what that one does.
 */
export function flattenedArrayViews(
  receiver: Expression,
  index: number | undefined,
  depth: number | undefined,
  context: { readonly stable: (value: Expression) => boolean; readonly capture: Node },
): readonly ArrayElementView[] {
  if (depth !== undefined) return knownFlattenedArrayViews(receiver, index, depth, context);
  const layers = writtenArrayLayers(receiver);
  const views: ArrayElementView[] = [];
  for (let at = 0; at <= layers + 1; at++)
    views.push(...knownFlattenedArrayViews(receiver, index, at, context));
  return views;
}

/**
 * The most layers of written arrays one inside another that a receiver holds, each counted once however
 * many paths reach it: a depth past that flattens no more. An array spread into another adds no layer,
 * as a flat takes its elements whatever its depth, and arrays side by side add none.
 */
function writtenArrayLayers(receiver: Expression): number {
  const root = literalArray(receiver);
  if (root === undefined) return 0;
  const heights = new Map<ArrayLiteralExpression, number>();
  const active = new Set<ArrayLiteralExpression>();
  const pending: { readonly array: ArrayLiteralExpression; readonly done: boolean }[] = [
    { array: root, done: false },
  ];
  for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
    const { array } = task;
    if (task.done) {
      heights.set(array, layersWithin(array, heights));
      active.delete(array);
    } else if (!heights.has(array) && !active.has(array)) {
      active.add(array);
      pending.push({ array, done: true });
      for (const held of heldArrays(array)) pending.push({ array: held.array, done: false });
    }
  }
  return heights.get(root) ?? 0;
}

/** The layers an array holds, from the heights found for the arrays it holds in place. */
function layersWithin(array: ArrayLiteralExpression, heights: ReadonlyMap<Node, number>): number {
  let layers = 0;
  for (const held of heldArrays(array)) {
    const inside = heights.get(held.array);
    if (inside !== undefined) layers = Math.max(layers, held.spread ? inside : inside + 1);
  }
  return layers;
}

/** The written arrays an array holds, each with whether it is spread into it. */
function heldArrays(
  array: ArrayLiteralExpression,
): readonly { readonly array: ArrayLiteralExpression; readonly spread: boolean }[] {
  return array.elements.flatMap((element) => {
    const spread = isSpreadElement(element);
    const held = literalArray(spread ? element.expression : element);
    return held === undefined ? [] : [{ array: held, spread }];
  });
}

/** A fixed native depth keeps the original flattening and selected-position algorithm. */
function knownFlattenedArrayViews(
  receiver: Expression,
  index: number | undefined,
  depth: number,
  context: { readonly stable: (value: Expression) => boolean; readonly capture: Node },
): readonly ArrayElementView[] {
  const { stable, capture } = context;
  const segments: Segment[] = [];
  const pending: Flattening[] = [
    { value: receiver, depth, array: true, materialized: false, seen: new Set() },
  ];
  for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
    const unchanged = task.changed !== true;
    if (task.value === undefined) {
      segments.push({ views: [], fixed: unchanged });
      continue;
    }
    const value = unwrapped(task.value);
    const literal = literalArray(value);
    if (literal !== undefined && !task.seen.has(literal) && (task.array || task.depth > 0)) {
      const seen = new Set(task.seen).add(literal);
      const changed = !unchanged || !stable(value);
      if (!stable(value))
        segments.push({ views: [{ value, index: undefined, capture }], fixed: false });
      pending.push(
        ...arrayTasks(literal, task.array ? task.depth : task.depth - 1, seen, {
          changed,
          materialized: task.materialized,
        }),
      );
    } else if (task.array) {
      segments.push({ views: [{ value, index: undefined, capture }], fixed: false });
    } else {
      segments.push({
        views: [{ value, index: undefined, element: true, capture }],
        fixed: unchanged && (task.depth === 0 || literal !== undefined || definiteScalar(value)),
      });
    }
  }
  return selectedSegments(segments, index);
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
  seen: ReadonlySet<Node>,
  around: { readonly changed: boolean; readonly materialized: boolean },
): readonly Flattening[] {
  const { changed, materialized } = around;
  const tasks: Flattening[] = [];
  for (const element of array.elements.toReversed()) {
    if (isOmittedExpression(element)) {
      if (materialized)
        tasks.push({ value: undefined, array: false, materialized: false, depth, seen, changed });
      continue;
    }
    tasks.push({
      value: isSpreadElement(element) ? element.expression : element,
      array: isSpreadElement(element),
      materialized: isSpreadElement(element),
      depth,
      seen,
      changed,
    });
  }
  return tasks;
}

/** Whole constant aliases preserve finite array syntax and terminate at repeated original bindings. */
function literalArray(node: Expression): ArrayLiteralExpression | undefined {
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

/** Definite prefixes and suffixes exclude unrelated positions without inventing unresolved lengths. */
function selectedSegments(
  segments: readonly Segment[],
  index: number | undefined,
): readonly ArrayElementView[] {
  if (index === undefined) return segments.flatMap((segment) => segment.views);
  if (index < 0) return endSelectedSegments(segments, index);
  let remaining = index;
  for (let at = 0; at < segments.length; at++) {
    const segment = segments[at];
    if (segment === undefined) continue;
    if (!segment.fixed) return segments.slice(at).flatMap((each) => each.views);
    if (remaining === 0) return segment.views;
    remaining -= 1;
  }
  return [];
}

/** A fixed selected suffix remains exact despite unresolved segments before it. */
function endSelectedSegments(
  segments: readonly Segment[],
  index: number,
): readonly ArrayElementView[] {
  let remaining = -1 - index;
  for (const segment of segments.toReversed()) {
    if (!segment.fixed) return segments.flatMap((each) => each.views);
    if (remaining === 0) return segment.views;
    remaining -= 1;
  }
  return [];
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
