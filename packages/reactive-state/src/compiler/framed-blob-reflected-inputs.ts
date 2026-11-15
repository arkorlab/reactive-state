import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { quietBlobConversions } from './framed-blob-conversions.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Source-written evaluation and conversion work keeps reflected Blob origins opaque. */
const ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);
type Original = (value: Expression) => Expression | undefined;

/** All outer arguments run before construction, including ones Reflect.construct ignores. */
export function quietReflectedBlob(
  call: CallExpression,
  args: readonly Expression[],
  original: Original,
  error: (value: Expression) => boolean,
): boolean {
  const outer = framedArgumentPrefix(call, call.arguments, Infinity);
  return (
    !outer.unknown &&
    outer.alternatives === undefined &&
    quietValues(outer.values, original) &&
    quietValues(args, original) &&
    quietBlobConversions(call, args, original, error)
  );
}

/** Written literal values and aliases contain no active application conversion. */
function quietValues(args: readonly Expression[], original: Original): boolean {
  const pending = [...args];
  const seen = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(original(next) ?? next);
    if (seen.has(value)) continue;
    seen.add(value);
    const children = quietChildren(value, original);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** Primitive values, native Errors and literal containers retain their written children. */
function quietChildren(value: Expression, original: Original): readonly Expression[] | undefined {
  if (
    isOmittedExpression(value) ||
    isIdentifier(value) ||
    isStringLiteral(value) ||
    isNumericLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(value.kind)
  )
    return [];
  if (isArrayLiteralExpression(value)) return value.elements;
  if (isSpreadElement(value)) {
    const array = unwrapped(original(value.expression) ?? value.expression);
    return isArrayLiteralExpression(array) ? [array] : undefined;
  }
  if (isNewExpression(value) && framedNativeConstructor(value.expression, ERRORS))
    return value.arguments ?? [];
  return isObjectLiteralExpression(value) ? quietFields(value, original) : undefined;
}

/** Literal spreads and selected direct-return getters run no source-written mutation. */
function quietFields(
  value: ObjectLiteralExpression,
  original: Original,
): readonly Expression[] | undefined {
  const children: Expression[] = [];
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      const spread = unwrapped(original(property.expression) ?? property.expression);
      if (!isObjectLiteralExpression(spread)) return undefined;
      children.push(spread);
      continue;
    }
    const child = quietField(property);
    if (child === undefined) return undefined;
    children.push(child);
  }
  return children;
}

/** Ordinary literal fields and one-expression getter results preserve their lexical source. */
function quietField(
  property: ObjectLiteralExpression['properties'][number],
): Expression | undefined {
  if (isSpreadAssignment(property)) return undefined;
  const key = property.name;
  if (
    (!isIdentifier(key) && !isStringLiteral(key) && !isNumericLiteral(key)) ||
    key.text === '__proto__'
  )
    return undefined;
  if (isPropertyAssignment(property)) return property.initializer;
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) return property.name;
  if (!isGetAccessorDeclaration(property)) return undefined;
  const [statement, ...remaining] = property.body?.statements ?? [];
  return statement !== undefined && remaining.length === 0 && isReturnStatement(statement)
    ? statement.expression
    : undefined;
}
