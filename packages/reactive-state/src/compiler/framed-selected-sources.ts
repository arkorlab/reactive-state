import {
  type ArrayLiteralExpression,
  type Expression,
  type FunctionDeclaration,
  isArrayLiteralExpression,
  isBinaryExpression,
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
import { heldValue } from './framed-held-member-writes.ts';
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
}

/**
 * The values a source holds at a path, followed as far as the table above says. The path may end in
 * a key for any field of the source, or for the entries from a position, which a pattern with a
 * computed key and an array rest take. An object is read once for each path.
 */
export function selectedValues(
  value: Expression,
  keys: readonly string[],
): readonly AssignedFrameSource[] {
  return select(value, keys, { visited: new Map(), own: false });
}

function select(
  value: Expression,
  keys: readonly string[],
  reading: Reading,
): readonly AssignedFrameSource[] {
  if (keys.length === 0) return [{ value, keys: [] }];
  const whole = [{ value, keys }];
  const held = valueOf(value);
  if (isFunctionDeclaration(held)) return whole;
  const paths = reading.visited.get(held) ?? new Set<string>();
  const path = `${reading.own ? 'own' : 'all'}\0${keys.join('\0')}`;
  if (paths.has(path)) return [];
  reading.visited.set(held, paths.add(path));
  const alternatives = alternativesOf(held);
  if (alternatives !== undefined)
    return alternatives.flatMap((each) => select(each, keys, reading));
  if (isArrayLiteralExpression(held)) return entryOf(held, keys, whole, reading);
  return isObjectLiteralExpression(held) ? fieldOf(held, keys, whole, reading) : whole;
}

/** The operators whose value is the value of their right: a comma, an assignment. */
const VALUE_OF_RIGHT: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsToken,
]);

/** What an expression is, through the constants that hold it, a comma and an assignment. */
function valueOf(expression: Expression): Expression | FunctionDeclaration {
  let held = heldValue(expression);
  while (
    !isFunctionDeclaration(held) &&
    isBinaryExpression(held) &&
    VALUE_OF_RIGHT.has(held.operatorToken.kind)
  )
    held = heldValue(held.right);
  return held;
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
  whole: readonly AssignedFrameSource[],
  reading: Reading,
): readonly AssignedFrameSource[] {
  const [key = '', ...rest] = keys;
  const wanted = positionsOf(key);
  if (wanted === undefined) return whole;
  const found: AssignedFrameSource[] = [];
  place(list, { wanted, rest, found, reading, within: new Set([list]) }, 0);
  return found;
}

/** What a placement of a list looks for, what it reads with, and what it has found. */
interface Placing {
  readonly wanted: Positions;
  readonly rest: readonly string[];
  readonly found: AssignedFrameSource[];
  readonly reading: Reading;
  /** The lists the walk is inside, which it does not enter again. */
  readonly within: Set<Node>;
}

/**
 * Walks a list from a position, which is none once a spread the compile cannot read has made the
 * positions unknown, and gives the position after it. An entry at a wanted position, or at an
 * unknown one, is taken.
 */
function place(
  list: ArrayLiteralExpression,
  placing: Placing,
  start: number | undefined,
): number | undefined {
  let position = start;
  for (const each of list.elements) {
    if (position !== undefined && position > placing.wanted.to) return position;
    if (isSpreadElement(each)) {
      position = placeSpread(each.expression, placing, position);
      continue;
    }
    const wanted = position === undefined || position >= placing.wanted.from;
    if (wanted && !isOmittedExpression(each))
      placing.found.push(...select(each, placing.rest, placing.reading));
    position = position === undefined ? undefined : position + 1;
  }
  return position;
}

/** The entries of a spread: of a written list, at its offsets; of any other, wherever they are. */
function placeSpread(
  copied: Expression,
  placing: Placing,
  position: number | undefined,
): number | undefined {
  const inner = valueOf(copied);
  if (isArrayLiteralExpression(inner) && !placing.within.has(inner)) {
    placing.within.add(inner);
    const after = place(inner, placing, position);
    placing.within.delete(inner);
    return after;
  }
  placing.found.push(...select(copied, [ANY_FIELD, ...placing.rest], placing.reading));
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
  if (isPropertyAssignment(property)) return select(property.initializer, rest, reading);
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return select(property.name, rest, reading);
  if (!isGetAccessorDeclaration(property)) return whole;
  return returnedValues(property.body).flatMap((each) => select(each.value, rest, reading));
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
