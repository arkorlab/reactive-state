import {
  type Expression,
  isArrowFunction,
  isBlock,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isReturnStatement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Boxed JSON key refinements follow only completed whole constants in the consuming owner. */

const BOXES = new Set(['Number', 'String']);

/** A fresh native box has no application conversion while its literal primitive input is created. */
export function framedJsonBoxedSource(
  expression: Expression,
  consumer: Expression,
): NewExpression | undefined {
  const value = boxedAliasSource(expression, consumer);
  return value !== undefined &&
    isNewExpression(value) &&
    framedPrefixSameOwner(value, consumer) &&
    framedNativeConstructor(value.expression, BOXES) &&
    (value.arguments ?? []).every((argument) => framedQuietPrimitive(argument))
    ? value
    : undefined;
}

/** A replaced toString contributes only a synchronous direct literal text result. */
export function framedJsonBoxedConversion(
  expression: Expression,
  consumer: Expression,
): string | undefined {
  const value = boxedAliasSource(expression, consumer);
  if (
    value === undefined ||
    (!isArrowFunction(value) && !isFunctionExpression(value)) ||
    answersLater(value) ||
    value.parameters.some((parameter) => {
      return (
        !isIdentifier(parameter.name) ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined
      );
    })
  )
    return undefined;
  let returned: Expression | undefined;
  if (isBlock(value.body)) {
    const first = value.body.statements[0];
    if (first !== undefined && value.body.statements.length === 1 && isReturnStatement(first))
      returned = first.expression;
  } else returned = value.body;
  if (returned === undefined) return undefined;
  const text = unwrapped(returned);
  return isStringLiteral(text) || isNoSubstitutionTemplateLiteral(text) ? text.text : undefined;
}

/** Alias reads keep their original declaration order and never cross an object ownership boundary. */
function boxedAliasSource(expression: Expression, consumer: Expression): Expression | undefined {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      selected === undefined ||
      binding === undefined ||
      selected.keys.length > 0 ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !isIdentifier(binding.name) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined ||
      binding.end > value.pos ||
      !framedPrefixSameOwner(binding, consumer) ||
      !framedPrefixSameOwner(value, consumer) ||
      seen.has(binding)
    )
      return undefined;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return value;
}
