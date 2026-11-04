import {
  type Expression,
  type GetAccessorDeclaration,
  isArrayLiteralExpression,
  isCallExpression,
  isNewExpression,
  type Node,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { platformOptionsThrow } from './throw-platform.ts';
import { writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** The cause getter a language error constructor necessarily reads from options written there. */

/** The options argument read by each native error constructor, called with or without new. */
const ERROR_OPTIONS: ReadonlyMap<string, number> = new Map([
  ['AggregateError', 2],
  ['Error', 1],
  ['EvalError', 1],
  ['RangeError', 1],
  ['ReferenceError', 1],
  ['SyntaxError', 1],
  ['TypeError', 1],
  ['URIError', 1],
]);

/** A surviving cause getter, where evaluating or converting another argument cannot replace it. */
function errorCauseGetter(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): GetAccessorDeclaration | undefined {
  const at = ERROR_OPTIONS.get(path);
  const argument = at === undefined ? undefined : given[at];
  if (
    argument === undefined ||
    given.some((each, index) => index !== at && !safeArgument(each, resolve))
  ) {
    return undefined;
  }
  const options = writtenOf(argument, resolve);
  return isObjectLiteralExpression(options) ? causeGetter(options, resolve) : undefined;
}

/** The last cause accessor, with setters preserving a prior getter and data properties replacing it. */
function causeGetter(
  options: ObjectLiteralExpression,
  resolve: Resolve | undefined,
): GetAccessorDeclaration | undefined {
  let seen = false;
  let getter: GetAccessorDeclaration | undefined;
  for (const property of options.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const key = causeKey(property.name, resolve);
    if (key === undefined || key === '__proto__') {
      return undefined;
    }
    if (key !== 'cause' || seen || isSetAccessorDeclaration(property)) {
      continue;
    }
    seen = true;
    if (isGetAccessorDeclaration(property)) {
      getter = property;
    }
  }
  return getter;
}

/** A written property key, null for a symbol the constructor ignores, or none of an unknown key. */
function causeKey(name: PropertyName, resolve: Resolve | undefined): string | null | undefined {
  if (isIdentifier(name)) {
    return name.text;
  }
  if (!isComputedPropertyName(name)) {
    return literalKey(name);
  }
  if (isSymbolWritten(name.expression, resolve)) {
    return null;
  }
  const key = constantValue(name.expression, resolve);
  return key === undefined ? undefined : String(key);
}

/** Whether an argument can be evaluated and converted without running application code. */
function safeArgument(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  return isArrayLiteralExpression(value)
    ? value.elements.every((each) => safeScalar(each, resolve))
    : safeScalar(value, resolve);
}

/** A scalar whose evaluation and conversion cannot replace a cause property. */
function safeScalar(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  return (
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    (isIdentifier(value) && globalPath(value)?.join('.') === 'undefined') ||
    constantValue(value, resolve) !== undefined
  );
}

/** Whether a native error call or a platform construction invokes an options getter that throws. */
export function optionsThrowing(
  node: Node,
  resolve: Resolve | undefined,
  throws: (node: Node) => boolean,
): boolean {
  if (!isCallExpression(node) && !isNewExpression(node)) {
    return false;
  }
  const path = globalPath(writtenOf(node.expression, resolve))?.join('.') ?? '';
  const given = node.arguments ?? [];
  const getter = errorCauseGetter(path, given, resolve);
  return (
    (getter !== undefined && throws(getter)) ||
    (isNewExpression(node) && platformOptionsThrow(path, given, resolve, throws))
  );
}
