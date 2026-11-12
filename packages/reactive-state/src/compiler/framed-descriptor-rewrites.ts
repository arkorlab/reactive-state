import {
  isGetAccessorDeclaration,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { getterWrites } from './framed-getter-writes.ts';
import { functionReturns } from './framed-mutator-getters.ts';
import { selectedValues } from './framed-selected-sources.ts';

/** What a getter of a descriptor writes into the fields the conversion has yet to read. */

/**
 * The attributes a descriptor's conversion reads before `value` and `get`, in the order it reads
 * them: a getter named by one of them runs first, and may give those fields another value.
 */
const READ_BEFORE_VALUE: ReadonlySet<string> = new Set([
  'configurable',
  'enumerable',
  'value',
  'writable',
]);

/**
 * The elements the getters of a written descriptor write into its `value` or its `get`, where their
 * names put them before those fields, or may: the right of an assignment to a member of `this`, a
 * function that is the new `get` read as one. A getter that a later field of the descriptor replaces
 * never runs, and one a field after the descriptor hides still does; a name a field after the
 * descriptor sets hides what was written to it. A descriptor a spread copies has every getter run,
 * whatever its name. A getter that gives `this` on writes values the compile counts for none.
 */
export function descriptorRewrites(
  descriptor: ObjectLiteralExpression,
  hidden: ReadonlySet<string>,
  copied: boolean,
): WrittenArrayElement[] {
  const replacing = new Set<string>();
  const found: WrittenArrayElement[] = [];
  for (const property of descriptor.properties.toReversed()) {
    const name = isSpreadAssignment(property) ? undefined : writtenArrayKey(property.name);
    const read = copied || name === undefined || READ_BEFORE_VALUE.has(name);
    const live = name === undefined || (!replacing.has(name) && read);
    if (live && isGetAccessorDeclaration(property)) found.push(...rewrites(property, hidden));
    if (name !== undefined && !isSetAccessorDeclaration(property)) replacing.add(name);
  }
  return found;
}

/** The elements one getter writes into the `value` or the `get` of the descriptor it runs on. */
function rewrites(
  getter: ObjectLiteralElementLike,
  hidden: ReadonlySet<string>,
): WrittenArrayElement[] {
  if (!isGetAccessorDeclaration(getter)) return [];
  return (getterWrites(getter) ?? []).flatMap((each) => {
    const field = each.name;
    if (field !== undefined && ((field !== 'value' && field !== 'get') || hidden.has(field)))
      return [];
    const value = field === 'get' ? [] : [{ value: each.value, keys: [] }];
    const get = field === 'value' ? [] : functionReturns(each.value, new Set(), selectedValues);
    return [...value, ...get];
  });
}
