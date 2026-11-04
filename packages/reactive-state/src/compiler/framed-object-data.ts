import {
  type Expression,
  type CallExpression,
  isCallExpression,
  isExpression,
  isIdentifier,
  isComputedPropertyName,
  type PropertyName,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { framedArgumentPrefix, framedKeyNames } from './framed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Literal data descriptors on a fresh native error retain their written member values. */
export function framedObjectData(
  node: Expression,
  members: readonly string[] | undefined,
  errors: ReadonlySet<string>,
): boolean {
  const value = unwrapped(node);
  if (members === undefined || members.length === 0 || !isCallExpression(value)) return false;
  const prefix = framedArgumentPrefix(value);
  if (prefix.unknown || (prefix.alternatives?.length ?? 0) > 0) return false;
  const [target, key] = prefix.values;
  if (target === undefined) return false;
  const path = globalPathOf(unwrapped(value.expression))?.join('.');
  if (path === 'Object.create') return key !== undefined && literalDescriptors(key, members);
  if (path === 'Object.setPrototypeOf') return literalTargetData(target, members);
  const made = unwrapped(target);
  if (!isNewExpression(made) || !framedNativeConstructor(made.expression, errors)) return false;
  if (path === 'Object.defineProperty') return singularData(value, members, prefix.values);
  return (
    path === 'Object.defineProperties' && key !== undefined && literalDescriptors(key, members)
  );
}

/** A fresh literal target's final own primitive fields hide its installed prototype at those names. */
function literalTargetData(node: Expression, members: readonly string[]): boolean {
  const value = unwrapped(node);
  if (!isObjectLiteralExpression(value)) return false;
  const fixed = new Set<string>();
  for (const property of value.properties) {
    if (!isPropertyAssignment(property)) return false;
    const name = writtenKey(property.name);
    if (name === undefined) return false;
    if (literalValue(property.initializer)) fixed.add(name);
    else fixed.delete(name);
  }
  return members.every((member) => fixed.has(member));
}

/** A direct singular definition supplies the selected key and its literal descriptor. */
function singularData(
  call: CallExpression,
  members: readonly string[],
  values: readonly Expression[],
): boolean {
  const [target, key] = values;
  const descriptor = call.arguments[2];
  if (key === undefined || descriptor === undefined || isSpreadElement(descriptor)) return false;
  const keys = framedKeyNames(key);
  return (
    keys?.length === 1 &&
    members.every((member) => member === keys[0]) &&
    target === call.arguments[0] &&
    key === call.arguments[1] &&
    literalDescriptor(descriptor)
  );
}

/** A fully written descriptor map supplies every selected member without an unknown overwrite. */
function literalDescriptors(node: Expression, members: readonly string[]): boolean {
  const value = unwrapped(node);
  if (!isObjectLiteralExpression(value)) return false;
  const fixed = new Set<string>();
  for (const property of value.properties) {
    if (!isPropertyAssignment(property)) return false;
    const key = writtenKey(property.name);
    if (key === undefined) return false;
    if (literalDescriptor(property.initializer)) fixed.add(key);
    else fixed.delete(key);
  }
  return members.every((member) => fixed.has(member));
}

/** A plain data descriptor has no getter and gives its final value as primitive literal syntax. */
function literalDescriptor(node: Expression): boolean {
  const value = unwrapped(node);
  if (!isObjectLiteralExpression(value)) return false;
  let fixed = false;
  for (const property of value.properties) {
    if (!isPropertyAssignment(property)) return false;
    const key = writtenKey(property.name);
    if (key === undefined || ['get', 'set'].includes(key)) return false;
    if (key === 'value') fixed = literalValue(property.initializer);
  }
  return fixed;
}

/** Primitive literal descriptor values do not expose engine-selected words or frames. */
function literalValue(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isNumericLiteral(value) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword
  );
}

/** A written property name retains only one known source key. */
function writtenKey(name: PropertyName): string | undefined {
  if (isIdentifier(name)) return name.text;
  const key = isComputedPropertyName(name) ? name.expression : name;
  if (!isExpression(key)) return undefined;
  const keys = framedKeyNames(key);
  return keys?.length === 1 ? keys[0] : undefined;
}
