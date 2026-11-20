import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  type ObjectLiteralElementLike,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { memberPath } from './exported-values.ts';
import { initializerOf } from './framed.ts';
import { middlewareArrayElement } from './middleware-array-elements.ts';
import { middlewareEnumeration } from './middleware-enumerations.ts';
import { middlewareReflection } from './middleware-reflections.ts';

/** Original literal selection and primitive-snapshot inputs retain their preexisting lookup rules. */

/** A selected written value retains the lexical reads that supply its original collection. */
interface LiteralSelection {
  readonly value: Expression;
  readonly references: readonly Identifier[];
  readonly reflected: boolean;
  readonly quiet: boolean;
}

/** A written value selected through literal own properties, leaving opaque projections unresolved. */
export function selectedValue(
  expression: Expression,
  originalKeys: readonly string[] = [],
): LiteralSelection | undefined {
  const seen = new Set<Expression>();
  const keys = [...originalKeys];
  const references: Identifier[] = [];
  let reflected = false;
  let quiet = true;
  let value = unwrapped(expression);
  for (;;) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const reflection =
      middlewareReflection(value) ?? middlewareEnumeration(value) ?? middlewareArrayElement(value);
    if (reflection !== undefined) {
      keys.unshift(...reflection.keys);
      value = unwrapped(reflection.of);
      reflected = true;
      quiet &&= reflection.quiet;
      continue;
    }
    const path = memberPath(value);
    keys.unshift(...path.keys);
    value = path.root;
    if (isIdentifier(value)) {
      references.push(value);
      const initializer = initializerOf(value);
      if (initializer === undefined)
        return unresolvedName(value, keys, { references, reflected, quiet });
      value = unwrapped(initializer);
      continue;
    }
    const key = keys.shift();
    if (key !== undefined) {
      const selected = literalMember(value, key);
      if (selected === undefined) return undefined;
      value = unwrapped(selected);
      continue;
    }
    return { value, references, reflected, quiet };
  }
}

/** An unresolved name can stand alone, without asserting what a member of it holds. */
function unresolvedName(
  value: Identifier,
  keys: readonly string[],
  selection: Omit<LiteralSelection, 'value'>,
): LiteralSelection | undefined {
  return keys.length === 0 ? { value, ...selection } : undefined;
}

/** A surviving own data value from a written collection; opaque keys and spreads stay unproven. */
function literalMember(value: Expression, name: string): Expression | undefined {
  if (isObjectLiteralExpression(value)) {
    for (const property of value.properties.toReversed()) {
      const entry = literalProperty(property);
      if (entry === undefined) return undefined;
      if (entry.name === name) return entry.value;
    }
  }
  return literalArrayMember(value, name);
}

/** One explicitly named own data property. */
function literalProperty(
  property: ObjectLiteralElementLike,
): { readonly name: string; readonly value: Expression } | undefined {
  if (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property)) return undefined;
  if (!isIdentifier(property.name)) return undefined;
  return {
    name: property.name.text,
    value: isPropertyAssignment(property) ? property.initializer : property.name,
  };
}

/** A fixed array element where no spread can shift its position. */
function literalArrayMember(value: Expression, name: string): Expression | undefined {
  if (!isArrayLiteralExpression(value)) return undefined;
  const index = Number(name);
  const element = value.elements[index];
  if (element === undefined || String(index) !== name) return undefined;
  if (isOmittedExpression(element) || value.elements.some((each) => isSpreadElement(each)))
    return undefined;
  return element;
}
