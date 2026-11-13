import {
  type Expression,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isTypeNode,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { getterWrites } from './framed-getter-writes.ts';
import { possibleKey, slotKey } from './framed-mutator-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';

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

/** The global that names the well-known symbols. */
const SYMBOLS: ReadonlySet<string> = new Set(['Symbol']);

/**
 * Whether a field is named by a well-known symbol (`[Symbol.iterator]`): a copy reaches the symbols after
 * every array index and every other name, so what such a getter writes comes too late for any slot.
 */
function symbolKeyed(property: ObjectLiteralElementLike): boolean {
  if (isSpreadAssignment(property) || !isComputedPropertyName(property.name)) return false;
  const key = unwrapped(property.name.expression);
  return isPropertyAccessExpression(key) && framedNativeConstructor(key.expression, SYMBOLS);
}

/** What a field of a written object is where a getter assigns to it. */
type Slot = 'absent' | 'accessor' | 'data' | 'setter';

/**
 * What the field a getter assigns to is: none, so that nothing the copy takes is changed (the copy
 * works from the keys the source had before it began); a value, which the assignment replaces; an
 * accessor, whose setter an assignment runs instead (a getter alone swallows it); a setter that names
 * `this`, which writes as it likes. A spread or a name that is computed leaves it a value.
 */
function slotOf(literal: ObjectLiteralExpression | undefined, name: string): Slot {
  if (literal === undefined) return 'data';
  let slot = 'absent' as Slot;
  for (const property of literal.properties) {
    const key = isSpreadAssignment(property) ? undefined : writtenArrayKey(property.name);
    if (key === undefined) return 'data';
    if (key === name) slot = slotAfter(slot, property);
  }
  return slot;
}

/** The slot a field makes of one that was: a setter or a getter makes an accessor, any other a value. */
function slotAfter(slot: Slot, property: ObjectLiteralElementLike): Slot {
  if (isSetAccessorDeclaration(property))
    return slot === 'setter' || namesThis(property) ? 'setter' : 'accessor';
  if (isGetAccessorDeclaration(property)) return slot === 'setter' ? 'setter' : 'accessor';
  return 'data';
}

/** Whether a function names `this` anywhere in its body. */
function namesThis(fn: Node): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (node.kind === SyntaxKind.ThisKeyword) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
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
  const writes = getterWrites(property);
  if (writes === undefined) return true;
  const literal = isObjectLiteralExpression(property.parent) ? property.parent : undefined;
  return writes.some((each) => {
    return each.name === undefined
      ? hasWritingSetter(literal)
      : slotOf(literal, each.name) === 'setter';
  });
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
    return stored && !hidden.has(written) && slotOf(literal, written) === 'data';
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
