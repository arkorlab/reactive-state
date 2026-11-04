import {
  type Expression,
  isArrayLiteralExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isStringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';

/** A stringify replacer that invokes no callback or property-list getter or coercion hook. */
export function ignoresJsonReplacer(node: Expression | undefined): boolean {
  if (node === undefined) {
    return true;
  }
  const value = unwrapped(node);
  if (isArrayLiteralExpression(value)) {
    return value.elements.every((each) => plainKey(unwrapped(each)));
  }
  return (
    plainKey(value) ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    (isIdentifier(value) && globalOf(value) === 'undefined')
  );
}

/** A property-list entry whose value and text conversion execute no application code. */
function plainKey(value: Expression): boolean {
  return (
    isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value) || isNumericLiteral(value)
  );
}
