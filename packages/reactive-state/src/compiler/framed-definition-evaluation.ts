import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isComputedPropertyName,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isSpreadAssignment,
  type PropertyName,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedKeyNames } from './framed-keys.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Additional computed-descriptor alternatives require quiet native evaluation and original input ownership. */

/** Opaque descriptor getters, ignored argument effects and earlier work retain the previous source rule. */
export function framedDefinitionAlternativesQuiet(
  call: CallExpression,
  sources: readonly { readonly value: Expression }[],
): boolean {
  return (
    framedOriginPrefix(call) &&
    sources.every((each) => framedOriginCoowned(each.value, call)) &&
    quietInputs(call.arguments) &&
    quietDescriptors(call)
  );
}

/** Every evaluated literal field and operand stays quiet before native descriptor attributes are read. */
function quietInputs(inputs: readonly Expression[]): boolean {
  const pending = [...inputs];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const value = unwrapped(each);
    if (quietAtom(value) || isOmittedExpression(value)) continue;
    if (isArrayLiteralExpression(value)) {
      pending.push(...value.elements);
    } else if (isObjectLiteralExpression(value)) {
      if (!quietFields(value, pending)) return false;
    } else if (!quietError(value)) return false;
  }
  return true;
}

/** Local binding reads and primitive syntax do not invoke an application getter or conversion. */
function quietAtom(value: Expression): boolean {
  return (
    framedQuietPrimitive(value) || (isIdentifier(value) && frameBindingOf(value)?.keys.length === 0)
  );
}

/** Only plain own data attributes participate; accessor and spread evaluation remains opaque. */
function quietFields(value: ObjectLiteralExpression, pending: Expression[]): boolean {
  for (const field of value.properties) {
    if (isSpreadAssignment(field) || !quietName(field.name)) return false;
    if (isPropertyAssignment(field)) pending.push(field.initializer);
    else if (isShorthandPropertyAssignment(field) && isIdentifier(field.name))
      pending.push(field.name);
    else return false;
  }
  return true;
}

/** A finite computed primitive key has no callable coercion, while ordinary names are not binding reads. */
function quietName(name: PropertyName | undefined): boolean {
  if (name === undefined) return false;
  if (!isComputedPropertyName(name))
    return (
      (isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)) &&
      name.text !== '__proto__'
    );
  const value = unwrapped(name.expression);
  const keys = framedKeyNames(value);
  return keys !== undefined && keys.every((key) => key !== '__proto__') && quietAtom(value);
}

/** A fresh native Error of no message or literal written words adds no application evaluation. */
function quietError(value: Expression): boolean {
  if (!isNewExpression(value) || !framedNativeConstructor(value.expression, STANDARD_ERRORS))
    return false;
  const args = value.arguments ?? [];
  if (args.length === 0) return true;
  if (args.length !== 1 || args[0] === undefined) return false;
  const message = unwrapped(args[0]);
  return isStringLiteral(message) || isNoSubstitutionTemplateLiteral(message);
}

/** Native descriptor conversion reads every attribute, including attributes of otherwise unselected entries. */
function quietDescriptors(call: CallExpression): boolean {
  const map = call.arguments[1];
  if (map === undefined) return false;
  const value = unwrapped(map);
  if (!isObjectLiteralExpression(value)) return false;
  for (const field of value.properties) {
    let descriptor: Expression;
    if (isPropertyAssignment(field)) descriptor = field.initializer;
    else if (isShorthandPropertyAssignment(field) && isIdentifier(field.name))
      descriptor = field.name;
    else return false;
    const source = framedQuietSource(descriptor);
    if (
      source === undefined ||
      !isObjectLiteralExpression(source) ||
      !framedOriginCoowned(descriptor, call) ||
      !quietFields(source, [])
    )
      return false;
  }
  return true;
}
