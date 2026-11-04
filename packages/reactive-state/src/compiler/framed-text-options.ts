import {
  type Expression,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  type ObjectLiteralExpression,
  type PropertyName,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import {
  framedQuietGetter,
  framedQuietInputs,
  framedQuietSource,
} from './framed-native-evaluation.ts';

/** Added constructor text observations retain only closed literal option records and quiet source-return getters. */

/** Finite known spreads preserve last-field replacement and original expression nodes. */
export function framedTextOptions(
  expression: Expression,
  natives: ReadonlySet<string>,
): ReadonlyMap<string, Expression> | undefined {
  const root = framedQuietSource(expression);
  if (root === undefined || !isObjectLiteralExpression(root)) return undefined;
  const pending = root.properties
    .toReversed()
    .map((property) => ({ property, ancestors: new Set([root]) }));
  const fields = new Map<string, Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { property, ancestors } = next;
    if (isSpreadAssignment(property)) {
      const source = framedQuietSource(property.expression);
      if (source === undefined || !isObjectLiteralExpression(source) || ancestors.has(source))
        return undefined;
      for (const child of source.properties.toReversed())
        pending.push({ property: child, ancestors: new Set([...ancestors, source]) });
      continue;
    }
    const name = textOptionName(property.name);
    const value = textOptionValue(property);
    if (
      name === undefined ||
      name === '__proto__' ||
      value === undefined ||
      !framedQuietInputs([value], natives)
    )
      return undefined;
    fields.set(name, value);
  }
  return fields;
}

/** A static literal name performs no computed application evaluation. */
function textOptionName(name: PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  const value = isComputedPropertyName(name) ? unwrapped(name.expression) : name;
  if (!isComputedPropertyName(name) && isIdentifier(value)) return value.text;
  if (isNumericLiteral(value)) return String(Number(value.text));
  return isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
}

/** A getter may return its original source directly; methods, setters and body effects stay opaque. */
function textOptionValue(
  property: ObjectLiteralExpression['properties'][number],
): Expression | undefined {
  if (isPropertyAssignment(property)) return property.initializer;
  if (
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name) &&
    property.objectAssignmentInitializer === undefined
  )
    return property.name;
  return isGetAccessorDeclaration(property) ? framedQuietGetter(property) : undefined;
}
