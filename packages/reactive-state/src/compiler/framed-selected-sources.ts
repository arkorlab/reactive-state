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
import { heldMemberWrites, heldValue } from './framed-held-member-writes.ts';
import { alternativesOf, returnedValues } from './framed-mutator-getters.ts';
import { ANY_FIELD, suffixStart } from './framed-pattern-members.ts';

/**
 * What a destructuring picks out of a source, read where the compile can; the rest is kept whole.
 *
 * Followed, to the value a path selects:
 * - a `const`, and the constants that name it; a comma and an assignment, by their right; a
 *   condition, `&&`, `||` and `??`, by each branch, or by the one a written literal condition takes;
 * - a list literal: the element at an index, none for a hole; the entries of a spread of a written
 *   list or a constant that holds one, at the offsets their lengths give; a position a spread the
 *   compile cannot read may shift, and the suffix an array rest takes, by any entry that may be there;
 * - an object literal: the last field that names the key, a shorthand, what a getter returns, a
 *   spread by the own fields of what it copies, and for a key no own field names, the prototype the
 *   literal writes; a setter hands over nothing and replaces the data before it, not a getter; a
 *   name the compile cannot read may be the key.
 *
 * Kept whole, with the path for the type a parameter declares: a call, `new` and any other result of
 * a function; the member of a source (`source.field`, `source[0]`); a variable that is assigned, or
 * an alias a pattern makes; a method, which is a function and no value here; a class instance, a
 * proxy; a list or an object a native function builds or an array method changes; an entry of a
 * constant that is assigned after it is declared. A source that is kept whole is one the compile
 * does not follow, not one it takes to be safe.
 */

/** What a selection has read already: each object, for each path it was asked at. */
type Visited = Map<Node, Set<string>>;

/** What a selection shares: what it has read, and whether it reads a copy, own fields only. */
interface Reading {
  readonly visited: Visited;
  /** A spread copies the own fields of what it spreads: a prototype it writes is none of them. */
  readonly own: boolean;
  /** Where the selection is consumed, which the writes to a constant's members must precede. */
  readonly at: Node | undefined;
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
): readonly AssignedFrameSource[] {
  return select(value, keys, { visited: new Map(), own: false, at });
}

function select(
  value: Expression,
  keys: readonly string[],
  reading: Reading,
): readonly AssignedFrameSource[] {
  if (keys.length === 0) return [{ value, keys: [] }];
  const whole = [{ value, keys }];
  const names: Identifier[] = [];
  const held = valueOf(value, names);
  if (isFunctionDeclaration(held)) return whole;
  const paths = reading.visited.get(held) ?? new Set<string>();
  const path = `${reading.own ? 'own' : 'all'}\0${keys.join('\0')}`;
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
 * What the writes to the members of the constant the names stand for hand over at the path: a
 * constant does not keep its members from changing. A write to the key, or to a key the compile
 * cannot read, before the place that consumes the selection is possible; what a rest copied into
 * the member is read as the own fields of its source.
 */
function memberWrites(
  names: readonly Identifier[],
  keys: readonly string[],
  reading: Reading,
): readonly AssignedFrameSource[] {
  const [first] = names;
  const [key = '', ...rest] = keys;
  if (first === undefined) return [];
  return heldMemberWrites(first, names, reading.at).flatMap((write) => {
    if (write.list === true || !(asksAny(key) || write.key === undefined || write.key === key))
      return [];
    const copied =
      write.copiedAt === undefined ? reading : { ...reading, own: true, at: write.copiedAt };
    return select(write.value, [...write.keys, ...rest], copied);
  });
}

/** What reads below the first step of a path read: the fields of a copy are no copy. */
function below(reading: Reading): Reading {
  return reading.own ? { ...reading, own: false } : reading;
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
  const used = parent.parent;
  if (isCallExpression(used) && used.expression === parent)
    return isPropertyAccessExpression(parent) && !CHANGING.has(parent.name.text);
  if (isBinaryExpression(used))
    return !(used.left === parent && isAssignmentOperator(used.operatorToken.kind));
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
function takenFields(object: ObjectLiteralExpression, key: string | undefined): Taken {
  const fields: ObjectLiteralElementLike[] = [];
  let owned = false;
  let replaced = false;
  const candidates = object.properties
    .toReversed()
    .filter((property) => writtenPrototype(property) === undefined && mayHold(property, key));
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
  const { fields, owned } = takenFields(object, key);
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
