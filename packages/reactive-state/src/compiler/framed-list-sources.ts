import {
  type ArrayLiteralExpression,
  type Expression,
  isOmittedExpression,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenList } from './framed-selected-sources.ts';

/** What a list that is a source installs, the positions a field after it names left out. */

/** What a walk of a list has found, and where it has walked each list from. */
interface Walk {
  readonly hidden: ReadonlySet<string>;
  /** The last position a field after the list names: past it every entry is kept, wherever it is. */
  readonly last: number;
  readonly found: WrittenArrayElement[];
  readonly done: Map<Node, Map<string, number | undefined>>;
  /** The list each spread copies where it is written out, read once: reading it scans the program. */
  readonly spread: Map<Node, ArrayLiteralExpression | undefined>;
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
 * list, a spread of a written list counted by the length of that list; behind a spread whose
 * length the compile does not know they are unknown, and an entry there stays possible. A spread
 * that cannot be read stays a list.
 */
export function listSource(
  list: ArrayLiteralExpression,
  hidden: ReadonlySet<string>,
): WrittenArrayElement[] {
  const whole = [{ value: list, keys: [], array: true }];
  if (hidden.size === 0) return whole;
  const indices = [...hidden].filter((each) => INDEX.test(each)).map(Number);
  const last = Math.max(-1, ...indices);
  const walk: Walk = {
    hidden,
    last,
    found: [],
    done: new Map(),
    spread: new Map(),
    budget: VISITS,
  };
  walkList(list, walk, 0);
  return walk.budget < 0 ? whole : walk.found;
}

/** A position, none once it is past every position a field names: nothing there is left out. */
function positioned(walk: Walk, position: number | undefined): number | undefined {
  return position === undefined || position > walk.last ? undefined : position;
}

/** Walks a list from a position, none once it is unknown, and gives the position after it. */
function walkList(
  list: ArrayLiteralExpression,
  walk: Walk,
  start: number | undefined,
): number | undefined {
  const walks = walk.done.get(list) ?? new Map<string, number | undefined>();
  const from = String(positioned(walk, start));
  if (walks.has(from)) return walks.get(from);
  walk.done.set(list, walks.set(from, positioned(walk, start)));
  let position = positioned(walk, start);
  for (const each of list.elements) {
    position = walkEntry(each, walk, position);
    if (walk.budget < 0) break;
  }
  walks.set(from, position);
  return position;
}

/** One entry of a list at a position: the position after it. */
function walkEntry(each: Expression, walk: Walk, position: number | undefined): number | undefined {
  walk.budget -= 1;
  if (walk.budget < 0) return undefined;
  if (isSpreadElement(each)) {
    if (!walk.spread.has(each)) walk.spread.set(each, writtenList(each.expression));
    const inner = walk.spread.get(each);
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
