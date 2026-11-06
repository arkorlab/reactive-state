import {
  type Expression,
  isArrayLiteralExpression,
  type ArrayLiteralExpression,
  isIdentifier,
  isStringLiteral,
  isNumericLiteral,
  isNoSubstitutionTemplateLiteral,
  type PropertyName,
  type ObjectLiteralElementLike,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf } from './framed-bindings.ts';

/** Definite omitted or undefined constructor inputs, before selecting a written default. */

interface DefaultInput {
  readonly value: Expression;
  readonly keys: readonly string[];
  readonly any?: boolean;
}

/** Object.prototype members are present even when an ordinary literal writes no own field. */
const INHERITED: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/** Whether every supplied candidate selects undefined, or the argument was omitted. */
export function framedDefaultTaken(
  values: readonly DefaultInput[],
  keys: readonly string[] = [],
): boolean {
  return values.every(
    (each) => each.any !== true && missingValue(each.value, [...each.keys, ...keys]),
  );
}

/** A source literal's missing member or lexical native undefined, without inferring calls. */
function missingValue(expression: Expression, keys: readonly string[]): boolean {
  let value = unwrapped(expression);
  const remaining = [...keys];
  while (remaining.length > 0) {
    const key = remaining.shift();
    if (key === undefined) return false;
    const selected = literalMember(value, key);
    if (selected === null) return remaining.length === 0;
    if (selected === undefined) return false;
    value = unwrapped(selected);
  }
  return undefinedValue(value);
}

/** A finite own literal member; null for a proven absent ordinary field, undefined if opaque. */
function literalMember(value: Expression, key: string): Expression | null | undefined {
  if (isArrayLiteralExpression(value)) return arrayMember(value, key);
  if (!isObjectLiteralExpression(value)) return undefined;
  let selected: Expression | null = null;
  for (const property of value.properties) {
    const entry = defaultEntry(property);
    if (entry === undefined) return undefined;
    if (entry.name === key) selected = entry.value;
  }
  return selected === null && INHERITED.has(key) ? undefined : selected;
}

/** A literal original property name, without evaluating computed keys. */
function literalPropertyName(name: PropertyName): string | undefined {
  return isIdentifier(name) ||
    isStringLiteral(name) ||
    isNumericLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined;
}

/** Whole immutable aliases may prove lexical undefined, without projecting mutable members. */
function undefinedAlias(value: Expression): Expression | undefined {
  if (!isIdentifier(value)) return undefined;
  const selected = frameBindingOf(value);
  const binding = selected?.binding;
  if (binding === undefined || selected?.keys.length !== 0) return undefined;
  if (!isVariableDeclaration(binding) || !isVariableDeclarationList(binding.parent))
    return undefined;
  return /^const\s/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding.initializer
    : undefined;
}

/** A finite ordinary array's own index or a hole, without custom iteration. */
function arrayMember(value: ArrayLiteralExpression, key: string): Expression | null | undefined {
  if (value.elements.some((each) => each.kind === SyntaxKind.SpreadElement)) return undefined;
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) return undefined;
  const selected = value.elements[index];
  return selected === undefined || isOmittedExpression(selected) ? null : selected;
}

/** Lexical native undefined or void through whole immutable aliases, with cycles left opaque. */
function undefinedValue(expression: Expression): boolean {
  let value = unwrapped(expression);
  const seen = new Set<Expression>();
  while (!seen.has(value)) {
    seen.add(value);
    if (isVoidExpression(value) || globalPathOf(value)?.join('.') === 'undefined') return true;
    const source = undefinedAlias(value);
    if (source === undefined) return false;
    value = unwrapped(source);
  }
  return false;
}

/** One ordinary own data field, excluding application accessors and computed/prototype syntax. */
function defaultEntry(
  property: ObjectLiteralElementLike,
): { readonly name: string; readonly value: Expression } | undefined {
  if (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property)) return undefined;
  const name = literalPropertyName(property.name);
  if (name === undefined || name === '__proto__') return undefined;
  if (isPropertyAssignment(property)) return { name, value: property.initializer };
  return isIdentifier(property.name) ? { name, value: property.name } : undefined;
}
