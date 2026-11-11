import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { writtenArrayKey } from './framed-array-functions.ts';
import type { AssignedFrameSource } from './framed-assignment-patterns.ts';
import { heldValue } from './framed-held-member-writes.ts';
import { alternativesOf, returnedValues } from './framed-mutator-getters.ts';
import { ANY_FIELD } from './framed-pattern-members.ts';

/** What a destructuring picks out of a source: the path it followed, read where the compile can. */

/**
 * The values a source holds at a path, followed through the constants that hold it, the branches of
 * a condition, and the literals that spell it out. Where the path cannot be followed, the source
 * stays whole, with the path for the type a parameter declares.
 */
export function selectedValues(
  value: Expression,
  keys: readonly string[],
  seen: ReadonlySet<Node> = new Set(),
): readonly AssignedFrameSource[] {
  if (keys.length === 0) return [{ value, keys: [] }];
  const whole = [{ value, keys: keys.filter((each) => each !== ANY_FIELD) }];
  const held = heldValue(value);
  if (isFunctionDeclaration(held) || seen.has(held)) return whole;
  const alternatives = alternativesOf(held);
  if (alternatives !== undefined) {
    const within = new Set(seen).add(held);
    return alternatives.flatMap((each) => selectedValues(each, keys, within));
  }
  const within = new Set(seen).add(held);
  if (isArrayLiteralExpression(held)) return entryOf(held, keys, whole, within);
  return isObjectLiteralExpression(held) ? fieldOf(held, keys, whole, within) : whole;
}

/** The element of a list literal at a position no spread may shift. */
function entryOf(
  list: ArrayLiteralExpression,
  keys: readonly string[],
  whole: readonly AssignedFrameSource[],
  seen: ReadonlySet<Node>,
): readonly AssignedFrameSource[] {
  const [key = '', ...rest] = keys;
  if (key === ANY_FIELD) return list.elements.flatMap((each) => anyEntry(each, keys, seen));
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) return whole;
  if (list.elements.slice(0, index + 1).some((element) => isSpreadElement(element))) return whole;
  const element = list.elements[index];
  return element === undefined || isOmittedExpression(element)
    ? []
    : selectedValues(element, rest, seen);
}

/** What one element of a list holds at any field: a spread's, or the element's own. */
function anyEntry(
  element: Expression,
  keys: readonly string[],
  seen: ReadonlySet<Node>,
): readonly AssignedFrameSource[] {
  if (isOmittedExpression(element)) return [];
  if (isSpreadElement(element)) return selectedValues(element.expression, keys, seen);
  return selectedValues(element, keys.slice(1), seen);
}

/**
 * The fields of an object literal that may hold the key: the last field that names it, and each
 * field after which a spread or a name the compile cannot read may have set it.
 */
function fieldOf(
  object: ObjectLiteralExpression,
  keys: readonly string[],
  whole: readonly AssignedFrameSource[],
  seen: ReadonlySet<Node>,
): readonly AssignedFrameSource[] {
  const [key, ...rest] = keys;
  const found: AssignedFrameSource[] = [];
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      found.push(...selectedValues(property.expression, keys, seen));
      continue;
    }
    const name = writtenArrayKey(property.name);
    if (key !== ANY_FIELD && name !== undefined && name !== key) continue;
    if (isPropertyAssignment(property))
      found.push(...selectedValues(property.initializer, rest, seen));
    else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
      found.push(...selectedValues(property.name, rest, seen));
    else if (isGetAccessorDeclaration(property))
      found.push(
        ...returnedValues(property.body).flatMap((each) => selectedValues(each.value, rest, seen)),
      );
    else found.push(...whole);
    if (name !== undefined && key !== ANY_FIELD) break;
  }
  return found;
}
