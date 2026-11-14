import {
  type Expression,
  isComputedPropertyName,
  isExpression,
  isGetAccessorDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { getterWrites, inheritedDeletions } from './framed-getter-writes.ts';
import { functionReturns } from './framed-mutator-getters.ts';
import { selectedValues } from './framed-selected-sources.ts';
import { namesThis } from './framed-this-functions.ts';

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
  const mode: Mode = copied ? 'copy' : 'convert';
  const order = copied && copiedInline(descriptor) ? copyOrder(descriptor) : undefined;
  const hides = new Set([...hidden.data].filter((each) => hidden.own?.has(each) !== true));
  for (const property of descriptor.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      for (const each of copiedNames(property.expression)) replacing.add(each);
      continue;
    }
    const name = writtenArrayKey(property.name);
    const live = name === undefined || runs(name, { copied, replacing, own: hidden.own });
    const inherited = hidden.own !== undefined;
    if (live && isGetAccessorDeclaration(property))
      found.push(...rewrites(descriptor, property, { hides, order, mode, inherited }));
    if (name !== undefined && !isSetAccessorDeclaration(property) && !setsProto(property))
      replacing.add(name);
  }
  return found;
}

/**
 * Whether a getter of a name runs: a field after it does not replace it, a conversion reads it before
 * `value` or a copy reaches it at all, and a field of the descriptor that inherits this one does not
 * hide it.
 */
function runs(
  name: string,
  context: {
    readonly copied: boolean;
    readonly replacing: ReadonlySet<string>;
    readonly own: ReadonlySet<string> | undefined;
  },
): boolean {
  const read = context.copied || READ_BEFORE_VALUE.has(name);
  return read && !context.replacing.has(name) && context.own?.has(name) !== true;
}

/**
 * The names of a descriptor in the order a copy reaches them: an array index first, in order, then the
 * other names as they were first written. None where a spread or a name the compile cannot read makes
 * the order unknown.
 */
function copyOrder(descriptor: ObjectLiteralExpression): readonly string[] | undefined {
  const names: string[] = [];
  for (const property of descriptor.properties) {
    if (isSpreadAssignment(property)) return undefined;
    if (setsProto(property)) continue;
    const name = writtenArrayKey(property.name);
    if (name === undefined) return undefined;
    if (!names.includes(name)) names.push(name);
  }
  return [
    ...names.filter((each) => isIndex(each)).toSorted((one, two) => Number(one) - Number(two)),
    ...names.filter((each) => !isIndex(each)),
  ];
}

/** The last array index: a larger integer names an ordinary property. */
const LAST_INDEX = 4_294_967_294;

/** Whether a name is the text of an array index. */
function isIndex(name: string): boolean {
  return /^(?:0|[1-9]\d*)$/u.test(name) && Number(name) <= LAST_INDEX;
}

/**
 * Whether a descriptor is written where the copy is: it is the operand of the spread itself. A
 * descriptor a name holds may have fields that were added to it, which the written fields do not tell.
 */
function copiedInline(descriptor: ObjectLiteralExpression): boolean {
  let at: Node = descriptor;
  while (isExpression(at.parent) && unwrapped(at.parent) === descriptor) at = at.parent;
  return isSpreadAssignment(at.parent);
}

/**
 * The names a later spread surely copies: those of a written object that holds no getter, which could
 * delete one before the copy reaches it, and those of the spreads such an object holds.
 */
function copiedNames(copied: Expression): readonly string[] {
  const value = unwrapped(copied);
  if (!isObjectLiteralExpression(value)) return [];
  if (value.properties.some((each) => isGetAccessorDeclaration(each))) return [];
  return value.properties.flatMap((each) => {
    if (isSpreadAssignment(each)) return copiedNames(each.expression);
    const name = setsProto(each) ? undefined : writtenArrayKey(each.name);
    return name === undefined ? [] : [name];
  });
}

/** Whether a copy reaches the field after the getter that is named `getter`; any, where the order is unknown. */
function copiedAfter(
  order: readonly string[] | undefined,
  getter: string | undefined,
  field: string,
): boolean {
  if (order === undefined || getter === undefined) return true;
  const at = order.indexOf(field);
  return at !== -1 && at > order.indexOf(getter);
}

/** The order a conversion reads the fields of a descriptor in. */
const READ_ORDER: readonly string[] = [
  'enumerable',
  'configurable',
  'value',
  'writable',
  'get',
  'set',
];

/** Whether a conversion reads the field after the getter that is named `getter` has run. */
function readAfter(getter: string | undefined, field: string): boolean {
  if (getter === undefined) return true;
  const own = READ_ORDER.indexOf(getter);
  return own !== -1 && READ_ORDER.indexOf(field) > own;
}

/** What decides which writes of a getter count: the names a field after hides, and the order of a copy. */
interface Counting {
  readonly hides: ReadonlySet<string>;
  readonly order: readonly string[] | undefined;
  readonly mode: Mode;
  /** The getter runs on a descriptor that inherits its object: that descriptor's fields are not the ones written out here. */
  readonly inherited: boolean;
}

/** A descriptor is converted, its fields read in a fixed order, or copied by a spread, in the order of its keys. */
type Mode = 'convert' | 'copy';

/** Whether what a getter named `getter` writes to the field is read: no field after hides it, and a copy reaches it. */
function reachedBy(counting: Counting, getter: string | undefined, field: string): boolean {
  if (counting.hides.has(field)) return false;
  return counting.mode === 'copy'
    ? copiedAfter(counting.order, getter, field)
    : readAfter(getter, field);
}

/** What a field of a written descriptor is where a getter assigns to it. */
type Slot = 'absent' | 'accessor' | 'data' | 'setter';

/**
 * What the field a getter assigns to may be: a value, which the assignment replaces; an accessor,
 * whose setter an assignment runs instead (a getter alone swallows it); a setter that names `this`,
 * which writes as it likes; or none, which the assignment creates. A spread may give the name a
 * value, and a field whose name is computed may be any field: such a field adds what it may make of
 * the field to what it may have been, and the fields written after it, by name, make what they make
 * of each. An accessor of the descriptor that deletes the name, or any name, may have removed the
 * field before the assignment, which then makes a value.
 */
function slotsOf(descriptor: ObjectLiteralExpression, name: string): ReadonlySet<Slot> {
  let slots = new Set<Slot>(['absent']);
  for (const property of descriptor.properties) {
    const key = isSpreadAssignment(property) ? undefined : writtenArrayKey(property.name);
    if (key !== name && key !== undefined) continue;
    const made = [...slots].map((each) => slotAfter(each, property));
    if (key === name) slots = new Set(made);
    else if (isSpreadAssignment(property)) slots.add('data');
    else for (const each of made) slots.add(each);
  }
  const deleted = inheritedDeletions(descriptor);
  if (deleted.includes(undefined) || deleted.includes(name)) slots.add('data');
  return slots;
}

/** The slot a field makes of one that was: a setter or a getter makes an accessor, any other a value. */
function slotAfter(slot: Slot, property: ObjectLiteralElementLike): Slot {
  if (isSetAccessorDeclaration(property))
    return slot === 'setter' || namesThis(property) ? 'setter' : 'accessor';
  if (isGetAccessorDeclaration(property)) return slot === 'setter' ? 'setter' : 'accessor';
  return 'data';
}

/** Whether an assignment to the field leaves the descriptor the value written: no accessor swallows it. */
function stores(descriptor: ObjectLiteralExpression, field: string): boolean {
  const slots = slotsOf(descriptor, field);
  return slots.has('data') || slots.has('absent');
}

/**
 * Whether what a getter writes to a field of the descriptor is read, and the descriptor keeps it: no
 * accessor of the field swallows it. A getter that deletes fields may have removed the accessor first, and a
 * getter of a prototype runs on a descriptor whose fields are not those written here: neither says.
 */
function counted(
  descriptor: ObjectLiteralExpression,
  counting: Counting,
  {
    name,
    field,
    deletes,
  }: { readonly name: string | undefined; readonly field: string; readonly deletes: boolean },
): boolean {
  if (!reachedBy(counting, name, field)) return false;
  return deletes || counting.inherited || stores(descriptor, field);
}

/** Whether a getter deletes a member of any object: it may have removed an accessor before it assigns. */
function deletesMembers(getter: Node): boolean {
  const pending: Node[] = [getter];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.kind === SyntaxKind.DeleteExpression) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
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
  const reaches = ['value', 'get'].some((one) => reachedBy(counting, name, one));
  if (writes === undefined) return reaches ? [{ value: descriptor, keys: ['value'] }] : [];
  const deletes = deletesMembers(getter);
  const found = writes.flatMap((each) => {
    const field = each.name;
    const asValue =
      (field === undefined || field === 'value') &&
      counted(descriptor, counting, { name, field: 'value', deletes });
    const asGet =
      (field === undefined || field === 'get') &&
      counted(descriptor, counting, { name, field: 'get', deletes });
    const value = asValue ? [{ value: each.value, keys: [] }] : [];
    const get = asGet ? functionReturns(each.value, new Set(), selectedValues) : [];
    return [...value, ...get];
  });
  return reaches && runsWritingSetter(descriptor, writes)
    ? [...found, { value: descriptor, keys: ['value'] }]
    : found;
}

/**
 * Whether a field sets the prototype of the descriptor (`__proto__: value`), which is no own field.
 * A computed `['__proto__']`, a shorthand and a method are own fields.
 */
function setsProto(property: ObjectLiteralElementLike): boolean {
  return (
    !isSpreadAssignment(property) &&
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name) &&
    writtenArrayKey(property.name) === '__proto__'
  );
}

/** Whether a write of a getter runs a setter that names `this`: it may write the descriptor as it likes. */
function runsWritingSetter(
  descriptor: ObjectLiteralExpression,
  writes: readonly { readonly name: string | undefined }[],
): boolean {
  const setters = descriptor.properties.filter((one) => isSetAccessorDeclaration(one));
  for (const { name } of writes) {
    if (
      name === undefined
        ? setters.some((one) => namesThis(one))
        : slotsOf(descriptor, name).has('setter')
    )
      return true;
  }
  return false;
}

/** Whether the getter at `at` never runs: a field after it gives its name a value that is no accessor. */
export function neverRuns(descriptor: ObjectLiteralExpression, at: number): boolean {
  const getter = descriptor.properties[at];
  const key =
    getter === undefined || isSpreadAssignment(getter) ? undefined : writtenArrayKey(getter.name);
  if (key === undefined) return false;
  return descriptor.properties.slice(at + 1).some((each) => {
    if (isSpreadAssignment(each)) return copiedNames(each.expression).includes(key);
    const accessor = isGetAccessorDeclaration(each) || isSetAccessorDeclaration(each);
    return !accessor && !setsProto(each) && writtenArrayKey(each.name) === key;
  });
}
