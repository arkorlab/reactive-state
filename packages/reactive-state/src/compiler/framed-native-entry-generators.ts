import {
  type Expression,
  type FunctionExpression,
  type GetAccessorDeclaration,
  isArrayLiteralExpression,
  isArrowFunction,
  isComputedPropertyName,
  isExpressionStatement,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPropertyAssignment,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isYieldExpression,
  type MethodDeclaration,
  type ObjectLiteralExpression,
  type PropertyName,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedQuietGetter, framedQuietInputs } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Closed native entry generators retain their tuple cells without inferring callable results. */

const ITERATORS = new Set(['Symbol.iterator']);
const NATIVES = new Set(['Headers', 'Symbol.iterator', 'URLSearchParams']);

type Generator = FunctionExpression | MethodDeclaration;

interface EntryCells {
  readonly key: Expression;
  readonly value: Expression;
}

interface NativeEntry extends EntryCells {
  readonly active: boolean;
}

/** One literal iterator executes only finite direct entry yields; callers qualify every value. */
export function framedNativeEntryGenerator(
  record: ObjectLiteralExpression,
): readonly NativeEntry[] | undefined {
  let entries: readonly NativeEntry[] | undefined;
  for (const property of record.properties) {
    if (isSpreadAssignment(property) || !quietName(property.name)) return undefined;
    if (nativeIteratorName(property.name)) {
      if (entries !== undefined) return undefined;
      entries = iteratorEntries(property);
      if (entries === undefined) return undefined;
    } else if (!quietFieldCreation(property)) return undefined;
  }
  return entries;
}

/** Computed names retain only literal primitive keys or the unshadowed native iterator symbol. */
function quietName(name: PropertyName | undefined): boolean {
  if (name === undefined) return false;
  if (isComputedPropertyName(name))
    return framedMapKey(name.expression) !== undefined || nativeIteratorName(name);
  return (
    (isIdentifier(name) ||
      isStringLiteral(name) ||
      isNoSubstitutionTemplateLiteral(name) ||
      isNumericLiteral(name)) &&
    name.text !== '__proto__'
  );
}

/** A textual Symbol.iterator field does not replace the native iterable protocol. */
function nativeIteratorName(name: PropertyName | undefined): boolean {
  return (
    name !== undefined &&
    isComputedPropertyName(name) &&
    framedNativeConstructor(name.expression, ITERATORS)
  );
}

/** Ordinary methods and accessors are created without executing their deferred bodies. */
function quietFieldCreation(property: ObjectLiteralExpression['properties'][number]): boolean {
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return framedQuietInputs([property.name], NATIVES);
  if (isPropertyAssignment(property)) {
    const value = unwrapped(property.initializer);
    return (
      isFunctionExpression(value) || isArrowFunction(value) || framedQuietInputs([value], NATIVES)
    );
  }
  return (
    isMethodDeclaration(property) ||
    isGetAccessorDeclaration(property) ||
    isSetAccessorDeclaration(property)
  );
}

/** Direct generator fields and a getter returning one fresh generator have no lookup effect. */
function iteratorEntries(
  property: ObjectLiteralExpression['properties'][number],
): readonly NativeEntry[] | undefined {
  if (isMethodDeclaration(property)) return generatorEntries(property);
  if (isPropertyAssignment(property)) {
    const value = unwrapped(property.initializer);
    return isFunctionExpression(value) ? generatorEntries(value) : undefined;
  }
  return isGetAccessorDeclaration(property) ? getterEntries(property) : undefined;
}

/** A direct getter return creates the generator without invoking a supplied callable. */
function getterEntries(getter: GetAccessorDeclaration): readonly NativeEntry[] | undefined {
  const result = framedQuietGetter(getter);
  if (result === undefined) return undefined;
  const value = unwrapped(result);
  return isFunctionExpression(value) ? generatorEntries(value) : undefined;
}

/** Every generator step is a direct pair yield with a primitive key, or a quiet terminal return. */
function generatorEntries(value: Generator): readonly NativeEntry[] | undefined {
  const body = value.body;
  if (body === undefined || !closedGenerator(value)) return undefined;
  const entries: NativeEntry[] = [];
  let active = true;
  for (const statement of body.statements) {
    if (isReturnStatement(statement)) {
      if (statement.expression !== undefined && framedMapKey(statement.expression) === undefined)
        return undefined;
      active = false;
      continue;
    }
    const cells = yieldedEntry(statement);
    if (cells === undefined) return undefined;
    entries.push({ ...cells, active });
  }
  return entries;
}

/** An empty parameter list and synchronous generator syntax add no default or suspension work. */
function closedGenerator(value: Generator): boolean {
  return (
    value.asteriskToken !== undefined &&
    value.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) !== true &&
    value.parameters.length === 0
  );
}

/** Only a direct nondelegated two-cell yield has a known native entry key. */
function yieldedEntry(statement: Statement): EntryCells | undefined {
  if (!isExpressionStatement(statement)) return undefined;
  const expression = unwrapped(statement.expression);
  if (
    !isYieldExpression(expression) ||
    expression.asteriskToken !== undefined ||
    expression.expression === undefined
  )
    return undefined;
  const tuple = unwrapped(expression.expression);
  if (!isArrayLiteralExpression(tuple) || tuple.elements.length !== 2) return undefined;
  const key = tuple.elements[0];
  const value = tuple.elements[1];
  return key === undefined || value === undefined || framedMapKey(key) === undefined
    ? undefined
    : { key, value };
}
