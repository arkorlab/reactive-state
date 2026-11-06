import {
  type Expression,
  isComputedPropertyName,
  isIdentifier,
  isExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { constantValue } from './numbers.ts';

/** A fresh literal object of primitive own data fields cannot acquire native Error identity by assertion. */
export function framedLiteralObject(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isObjectLiteralExpression(value) &&
    value.properties.every((property) => {
      if (!isPropertyAssignment(property)) return false;
      const name = literalName(property.name);
      if (name === undefined || name === '__proto__') return false;
      const field = unwrapped(property.initializer);
      return (
        constantValue(field) !== undefined ||
        field.kind === SyntaxKind.NullKeyword ||
        field.kind === SyntaxKind.TrueKeyword ||
        field.kind === SyntaxKind.FalseKeyword ||
        field.kind === SyntaxKind.BigIntLiteral
      );
    })
  );
}

/** Only literal own names establish the data proof; arbitrary computed entries remain opaque. */
function literalName(name: Node): string | undefined {
  if (isIdentifier(name)) return name.text;
  const key = isComputedPropertyName(name) ? name.expression : name;
  const value = isExpression(key) ? constantValue(key) : undefined;
  return value === undefined ? undefined : String(value);
}
