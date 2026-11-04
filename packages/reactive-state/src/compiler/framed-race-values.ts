import {
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isSpreadAssignment,
  isTypeReferenceNode,
  isQualifiedName,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName, frameTypeOf } from './framed-bindings.ts';
import { quietErrorConstruction } from './framed-copy-guards.ts';
import { iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Source-known immediately fulfilled race inputs preserve native resolve envelopes and their value. */

const PROMISES = new Set(['Promise']);
const UNDEFINED = new Set(['undefined']);
const PRIMITIVES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.UndefinedKeyword,
]);

export interface RaceInput {
  readonly value: Expression | undefined;
}

/**
 * Native resolve of a proven non-thenable, a quiet native Error construction included, is already
 * fulfilled before race or any installs its reactions.
 */
export function framedRaceInput(expression: Expression): RaceInput | undefined {
  let value = unwrapped(expression);
  const seen = new Set<Expression>();
  while (isCallExpression(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const method = unwrapped(value.expression);
    if (
      (!isPropertyAccessExpression(method) && !isElementAccessExpression(method)) ||
      frameMemberName(method) !== 'resolve' ||
      !framedNativeConstructor(method.expression, PROMISES) ||
      !iteratorQuietValues(value.arguments.slice(1))
    )
      return undefined;
    const argument = value.arguments[0];
    if (argument === undefined) return { value: undefined };
    value = unwrapped(argument);
  }
  if (isOmittedExpression(value)) return { value: undefined };
  return (iteratorQuietValues([value]) && immediateValue(value)) || quietErrorConstruction(value)
    ? { value }
    : undefined;
}

/** Native promises observe no application then getter on a written primitive or plain fresh shape. */
function immediateValue(value: Expression): boolean {
  if (
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    framedNativeConstructor(value, UNDEFINED) ||
    isArrayLiteralExpression(value)
  )
    return true;
  if (isObjectLiteralExpression(value)) {
    return value.properties.every((field) => {
      if (isSpreadAssignment(field)) return false;
      const name = field.name;
      return (
        (isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)) &&
        name.text !== 'then' &&
        name.text !== '__proto__'
      );
    });
  }
  const selected = frameTypeOf(value);
  if (selected === undefined || selected.keys.length > 0) return false;
  if (PRIMITIVES.has(selected.type.kind)) return true;
  if (!isTypeReferenceNode(selected.type)) return false;
  const name = selected.type.typeName;
  if (isQualifiedName(name)) return STANDARD_ERRORS.has(qualifiedBuiltinName(name) ?? '');
  return localTypeBinding(name) === undefined && STANDARD_ERRORS.has(name.text);
}
