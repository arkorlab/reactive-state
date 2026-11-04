import {
  type Expression,
  isComputedPropertyName,
  isIdentifier,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  type Node,
  type PropertyName,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedKeyNames } from './framed-keys.ts';

/** Written own data entries, without executing accessor bodies or inferring an input's shape. */
export function framedDescriptorEntries(
  node: Expression,
  names: readonly string[] | undefined,
): readonly Expression[] | undefined {
  const value = unwrapped(node);
  if (!isObjectLiteralExpression(value)) return undefined;
  const entries = new Map<string, Expression | undefined>();
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) return undefined;
    const keys = entryKeys(property.name);
    if (keys === undefined) return undefined;
    const entry = entryValue(property);
    for (const key of keys) entries.set(key, entry);
  }
  const values: Expression[] = [];
  const selected = names ?? entries.keys();
  for (const name of selected) {
    const entry = entries.get(name);
    if (entry !== undefined) values.push(entry);
  }
  return values;
}

/** A possible computed name preserves earlier values and the target when that entry is absent. */
export function framedDescriptorChoices(
  node: Expression,
  name: string,
): { readonly values: readonly Expression[]; readonly absent: boolean } | undefined {
  const value = unwrapped(node);
  if (!isObjectLiteralExpression(value)) return undefined;
  let values: Expression[] = [];
  let absent = true;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) return undefined;
    const keys = entryKeys(property.name);
    if (keys === undefined) return undefined;
    if (!keys.includes(name)) continue;
    const entry = entryValue(property);
    if (entry === undefined) return undefined;
    if (keys.length === 1) {
      values = [entry];
      absent = false;
    } else {
      values.push(entry);
    }
  }
  return { values, absent };
}

/** Written literal keys of an own entry; an unknown computed name keeps the selection opaque. */
function entryKeys(name: PropertyName): readonly string[] | undefined {
  if (isComputedPropertyName(name)) return framedKeyNames(name.expression);
  return isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)
    ? [name.text]
    : undefined;
}

/** Only own data entries expose their initializer through a descriptor's value. */
function entryValue(node: Node): Expression | undefined {
  if (isPropertyAssignment(node)) return node.initializer;
  return isShorthandPropertyAssignment(node) && isIdentifier(node.name) ? node.name : undefined;
}
