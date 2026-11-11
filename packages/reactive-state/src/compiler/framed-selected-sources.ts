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
import { ANY_FIELD } from './framed-pattern-members.ts';

/** What a destructuring picks out of a source: the path it followed, read where the compile can. */

/** What a selection has read already: each object, for each path it was asked at. */
type Visited = Map<Node, Set<string>>;

/**
 * The values a source holds at a path, followed through the constants that hold it, the branches of
 * a condition, the value of a comma or an assignment, and the literals that spell it out, spreads,
 * getters and a written prototype among them. Where the path cannot be followed, the source stays
 * whole, with the path for the type a parameter declares. An object is read once for each path.
 */
export function selectedValues(
  value: Expression,
  keys: readonly string[],
  visited: Visited = new Map(),
): readonly AssignedFrameSource[] {
  if (keys.length === 0) return [{ value, keys: [] }];
  const whole = [{ value, keys }];
  const held = valueOf(value);
  if (isFunctionDeclaration(held)) return whole;
  const paths = visited.get(held) ?? new Set<string>();
  const path = keys.join('\0');
  if (paths.has(path)) return [];
  visited.set(held, paths.add(path));
  const alternatives = alternativesOf(held);
  if (alternatives !== undefined)
    return alternatives.flatMap((each) => selectedValues(each, keys, visited));
  if (isArrayLiteralExpression(held)) return entryOf(held, keys, whole, visited);
  return isObjectLiteralExpression(held) ? fieldOf(held, keys, whole, visited) : whole;
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

/**
 * The element of a list literal at a position no spread may shift. Where one may, the entries of
 * each spread, and each element after the first of them, may be there.
 */
function entryOf(
  list: ArrayLiteralExpression,
  keys: readonly string[],
  whole: readonly AssignedFrameSource[],
  visited: Visited,
): readonly AssignedFrameSource[] {
  const [key = '', ...rest] = keys;
  if (key === ANY_FIELD) return list.elements.flatMap((each) => anyEntry(each, keys, visited));
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) return whole;
  const shifted = list.elements.findIndex((element) => isSpreadElement(element));
  if (shifted === -1 || index < shifted) {
    const element = list.elements[index];
    return element === undefined || isOmittedExpression(element)
      ? []
      : selectedValues(element, rest, visited);
  }
  return list.elements.flatMap((each, at) => {
    if (isSpreadElement(each))
      return selectedValues(each.expression, [ANY_FIELD, ...rest], visited);
    return at > shifted && !isOmittedExpression(each) ? selectedValues(each, rest, visited) : [];
  });
}

/** What one element of a list holds at any field: a spread's, or the element's own. */
function anyEntry(
  element: Expression,
  keys: readonly string[],
  visited: Visited,
): readonly AssignedFrameSource[] {
  if (isOmittedExpression(element)) return [];
  if (isSpreadElement(element)) return selectedValues(element.expression, keys, visited);
  return selectedValues(element, keys.slice(1), visited);
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
  visited: Visited,
): readonly AssignedFrameSource[] {
  if (isPropertyAssignment(property)) return selectedValues(property.initializer, rest, visited);
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return selectedValues(property.name, rest, visited);
  if (!isGetAccessorDeclaration(property)) return whole;
  return returnedValues(property.body).flatMap((each) => selectedValues(each.value, rest, visited));
}

/** Whether a field may be the key: a spread, a name the compile cannot read, or the name itself. */
function mayHold(property: ObjectLiteralElementLike, key: string | undefined): boolean {
  if (key === ANY_FIELD || isSpreadAssignment(property)) return true;
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
    const exact = key !== ANY_FIELD && writtenArrayKey(property.name) !== undefined;
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

/** What the fields of an object literal hand over at a path; what no field names, its prototype. */
function fieldOf(
  object: ObjectLiteralExpression,
  keys: readonly string[],
  whole: readonly AssignedFrameSource[],
  visited: Visited,
): readonly AssignedFrameSource[] {
  const [key, ...rest] = keys;
  const { fields, owned } = takenFields(object, key);
  const found = fields.flatMap((property) => {
    return isSpreadAssignment(property)
      ? selectedValues(property.expression, keys, visited)
      : fieldValues(property, rest, whole, visited);
  });
  const prototype = object.properties.map((property) => writtenPrototype(property)).find(Boolean);
  return prototype === undefined || owned
    ? found
    : [...found, ...selectedValues(prototype, keys, visited)];
}
