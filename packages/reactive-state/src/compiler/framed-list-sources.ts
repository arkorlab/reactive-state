import {
  type ArrayLiteralExpression,
  type Expression,
  isOmittedExpression,
  isSpreadElement,
  type Node,
  type SpreadElement,
} from 'typescript/ast';

import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenList } from './framed-selected-sources.ts';

/** What a list that is a source installs, the positions a field after it names left out. */

/** What a walk of a list has found, and where it has walked each list from. */
interface Walk {
  readonly hidden: ReadonlySet<string>;
  /** The positions a field after the list names, as indices. */
  readonly indices: readonly number[];
  /** The last position a field after the list names: past it every entry is kept, wherever it is. */
  readonly last: number;
  readonly found: WrittenArrayElement[];
  readonly kept: Set<Node>;
  readonly done: Map<Node, Map<number, number | undefined>>;
  /** The list each spread copies where it is written out, read once: reading it scans the program. */
  readonly spread: Map<Node, ArrayLiteralExpression | undefined>;
  readonly lengths: Map<Node, number | undefined>;
  /** The entries left to visit before the walk gives up and keeps the list whole. */
  budget: number;
}

/** The entries a walk visits: lists that share lists grow with the product of their lengths. */
const VISITS = 10_000;

/** Whether a name is the text of an array index. */
const INDEX = /^(?:0|[1-9]\d*)$/u;

/**
 * The elements a list source installs: the list whole where no field after it names a position, the
 * entries at the other positions where one does. The positions are those the entries take in the
 * list, a spread of a written list counted by the length of that list; a list that holds none of
 * the positions is kept whole where it stands. Behind a spread whose length the compile does not
 * know the positions are unknown, and an entry there stays possible. A spread that cannot be read
 * stays a list.
 */
export function listSource(
  list: ArrayLiteralExpression,
  hidden: ReadonlySet<string>,
): WrittenArrayElement[] {
  const whole = [{ value: list, keys: [], array: true }];
  if (hidden.size === 0) return whole;
  const indices = [...hidden].filter((each) => INDEX.test(each)).map(Number);
  const walk: Walk = {
    hidden,
    indices,
    last: Math.max(-1, ...indices),
    found: [],
    kept: new Set(),
    done: new Map(),
    spread: new Map(),
    lengths: new Map(),
    budget: VISITS,
  };
  walkList(list, walk, 0);
  return walk.budget < 0 ? whole : walk.found;
}

/** A position, none once it is past every position a field names: nothing there is left out. */
function positioned(walk: Walk, position: number | undefined): number | undefined {
  return position === undefined || position > walk.last ? undefined : position;
}

/** The list a spread copies where it is written out, read once. */
function spreadList(each: SpreadElement, walk: Walk): ArrayLiteralExpression | undefined {
  if (!walk.spread.has(each)) walk.spread.set(each, writtenList(each.expression));
  return walk.spread.get(each);
}

/** What a list stands for where its entries are all kept: itself, once. */
function keepWhole(walk: Walk, list: ArrayLiteralExpression): void {
  if (walk.kept.has(list)) return;
  walk.kept.add(list);
  walk.found.push({ value: list, keys: [], array: true });
}

/** How many entries a list takes up, a spread of a written list counted by its own; none if unknown. */
function lengthOf(list: ArrayLiteralExpression, walk: Walk): number | undefined {
  if (walk.lengths.has(list)) return walk.lengths.get(list);
  walk.lengths.set(list, undefined);
  let length = 0;
  for (const each of list.elements) {
    if (!isSpreadElement(each)) {
      length += 1;
      continue;
    }
    const inner = spreadList(each, walk);
    const counted = inner === undefined ? undefined : lengthOf(inner, walk);
    if (counted === undefined) return undefined;
    length += counted;
  }
  walk.lengths.set(list, length);
  return length;
}

/** Walks a list from a position, none once it is unknown, and gives the position after it. */
function walkList(
  list: ArrayLiteralExpression,
  walk: Walk,
  start: number | undefined,
): number | undefined {
  const position = positioned(walk, start);
  if (position === undefined) {
    keepWhole(walk, list);
    return undefined;
  }
  const walks = walk.done.get(list) ?? new Map<number, number | undefined>();
  if (walks.has(position)) return walks.get(position);
  walk.done.set(list, walks.set(position, position));
  const length = lengthOf(list, walk);
  let after: number | undefined = position;
  if (
    length === undefined ||
    walk.indices.some((each) => each >= position && each < position + length)
  ) {
    for (const each of list.elements) {
      after = walkEntry(each, walk, after);
      if (walk.budget < 0) break;
    }
  } else {
    keepWhole(walk, list);
    after = positioned(walk, position + length);
  }
  walks.set(position, after);
  return after;
}

/** One entry of a list at a position: the position after it. */
function walkEntry(each: Expression, walk: Walk, position: number | undefined): number | undefined {
  walk.budget -= 1;
  if (walk.budget < 0) return undefined;
  if (isSpreadElement(each)) {
    const inner = spreadList(each, walk);
    if (inner !== undefined) return walkList(inner, walk, position);
    walk.found.push({ value: each.expression, keys: [], array: true });
    return undefined;
  }
  if (position === undefined) {
    if (!isOmittedExpression(each)) walk.found.push({ value: each, keys: [] });
    return undefined;
  }
  const kept = !walk.hidden.has(String(position)) && !isOmittedExpression(each);
  if (kept) walk.found.push({ value: each, keys: [] });
  return positioned(walk, position + 1);
}
