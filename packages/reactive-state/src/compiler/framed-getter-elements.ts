import {
  type Expression,
  isGetAccessorDeclaration,
  type ObjectLiteralElementLike,
} from 'typescript/ast';

import type { WrittenArrayElement } from './framed-array-elements.ts';
import { getterWrites } from './framed-getter-writes.ts';
import { possibleKey } from './framed-mutator-keys.ts';

/** The values the getters of a source write through `this` before the fields after them are read. */

/** The text of an array index, which a copy reaches before any other name, in ascending order. */
const INDEX_NAME = /^(?:0|[1-9]\d*)$/u;

/** The last array index: a larger integer names an ordinary property. */
const LAST_INDEX = 4_294_967_294;

function indexOf(name: string): number | undefined {
  return INDEX_NAME.test(name) && Number(name) <= LAST_INDEX ? Number(name) : undefined;
}

/**
 * Whether a getter named `getter` runs before the copy reaches the field `written`: every array
 * index comes before any other name, and the indices in ascending order. A getter whose name is
 * unknown may run at any point.
 */
function runsBefore(getter: string | undefined, written: string): boolean {
  if (getter === undefined) return true;
  const own = indexOf(getter);
  if (own === undefined) return false;
  const reached = indexOf(written);
  return reached === undefined || own < reached;
}

/**
 * The values a getter of an assign source, or of a map of descriptors, writes through `this` at the
 * slot: a value it gives a field of the object before the copy reaches the field, which only a
 * getter named by an index, or by a name the compile cannot read, does for a slot. A name a field
 * after the object sets hides the value, as it hides one written in the literal. A getter that
 * gives `this` on writes values the compile cannot follow, which it counts for none.
 */
export function getterWrittenValues(
  property: ObjectLiteralElementLike,
  name: string | undefined,
  index: number | undefined,
  hidden: ReadonlySet<string>,
): Expression[] {
  if (!isGetAccessorDeclaration(property)) return [];
  const reaches = (written: string | undefined): boolean => {
    return (
      written === undefined ||
      (possibleKey(written, index) && runsBefore(name, written) && !hidden.has(written))
    );
  };
  return (getterWrites(property) ?? [])
    .filter((each) => reaches(each.name))
    .map((each) => each.value);
}

/** The elements those values are, written to an assign source. */
export function getterElements(
  property: ObjectLiteralElementLike,
  name: string | undefined,
  index: number | undefined,
  hidden: ReadonlySet<string>,
): WrittenArrayElement[] {
  return getterWrittenValues(property, name, index, hidden).map((value) => ({ value, keys: [] }));
}
