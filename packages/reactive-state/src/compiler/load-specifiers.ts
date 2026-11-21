import {
  type Expression,
  isAsExpression,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTypeAssertion,
} from 'typescript/ast';

/**
 * The module a load at run time — `import('./x')`, `require('./x')` — names, where the specifier is
 * written as a literal: text, or a template with no substitution, past the parentheses, `as`,
 * `satisfies`, `!` and assertions in angle brackets around it, which change nothing of what it names.
 * None where the code computes it, or the call is given none.
 */
export function literalSpecifier(argument: Expression | undefined): string | undefined {
  let each = argument;
  while (
    each !== undefined &&
    (isParenthesizedExpression(each) ||
      isAsExpression(each) ||
      isSatisfiesExpression(each) ||
      isNonNullExpression(each) ||
      isTypeAssertion(each))
  ) {
    each = each.expression;
  }
  return each !== undefined && (isStringLiteral(each) || isNoSubstitutionTemplateLiteral(each))
    ? each.text
    : undefined;
}
