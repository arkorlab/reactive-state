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

/** What a read of a descriptor has hidden: the names a field after it sets, and those a descriptor inheriting it sets. */
interface Hiding {
  readonly data: ReadonlySet<string>;
  readonly own?: ReadonlySet<string> | undefined;
}

/**
 * The elements the getters of a written descriptor write into its `value` or its `get`, where their
 * names put them before those fields, or may: the right of an assignment to a member of `this`, a
 * function that is the new `get` read as one. A getter that a later field of the descriptor replaces
 * never runs, and one a field after the descriptor hides still does; a name a field after the
 * descriptor sets hides what was written to it. A descriptor a spread copies has every getter run,
 * whatever its name, and a write counts only for a field the copy reaches after the getter. A
 * prototype of a descriptor has its getters run on the descriptor, unless a field of the descriptor
 * of the same name hides them, and what they write replaces the fields of the descriptor. A getter
 * that gives `this` on writes values the compile cannot follow: the descriptor's value is unknown.
 */
export function descriptorRewrites(
  descriptor: ObjectLiteralExpression,
  hidden: Hiding,
  copied: boolean,
): WrittenArrayElement[] {
  const replacing = new Set<string>();
  const found: WrittenArrayElement[] = [];
  const order = copied ? copyOrder(descriptor) : undefined;
  const hides = new Set([...hidden.data].filter((each) => hidden.own?.has(each) !== true));
  for (const property of descriptor.properties.toReversed()) {
    const name = isSpreadAssignment(property) ? undefined : writtenArrayKey(property.name);
    const read = copied || name === undefined || READ_BEFORE_VALUE.has(name);
    const shadowed = name !== undefined && hidden.own?.has(name) === true;
    const live = name === undefined || (!replacing.has(name) && read && !shadowed);
    if (live && isGetAccessorDeclaration(property))
      found.push(...rewrites(descriptor, property, { hides, order }));
    if (name !== undefined && !isSetAccessorDeclaration(property)) replacing.add(name);
  }
  return found;
}

/**
 * The names of a descriptor in the order a copy reaches them: an array index first, then the other
 * names as they were first written. None where a spread or a name the compile cannot read makes the
 * order unknown.
 */
function copyOrder(descriptor: ObjectLiteralExpression): readonly string[] | undefined {
  const names: string[] = [];
  for (const property of descriptor.properties) {
    if (isSpreadAssignment(property)) return undefined;
    const name = writtenArrayKey(property.name);
    if (name === undefined) return undefined;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Whether a copy reaches the field after the getter that is named `getter`; any, where the order is unknown. */
function copiedAfter(
  order: readonly string[] | undefined,
  getter: string | undefined,
  field: string,
): boolean {
  if (order === undefined || getter === undefined) return true;
  const at = order.indexOf(field);
  if (at === -1) return false;
  return /^(?:0|[1-9]\d*)$/u.test(getter) || at > order.indexOf(getter);
}

/** What decides which writes of a getter count: the names a field after hides, and the order of a copy. */
interface Counting {
  readonly hides: ReadonlySet<string>;
  readonly order: readonly string[] | undefined;
}

/** Whether what a getter named `getter` writes to the field is read: no field after hides it, and a copy reaches it. */
function reachedBy(counting: Counting, getter: string | undefined, field: string): boolean {
  return !counting.hides.has(field) && copiedAfter(counting.order, getter, field);
}

/** The elements one getter writes into the `value` or the `get` of the descriptor it runs on. */
function rewrites(
  descriptor: ObjectLiteralExpression,
  getter: ObjectLiteralElementLike,
  counting: Counting,
): WrittenArrayElement[] {
  if (!isGetAccessorDeclaration(getter)) return [];
  const writes = getterWrites(getter);
  const name = writtenArrayKey(getter.name);
  if (writes === undefined) {
    const reaches = ['value', 'get'].some((one) => reachedBy(counting, name, one));
    return reaches ? [{ value: descriptor, keys: ['value'] }] : [];
  }
  return writes.flatMap((each) => {
    const field = each.name;
    const fields = field === undefined ? ['value', 'get'] : [field];
    const counts = fields.some(
      (one) => (one === 'value' || one === 'get') && reachedBy(counting, name, one),
    );
    if (!counts) return [];
    const value = field === 'get' ? [] : [{ value: each.value, keys: [] }];
    const get = field === 'value' ? [] : functionReturns(each.value, new Set(), selectedValues);
    return [...value, ...get];
  });
}

/** Whether the getter at `at` never runs: a field after it gives its name a value that is no accessor. */
export function neverRuns(descriptor: ObjectLiteralExpression, at: number): boolean {
  const getter = descriptor.properties[at];
  const key =
    getter === undefined || isSpreadAssignment(getter) ? undefined : writtenArrayKey(getter.name);
  if (key === undefined) return false;
  return descriptor.properties.slice(at + 1).some((each) => {
    const accessor = isGetAccessorDeclaration(each) || isSetAccessorDeclaration(each);
    return !isSpreadAssignment(each) && !accessor && writtenArrayKey(each.name) === key;
  });
}
