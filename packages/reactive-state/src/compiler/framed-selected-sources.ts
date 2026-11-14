import {
  type ArrayLiteralExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForOfStatement,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isComputedPropertyName,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { writtenArrayKey } from './framed-array-functions.ts';
import type { AssignedFrameSource } from './framed-assignment-patterns.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { callbackTakesList } from './framed-callback-lists.ts';
import { type HeldWrite, heldMemberWrites, heldValue } from './framed-held-member-writes.ts';
import { alternativesOf, returnedValues } from './framed-mutator-getters.ts';
import { ANY_FIELD, fromKey, suffixStart } from './framed-pattern-members.ts';
import { isWrittenMember } from './framed-written-members.ts';
import { outermost } from './framed-written-targets.ts';

/**
 * What a destructuring picks out of a source, read where the compile can; the rest is kept whole.
 *
 * Followed, to the value a path selects:
 * - a `const`, and the constants that name it; a comma and an assignment, by their right; a
 *   condition, `&&`, `||` and `??`, by each branch, or by the one a written literal condition takes;
 * - a list literal: the element at an index, none for a hole; the entries of a spread of a written
 *   list, or of a constant that holds one nothing but a read mentions, at the offsets their lengths
 *   give; a position a spread the compile cannot read, or a list a call, an alias or a change
 *   reaches, may shift, and the suffix an array rest takes, by any entry that may be there;
 * - an object literal: the last field that names the key, a shorthand, what a getter returns, a
 *   spread by the own fields of what it copies (the values of those fields are read as references,
 *   with their prototypes), and for a key no own field names, the prototype the literal writes; a
 *   setter hands over nothing and replaces the data before it, not a getter; a name the compile
 *   cannot read may be the key;
 * - the assignments and patterns that write a member of a constant before the selection is consumed.
 *
 * Kept whole, with the path for the type a parameter declares: a call, `new` and any other result of
 * a function; the member of a source (`source.field`, `source[0]`); a variable that is assigned, or
 * an alias a pattern makes; a method, which is a function and no value here; a class instance, a
 * proxy; a list or an object a native function builds; the entries an array method adds
 * (`push`, `unshift`, `splice`) or a native mutator writes to a constant. A source that is kept whole
 * is one the compile does not follow, not one it takes to be safe.
 */

/** The names, each once, in an order that does not depend on the order they were collected in. */
function uniqueSorted(names: readonly string[]): readonly string[] {
  return [...new Set(names)].toSorted((left, right) => left.localeCompare(right));
}

/** What a selection has read already: each object, for each path it was asked at, leaving out which names. */
type Visited = Map<Node, Set<string>>;

/** What a selection shares: what it has read, and whether it reads a copy, own fields only. */
interface Reading {
  readonly visited: Visited;
  /** A spread copies the own fields of what it spreads: a prototype it writes is none of them. */
  readonly own: boolean;
  /** Where the selection is consumed, which the writes to a constant's members must precede. */
  readonly at: Node | undefined;
  /** The values of the writes the selection is inside of, which it does not follow into again. */
  readonly following: ReadonlySet<Node>;
  /** The names the copy a field is asked of was made without, which a key for any field leaves out. */
  readonly without: readonly string[];
}

/**
 * The values a source holds at a path, followed as far as the table above says. The path may end in
 * a key for any field of the source, or for the entries from a position, which a pattern with a
 * computed key and an array rest take. An object is read once for each path.
 */
export function selectedValues(
  value: Expression,
  keys: readonly string[],
  at?: Node,
): readonly SelectedSource[] {
  return select(value, keys, {
    visited: new Map(),
    own: false,
    at,
    following: new Set(),
    without: [],
  });
}

function select(
  value: Expression,
  keys: readonly string[],
  reading: Reading,
): readonly SelectedSource[] {
  if (keys.length === 0) return [{ value, keys: [] }];
  const whole = [{ value, keys }];
  const names: Identifier[] = [];
  const held = valueOf(value, names);
  if (isFunctionDeclaration(held)) return whole;
  const paths = reading.visited.get(held) ?? new Set<string>();
  const path = JSON.stringify([reading.own, uniqueSorted(reading.without), keys]);
  if (paths.has(path)) return [];
  reading.visited.set(held, paths.add(path));
  const alternatives = alternativesOf(held);
  if (alternatives !== undefined)
    return alternatives.flatMap((each) => select(each, keys, reading));
  if (isArrayLiteralExpression(held)) {
    const entries = entryOf(held, keys, { whole, exact: unchanged(names) }, reading);
    return [...entries, ...memberWrites(names, keys, reading)];
  }
  if (!isObjectLiteralExpression(held)) return whole;
  return [...fieldOf(held, keys, whole, reading), ...memberWrites(names, keys, reading)];
}

/** The operators whose value is the value of their right: a comma, an assignment. */
const VALUE_OF_RIGHT: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsToken,
]);

/** What an expression is, through the constants that hold it, a comma and an assignment. */
function valueOf(expression: Expression, names: Identifier[]): Expression | FunctionDeclaration {
  let held = heldValue(expression, names);
  while (
    !isFunctionDeclaration(held) &&
    isBinaryExpression(held) &&
    VALUE_OF_RIGHT.has(held.operatorToken.kind)
  )
    held = heldValue(held.right, names);
  return held;
}

/**
 * A value a selection hands over. One that is `inList` is an entry of the list an array rest wrote
 * into the member, read where the list is asked for whole: a value the list holds, no value of the
 * member, which is the list.
 */
export interface SelectedSource extends AssignedFrameSource {
  readonly inList?: boolean;
  /** The names a pattern left out of the rest copy this is, which a field read of it must not find. */
  readonly without?: readonly string[];
}

/**
 * What the writes to the members of the constant the names stand for hand over at the path: a
 * constant does not keep its members from changing. A write to the key, or to a key the compile
 * cannot read, before the place that consumes the selection is possible. The write captures what
 * its pattern selects where it runs, and the fields below that are read where the selection is
 * consumed; what a rest copied into the member is read as the own fields its source had then.
 */
function memberWrites(
  names: readonly Identifier[],
  keys: readonly string[],
  reading: Reading,
): readonly SelectedSource[] {
  const [first] = names;
  const [key = '', ...rest] = keys;
  if (first === undefined) return [];
  return heldMemberWrites(first, names, reading.at).flatMap((write) => {
    const matches = asksAny(key) || write.key === undefined || write.key === key;
    if (!matches || reading.following.has(write.value)) return [];
    const copy = write.copiedAt !== undefined;
    if (copy && rest[0] !== undefined && write.without?.includes(rest[0]) === true) return [];
    const took = takes(write, rest);
    if (took === undefined) return [];
    const following = new Set(reading.following).add(write.value);
    const captured = { ...reading, own: false, at: write.node, following };
    if (took.whole)
      return select(write.value, write.keys, captured).map((each) => ({ ...each, inList: true }));
    const later = copy ? { ...captured, own: true } : { ...reading, following };
    return select(write.value, took.path, captured).flatMap((each) => {
      if (took.tail[0] !== undefined && each.without?.includes(took.tail[0]) === true) return [];
      const read = { ...later, without: leftOutOfAny(each, write, copy, took.tail[0]) };
      const handed =
        each.keys.length === 0
          ? select(each.value, took.tail, read)
          : [{ value: each.value, keys: [...each.keys, ...took.tail] }];
      const inList = each.inList === true && took.tail.length === 0;
      const left = leftOut(each, write, copy, took.tail.length === 0);
      const kept = left.length === 0 ? handed : handed.map((one) => withExclusions(one, left));
      return inList ? kept.map((one) => ({ ...one, inList })) : kept;
    });
  });
}

/**
 * The names the value handed over is a copy without: what it was already, and this rest's. They
 * belong to the copy and not to a field of it, so a selection that goes into a field has none.
 */
function leftOut(
  each: SelectedSource,
  write: HeldWrite,
  copy: boolean,
  whole: boolean,
): readonly string[] {
  if (!whole) return [];
  return [...(each.without ?? []), ...(copy ? (write.without ?? []) : [])];
}

/** The names a key for any field of a copy leaves out: what it was made without, as the copy it is a copy of was. */
function leftOutOfAny(
  each: SelectedSource,
  write: HeldWrite,
  copy: boolean,
  key: string | undefined,
): readonly string[] {
  return key === ANY_FIELD ? [...(each.without ?? []), ...(copy ? (write.without ?? []) : [])] : [];
}

/** A value the selection hands over whole, with the names it was copied without. */
function withExclusions(source: SelectedSource, without: readonly string[]): SelectedSource {
  return source.keys.length === 0 ? { ...source, without } : source;
}

/** The path a write captures, and the path below what it captured. */
interface Takes {
  readonly path: readonly string[];
  readonly tail: readonly string[];
  /** The list itself, where nothing below it is asked. */
  readonly whole: boolean;
}

/**
 * What a write hands over below the member: the path of what its pattern selected and the rest of
 * the path below it; for the entries a rest wrote, the path of one entry, an index below the member
 * being the index in the source less the position the rest starts at, or of the entries from a
 * position on; the list itself where nothing below it is asked; none for a named property of it.
 */
function takes(write: HeldWrite, rest: readonly string[]): Takes | undefined {
  if (write.list !== true) return { path: write.keys, tail: rest, whole: false };
  const start = suffixStart(write.keys.at(-1) ?? '');
  if (start === undefined) return undefined;
  const [first, ...tail] = rest;
  if (first === undefined) return { path: [], tail: [], whole: true };
  const base = write.keys.slice(0, -1);
  const from = suffixStart(first);
  const index = Number(first);
  const exact = Number.isSafeInteger(index) && index >= 0 && String(index) === first;
  if (first === ANY_FIELD) return { path: [...base, fromKey(start)], tail, whole: false };
  if (from !== undefined) return { path: [...base, fromKey(start + from)], tail, whole: false };
  return exact ? { path: [...base, String(start + index)], tail, whole: false } : undefined;
}

/**
 * The list a spread copies where it is written out: a literal, or the one name of a constant that
 * nothing but a read mentions. None for any other list, which may hold its entries elsewhere.
 */
export function writtenList(expression: Expression): ArrayLiteralExpression | undefined {
  const names: Identifier[] = [];
  const held = valueOf(expression, names);
  return !isFunctionDeclaration(held) && isArrayLiteralExpression(held) && unchanged(names)
    ? held
    : undefined;
}

/** What reads below the first step of a path read: the fields of a copy are no copy. */
function below(reading: Reading): Reading {
  return reading.own || reading.without.length > 0
    ? { ...reading, own: false, without: [] }
    : reading;
}

/** The methods that change a list, or the order of its entries. */
const CHANGING = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

/** Whether a place that names a list only reads it: spreads it, iterates it, takes an entry of it. */
function onlyReads(name: Identifier): boolean {
  const { parent } = name;
  if (isVariableDeclaration(parent)) return parent.name === name;
  if (isSpreadElement(parent) || isForOfStatement(parent)) return true;
  if (isBinaryExpression(parent))
    return (
      parent.right === name &&
      parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      (isArrayLiteralExpression(parent.left) || isObjectLiteralExpression(parent.left))
    );
  if (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) return false;
  if (isWrittenMember(parent)) return false;
  const member = outermost(parent);
  const used = member.parent;
  if (isCallExpression(used) && used.expression === member)
    return (
      isPropertyAccessExpression(parent) &&
      !CHANGING.has(parent.name.text) &&
      !callbackTakesList(parent.name.text, used)
    );
  if (isBinaryExpression(used))
    return !(used.left === member && isAssignmentOperator(used.operatorToken.kind));
  return !(
    isDeleteExpression(used) ||
    isPrefixUnaryExpression(used) ||
    isPostfixUnaryExpression(used)
  );
}

function isAssignmentOperator(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

/**
 * Whether the list the names stand for is what its literal wrote: one name, which nothing but a read
 * of it mentions. A list that a call, an alias or a change reaches may hold its entries elsewhere.
 */
function unchanged(names: readonly Identifier[]): boolean {
  const [name, ...others] = names;
  if (name === undefined) return true;
  if (others.length > 0) return false;
  const binding = frameBindingOf(name)?.binding;
  const pending: Node[] = [name.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isIdentifier(node)) {
      const mentions = node.text === name.text && frameBindingOf(node)?.binding === binding;
      if (mentions && !onlyReads(node)) return false;
      continue;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** How far an index is followed in a list: past it, the key is for no position. */
const LISTS = { furthest: 4096 } as const;

/** The positions of a list a key asks for: one index, or from a position on. */
interface Positions {
  readonly from: number;
  readonly to: number;
}

/** The positions a key stands for; none for a key that names no entry, `length` or a method. */
function positionsOf(key: string): Positions | undefined {
  if (key === ANY_FIELD) return { from: 0, to: Infinity };
  const from = suffixStart(key);
  if (from !== undefined) return { from, to: Infinity };
  const index = Number(key);
  const written = Number.isSafeInteger(index) && index >= 0 && String(index) === key;
  return written && index <= LISTS.furthest ? { from: index, to: index } : undefined;
}

/**
 * The entries of a list literal at the positions a key asks for. A spread of a written list takes
 * the positions its length gives; one the compile cannot read may hold the entries from there on, so
 * every element after it may be at the position.
 */
function entryOf(
  list: ArrayLiteralExpression,
  keys: readonly string[],
  { whole, exact }: { readonly whole: readonly AssignedFrameSource[]; readonly exact: boolean },
  reading: Reading,
): readonly AssignedFrameSource[] {
  const [key = '', ...rest] = keys;
  const asked = positionsOf(key);
  if (asked === undefined) return whole;
  const wanted = exact ? asked : { from: 0, to: Infinity };
  const found: AssignedFrameSource[] = [];
  place(list, { wanted, rest, found, reading, done: new Map() }, 0);
  return found;
}

/** What a placement of a list looks for, what it reads with, and what it has found. */
interface Placing {
  readonly wanted: Positions;
  readonly rest: readonly string[];
  readonly found: AssignedFrameSource[];
  readonly reading: Reading;
  /** Where each list has been walked from, and where that walk ended: a list is walked once from a position. */
  readonly done: Map<Node, Map<string, number | undefined>>;
}

/**
 * Walks a list from a position, which is none once a spread the compile cannot read has made the
 * positions unknown, and gives the position after it. An entry at a wanted position, or at an
 * unknown one, is taken. Where every position from here on is wanted, the positions no longer
 * matter, and the spreads are read for any entry.
 */
function place(
  list: ArrayLiteralExpression,
  placing: Placing,
  start: number | undefined,
): number | undefined {
  const walks = placing.done.get(list) ?? new Map<string, number | undefined>();
  const from = String(start);
  if (walks.has(from)) return walks.get(from);
  placing.done.set(list, walks.set(from, start));
  let position = start;
  for (const each of list.elements) {
    if (position !== undefined && position > placing.wanted.to) break;
    position = placeEntry(each, placing, position);
  }
  walks.set(from, position);
  return position;
}

/** One element of a list placed at a position: the position after it. */
function placeEntry(
  each: Expression,
  placing: Placing,
  position: number | undefined,
): number | undefined {
  const { wanted } = placing;
  const everywhere = wanted.to === Infinity && (position === undefined || position >= wanted.from);
  if (isSpreadElement(each)) {
    if (!everywhere) return placeSpread(each.expression, placing, position);
    readAny(each.expression, placing);
    return undefined;
  }
  if ((position === undefined || position >= wanted.from) && !isOmittedExpression(each))
    placing.found.push(...select(each, placing.rest, below(placing.reading)));
  return position === undefined ? undefined : position + 1;
}

/** The entries of a spread read for any entry: the positions no longer matter. */
function readAny(copied: Expression, placing: Placing): void {
  const keys = [ANY_FIELD, ...placing.rest];
  placing.found.push(...select(copied, keys, below(placing.reading)));
}

/** The entries of a spread: of a list nothing changes, at its offsets; of any other, wherever. */
function placeSpread(
  copied: Expression,
  placing: Placing,
  position: number | undefined,
): number | undefined {
  const names: Identifier[] = [];
  const inner = valueOf(copied, names);
  if (isArrayLiteralExpression(inner) && unchanged(names)) return place(inner, placing, position);
  readAny(copied, placing);
  return undefined;
}

/** The prototype a literal writes with `__proto__: object`; `['__proto__']` and a shorthand do not. */
function writtenPrototype(property: ObjectLiteralElementLike): Expression | undefined {
  const sets =
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name) &&
    writtenArrayKey(property.name) === '__proto__';
  return sets ? property.initializer : undefined;
}

/** What a field hands over at the rest of the path: its value, what its getter returns. */
function fieldValues(
  property: ObjectLiteralElementLike,
  rest: readonly string[],
  whole: readonly AssignedFrameSource[],
  reading: Reading,
): readonly AssignedFrameSource[] {
  const deeper = below(reading);
  if (isPropertyAssignment(property)) return select(property.initializer, rest, deeper);
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return select(property.name, rest, deeper);
  if (!isGetAccessorDeclaration(property)) return whole;
  return returnedValues(property.body).flatMap((each) => select(each.value, rest, deeper));
}

/** Whether a key is for any field, or for the entries from a position: no field is named. */
function asksAny(key: string | undefined): boolean {
  return key === ANY_FIELD || (key !== undefined && suffixStart(key) !== undefined);
}

/** Whether a field is named by one of the names a copy was made without. */
function isLeftOut(property: ObjectLiteralElementLike, without: readonly string[]): boolean {
  if (isSpreadAssignment(property)) return false;
  const name = writtenArrayKey(property.name);
  return name !== undefined && without.includes(name);
}

/** Whether a field may be the key: a spread, a name the compile cannot read, or the name itself. */
function mayHold(property: ObjectLiteralElementLike, key: string | undefined): boolean {
  if (asksAny(key) || isSpreadAssignment(property)) return true;
  const name = writtenArrayKey(property.name);
  return name === undefined || name === key;
}

/** The fields of an object literal that take part in a key, last to first, and what is left of it. */
interface Taken {
  readonly fields: readonly ObjectLiteralElementLike[];
  /** Whether an own field of the key stops the prototype from supplying it. */
  readonly owned: boolean;
}

/**
 * The fields of an object literal that may hold the key, last to first: the last field that names
 * it, and each field after which a spread, or a name the compile cannot read, may have set it. A
 * setter hands over nothing and replaces the data before it, not a getter.
 */
function takenFields(
  object: ObjectLiteralExpression,
  key: string | undefined,
  without: readonly string[],
): Taken {
  const fields: ObjectLiteralElementLike[] = [];
  let owned = false;
  let replaced = false;
  const candidates = object.properties.toReversed().filter((property) => {
    return (
      writtenPrototype(property) === undefined &&
      mayHold(property, key) &&
      !isLeftOut(property, without)
    );
  });
  for (const property of candidates) {
    if (isSpreadAssignment(property)) {
      fields.push(property);
      continue;
    }
    const exact = !asksAny(key) && writtenArrayKey(property.name) !== undefined;
    if (isSetAccessorDeclaration(property)) {
      replaced ||= exact;
      owned ||= exact;
      continue;
    }
    if (replaced && !isGetAccessorDeclaration(property)) continue;
    fields.push(property);
    owned ||= exact;
    if (exact) break;
  }
  return { fields, owned };
}

/**
 * What the fields of an object literal hand over at a path: a spread, by the own fields of what it
 * copies; what no field names, by the prototype the literal writes, unless it is read as a copy.
 */
function fieldOf(
  object: ObjectLiteralExpression,
  keys: readonly string[],
  whole: readonly AssignedFrameSource[],
  reading: Reading,
): readonly AssignedFrameSource[] {
  const [key, ...rest] = keys;
  const { fields, owned } = takenFields(object, key, key === ANY_FIELD ? reading.without : []);
  const copied = { ...reading, own: true };
  const found = fields.flatMap((property) => {
    return isSpreadAssignment(property)
      ? select(property.expression, keys, copied)
      : fieldValues(property, rest, whole, reading);
  });
  const prototype = object.properties.map((property) => writtenPrototype(property)).find(Boolean);
  return prototype === undefined || owned || reading.own
    ? found
    : [...found, ...select(prototype, keys, reading)];
}
