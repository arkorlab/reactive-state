import {
  type Expression,
  isArrayLiteralExpression,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
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
} from 'typescript/ast';

import { literalKey } from './exported-values.ts';
import { isPlainPrototype } from './global-answers.ts';
import { type JsonReading, markTooDeep, MAX_DEPTH, reached } from './json-reading.ts';
import { isPrototypeEntry } from './member-reads.ts';

/**
 * What of the arrays and the objects the code writes no JSON holds (`json-values.ts`): each element,
 * each entry's key and value, what each spreads.
 */

/** How a part of what the code writes is read: what of it no JSON holds, where it stands. */
type NonJsonOf = (node: Expression, reading: JsonReading) => Node | undefined;

/**
 * What of an array's elements, or of an object's entries, no JSON holds, as `nonJsonOf` reads it —
 * the array or the object itself, nested deeper than JSON may (`MAX_DEPTH`); what a spread spreads
 * standing where the array or the object it spreads into does — each part read as `nonJsonOf`
 * reads a value.
 */
export function partsNonJson(
  value: Expression,
  reading: JsonReading,
  nonJsonOf: NonJsonOf,
): Node | undefined {
  if (!isArrayLiteralExpression(value) && !isObjectLiteralExpression(value)) {
    return undefined;
  }
  const depth = reading.depth ?? 0;
  if (depth >= MAX_DEPTH) {
    markTooDeep(value);
    return value;
  }
  const inner: JsonReading = { ...reading, depth: depth + 1, entry: false };
  if (isArrayLiteralExpression(value)) {
    return value.elements
      .map((element) => {
        if (isOmittedExpression(element)) {
          return element;
        }
        return isSpreadElement(element)
          ? nonJsonOf(element.expression, { ...inner, depth })
          : nonJsonOf(element, inner);
      })
      .find((found) => found !== undefined);
  }
  if (isObjectLiteralExpression(value)) {
    return selectedProperties(value, reading)
      .map(({ property, at }) => {
        // A method or an accessor is a function an object holds, which JSON leaves out.
        if (
          isMethodDeclaration(property) ||
          isGetAccessorDeclaration(property) ||
          isSetAccessorDeclaration(property)
        ) {
          return property;
        }
        const part: JsonReading = { ...at, depth: depth + 1, entry: false };
        if (isPropertyAssignment(property)) {
          // `__proto__:` makes the object one of another prototype, which no JSON holds, but `null`.
          if (isPrototypeEntry(property)) {
            return isPlainPrototype(property.initializer) ? undefined : property;
          }
          // A key the code computes may be a symbol, of which JSON holds no entry: `[marker]`.
          const { name } = property;
          const key = isComputedPropertyName(name) ? nonJsonOf(name.expression, part) : undefined;
          return key ?? nonJsonOf(property.initializer, { ...part, entry: true });
        }
        // What an object spreads is held as its entries are: `{ ...{ run() { … } } }`.
        if (isSpreadAssignment(property)) {
          return nonJsonOf(property.expression, { ...part, depth, entry: true });
        }
        const name = isShorthandPropertyAssignment(property) ? property.name : undefined;
        return name !== undefined && isIdentifier(name)
          ? nonJsonOf(name, { ...part, entry: true })
          : undefined;
      })
      .find((found) => found !== undefined);
  }
  return undefined;
}

interface JsonProperty {
  readonly property: ObjectLiteralElementLike;
  readonly at: JsonReading;
  readonly spreads: number;
  readonly seen: ReadonlySet<ObjectLiteralExpression>;
}

/** Source-written spreads contribute entries in order, without adding a level of JSON nesting. */
function selectedProperties(
  value: ObjectLiteralExpression,
  reading: JsonReading,
): readonly JsonProperty[] {
  const pending = value.properties
    .toReversed()
    .map((property) => sourceProperty(property, value, reading));
  const flattened: JsonProperty[] = [];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const entries = spreadProperties(each);
    if (entries === undefined) {
      flattened.push(each);
    } else {
      pending.push(...entries.toReversed());
    }
  }
  return survivingProperties(flattened);
}

/** Each original property starts with its literal's lexical context and a bounded spread path. */
function sourceProperty(
  property: ObjectLiteralElementLike,
  value: ObjectLiteralExpression,
  at: JsonReading,
): JsonProperty {
  return { property, at, spreads: 0, seen: new Set([value]) };
}

/** Changed, unknown, cyclic and prototype-bearing spread inputs retain their existing checks. */
function spreadProperties(part: JsonProperty): readonly JsonProperty[] | undefined {
  if (!isSpreadAssignment(part.property) || part.spreads >= MAX_DEPTH) {
    return undefined;
  }
  const { at, value } = reached(part.property.expression, part.at);
  if (
    !isObjectLiteralExpression(value) ||
    part.seen.has(value) ||
    value.properties.some(
      (property) => isPropertyAssignment(property) && isPrototypeEntry(property),
    )
  ) {
    return undefined;
  }
  const seen = new Set([...part.seen, value]);
  return value.properties.map((property) => ({ property, at, spreads: part.spreads + 1, seen }));
}

/** Only a later known string key hides an earlier value; unknown and symbol entries remain visible. */
function survivingProperties(parts: readonly JsonProperty[]): readonly JsonProperty[] {
  const selected = new Set<string>();
  const result: JsonProperty[] = [];
  for (const part of parts.toReversed()) {
    const key = propertyKey(part);
    if (key === undefined || !selected.has(key)) {
      result.push(part);
    }
    if (key !== undefined) {
      selected.add(key);
    }
  }
  return result.toReversed();
}

/** A prototype setter affects object identity rather than an own entry a spread can replace. */
function propertyKey({ property, at }: JsonProperty): string | undefined {
  if (
    isSpreadAssignment(property) ||
    (isPropertyAssignment(property) && isPrototypeEntry(property))
  ) {
    return undefined;
  }
  const { name } = property;
  if (isIdentifier(name)) {
    return name.text;
  }
  return literalKey(isComputedPropertyName(name) ? reached(name.expression, at).value : name);
}
