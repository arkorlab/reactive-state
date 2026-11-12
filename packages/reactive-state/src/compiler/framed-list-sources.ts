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
  readonly found: WrittenArrayElement[];
  readonly done: Map<Node, Map<string, number | undefined>>;
}

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
  if (hidden.size === 0) return [{ value: list, keys: [], array: true }];
  const walk: Walk = { hidden, found: [], done: new Map() };
  walkList(list, walk, 0);
  return walk.found;
}

/** Walks a list from a position, none once it is unknown, and gives the position after it. */
function walkList(
  list: ArrayLiteralExpression,
  walk: Walk,
  start: number | undefined,
): number | undefined {
  const walks = walk.done.get(list) ?? new Map<string, number | undefined>();
  const from = String(start);
  if (walks.has(from)) return walks.get(from);
  walk.done.set(list, walks.set(from, start));
  let position = start;
  for (const each of list.elements) position = walkEntry(each, walk, position);
  walks.set(from, position);
  return position;
}

/** One entry of a list at a position: the position after it. */
function walkEntry(each: Expression, walk: Walk, position: number | undefined): number | undefined {
  if (isSpreadElement(each)) {
    const inner = writtenList(each.expression);
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
  return position + 1;
}
