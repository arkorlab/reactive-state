import {
  type Expression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isStringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedCondition, framedNativeConstructor } from './framed-sources.ts';

/** Native undefined and quiet literal/binding reads select only source-written abort if arms. */
const UNDEFINED = new Set(['undefined']);

/** Other conditions may execute application code and keep the abort-prefix proof opaque. */
export function framedAbortCondition(
  node: Expression,
): { readonly selected: boolean | undefined } | undefined {
  let value = unwrapped(node);
  let negated = false;
  while (isPrefixUnaryExpression(value) && value.operator === SyntaxKind.ExclamationToken) {
    value = unwrapped(value.operand);
    negated = !negated;
  }
  if (
    !(
      isIdentifier(value) ||
      isNumericLiteral(value) ||
      isStringLiteral(value) ||
      isNoSubstitutionTemplateLiteral(value) ||
      [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(value.kind)
    )
  )
    return undefined;
  const selected = framedNativeConstructor(value, UNDEFINED) ? false : framedCondition(value);
  return { selected: selected === undefined ? undefined : selected !== negated };
}
