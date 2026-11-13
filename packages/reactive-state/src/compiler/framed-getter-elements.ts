import {
  type Expression,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isObjectLiteralExpression,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import {
  assignedNames,
  deletedNames,
  getterWrites,
  settingPrototype,
} from './framed-getter-writes.ts';
import { isSymbolKey, possibleKey, slotKey } from './framed-mutator-keys.ts';
import { namesThis } from './framed-this-functions.ts';

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
 * Whether a getter named `getter` may run before the copy reaches the slot, whichever field it
 * writes: a getter whose name is unknown, or an index lower than the slot's. A getter that is not
 * named by an index runs after every index.
 */
function runsBeforeSlot(getter: string | undefined, index: number | undefined): boolean {
  if (getter === undefined) return true;
  const own = indexOf(getter);
  return own !== undefined && (index === undefined || own < index);
}

/**
 * Whether a field is named by a symbol (`[Symbol.iterator]`): a copy reaches the symbols after
 * every array index and every other name, so what such a getter writes comes too late for any slot.
 * Other members of `Symbol`, `Symbol.length`, read numbers and strings, which `isSymbolKey` leaves out.
 */
function symbolKeyed(property: ObjectLiteralElementLike): boolean {
  return (
    !isSpreadAssignment(property) &&
    isComputedPropertyName(property.name) &&
    isSymbolKey(property.name.expression)
  );
}

/** What a field of a written object is where a getter assigns to it. */
type Slot = 'absent' | 'accessor' | 'data' | 'setter';

/**
 * What the field a getter assigns to may be: none, so that nothing the copy takes is changed (the
 * copy works from the keys the source had before it began); a value, which the assignment replaces; an
 * accessor, whose setter an assignment runs instead (a getter alone swallows it); a setter that names
 * `this`, which writes as it likes. A spread may give the name a value, and a field whose name is
 * computed may be any field: such a field adds what it may make of the field to what it may have
 * been, and the fields written after it, by name, make what they make of each. An accessor of the
 * object that deletes the name, or any name, may have removed the field before the assignment, which
 * then makes a value, or meets the prototype: the name may be absent as well.
 */
function slotsOf(literal: ObjectLiteralExpression | undefined, name: string): ReadonlySet<Slot> {
  if (literal === undefined) return new Set<Slot>(['data']);
  let slots = new Set<Slot>(['absent']);
  for (const property of literal.properties) {
    const key = isSpreadAssignment(property) ? undefined : writtenArrayKey(property.name);
    if (key !== name && key !== undefined) continue;
    const made = [...slots].map((each) => slotAfter(each, property));
    if (key === name) slots = new Set(made);
    else if (isSpreadAssignment(property)) slots.add('data');
    else for (const each of made) slots.add(each);
  }
  const deleted = deletedNames(literal);
  if (deleted.includes(undefined) || deleted.includes(name)) {
    slots.add('data');
    slots.add('absent');
  }
  return slots;
}

/** The slot a field makes of one that was: a setter or a getter makes an accessor, any other a value. */
function slotAfter(slot: Slot, property: ObjectLiteralElementLike): Slot {
  if (isSetAccessorDeclaration(property))
    return slot === 'setter' || namesThis(property) ? 'setter' : 'accessor';
  if (isGetAccessorDeclaration(property)) return slot === 'setter' ? 'setter' : 'accessor';
  return 'data';
}

/** Whether a written object has a setter that names `this`. */
function hasWritingSetter(literal: ObjectLiteralExpression | undefined): boolean {
  return (
    literal?.properties.some((each) => isSetAccessorDeclaration(each) && namesThis(each)) === true
  );
}

/**
 * Whether a getter of an assign source, or of a map of descriptors, writes where the compile cannot
 * follow and may run before the copy reaches the slot: it gives `this` on, or assigns to a field whose
 * setter names `this`.
 */
export function getterUnfollowed(
  property: ObjectLiteralElementLike,
  name: string | undefined,
  index: number | undefined,
): boolean {
  if (!isGetAccessorDeclaration(property) || symbolKeyed(property)) return false;
  if (!runsBeforeSlot(name, index)) return false;
  const assigned = assignedNames(property);
  if (assigned === undefined) return true;
  const literal = isObjectLiteralExpression(property.parent) ? property.parent : undefined;
  return assigned.some((written) => {
    const setter =
      written === undefined ? hasWritingSetter(literal) : slotsOf(literal, written).has('setter');
    return setter || reachesPrototype(literal, written);
  });
}

/**
 * Whether an assignment to a name may run a setter of the prototype the written object sets: the
 * object does not hold the name (or the name is computed), and the prototype is not `null`. What
 * that setter writes is not read.
 */
function reachesPrototype(
  literal: ObjectLiteralExpression | undefined,
  name: string | undefined,
): boolean {
  if (literal === undefined || !settingPrototype(literal)) return false;
  return name === undefined || slotsOf(literal, name).has('absent');
}

/**
 * The values a getter of an assign source, or of a map of descriptors, writes through `this` at the
 * slot: a value it gives a field of the object before the copy reaches the field, which only a
 * getter named by an index, or by a name the compile cannot read, does for a slot. A name a field
 * after the object sets hides the value, as it hides one written in the literal. A getter that
 * gives `this` on writes values the compile cannot follow: `getterUnfollowed` tells.
 */
export function getterWrittenValues(
  property: ObjectLiteralElementLike,
  name: string | undefined,
  index: number | undefined,
  hidden: ReadonlySet<string>,
): Expression[] {
  if (!isGetAccessorDeclaration(property) || symbolKeyed(property)) return [];
  const literal = isObjectLiteralExpression(property.parent) ? property.parent : undefined;
  const reaches = (written: string | undefined): boolean => {
    if (written === undefined) {
      const overwritten = index !== undefined && hidden.has(String(index));
      return runsBeforeSlot(name, index) && !overwritten;
    }
    const stored = possibleKey(written, index) && runsBefore(name, written);
    return stored && !hidden.has(written) && slotsOf(literal, written).has('data');
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
  const values = getterWrittenValues(property, name, index, hidden);
  const written = values.map((value) => ({ value, keys: [] }));
  if (!getterUnfollowed(property, name, index) || !isObjectLiteralExpression(property.parent))
    return written;
  return [...written, { value: property.parent, keys: [slotKey(index)] }];
}
