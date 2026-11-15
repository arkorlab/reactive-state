import {
  type Expression,
  isArrayLiteralExpression,
  isIdentifier,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue } from './numbers.ts';
import { includesApplication } from './written-evaluation.ts';

/** Literal member and index projections that execute no application conversions or getters. */

export interface LiteralSelection {
  readonly value: Expression | undefined;
  readonly unknown: boolean;
  readonly assigned?: boolean;
  readonly fresh?: boolean;
}

export const UNKNOWN_SELECTION: LiteralSelection = { unknown: true, value: undefined };

/** A written literal member, after constant aliases; unknown holders/spreads remain unproven. */
export function selected(node: Expression | undefined, key: string | undefined): LiteralSelection {
  if (node === undefined) {
    return { unknown: false, value: undefined };
  }
  if (key === undefined) {
    return UNKNOWN_SELECTION;
  }
  const value = literalValue(node);
  if (value !== undefined && isObjectLiteralExpression(value)) {
    return selectedProperty(value, key);
  }
  if (
    value !== undefined &&
    isArrayLiteralExpression(value) &&
    !value.elements.some((element) => isSpreadElement(element))
  ) {
    const index = Number(key);
    const item = String(index) === key ? value.elements[index] : undefined;
    return {
      unknown: false,
      value: item === undefined || isOmittedExpression(item) ? undefined : item,
    };
  }
  return UNKNOWN_SELECTION;
}

/** A literal binding key whose comparison executes no application code. */
export function literalPropertyName(node: Node): string | undefined {
  if (isNumericLiteral(node)) {
    return String(Number(node.text));
  }
  return isIdentifier(node) || isStringLiteral(node) ? node.text : undefined;
}

/** A value followed through constants without evaluating a conversion or application call. */
function literalValue(node: Expression): Expression | undefined {
  const seen = new Set<Expression>();
  let value = unwrapped(node);
  while (isIdentifier(value)) {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    const initializer = metadataInitializer(value);
    if (initializer === undefined) {
      return value;
    }
    value = unwrapped(initializer);
  }
  return value;
}

/** A literal object's last own definition, with unknown computed names or spreads left unproven. */
function selectedProperty(value: ObjectLiteralExpression, key: string): LiteralSelection {
  let inherited = false;
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return UNKNOWN_SELECTION;
    }
    const named = literalPropertyName(property.name);
    if (named === undefined) {
      return UNKNOWN_SELECTION;
    }
    inherited ||= inheritedProperty(property);
    if (named === key) {
      if (isPropertyAssignment(property)) {
        return { unknown: false, value: property.initializer };
      }
      if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
        return { unknown: false, value: property.name };
      }
      return UNKNOWN_SELECTION;
    }
  }
  return inherited ? UNKNOWN_SELECTION : { unknown: false, value: undefined };
}

/** A literal prototype can supply a missing property instead of selecting a binding's default. */
function inheritedProperty(node: Node): boolean {
  return (
    isPropertyAssignment(node) &&
    literalPropertyName(node.name) === '__proto__' &&
    !ignoredPrototype(node.initializer)
  );
}

/** Null and primitive prototype-setter values leave no custom object to supply missing members. */
function ignoredPrototype(node: Expression): boolean {
  const value = literalValue(node);
  if (value === undefined || (includesApplication(value) && globalPathOf(value) === undefined)) {
    return false;
  }
  return (
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.BigIntLiteral ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    isVoidExpression(value) ||
    globalPathOf(value)?.join('.') === 'undefined' ||
    constantValue(value, metadataInitializer) !== undefined
  );
}
