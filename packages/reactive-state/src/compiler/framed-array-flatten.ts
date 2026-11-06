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

/** Flat mapping skips absent input slots rather than keeping map's output holes. */
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
  return index === undefined ? undefined : (positions[index] ?? Infinity);
}
