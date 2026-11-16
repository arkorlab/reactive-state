import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isExpressionStatement,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isReturnStatement,
  isStringLiteral,
  isSpreadElement,
  isVariableStatement,
  type Node,
  type Statement,
} from 'typescript/ast';

import { type Answering, answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { framedArrayString } from './framed-arrays.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedGroupByOwnedInput } from './framed-groupby-inputs.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietData,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { framedAssignedValues } from './framed-writes.ts';

/** Native Object.groupBy converts synchronous callback returns to property keys after finite known iteration. */

const GROUP_BY = new Set(['Object.groupBy']);

/** Empty input, async callbacks, application prefixes and unresolved invocations add no key-origin proof. */
export function framedGroupByKeyText(
  node: Node,
  error: (value: Expression, keys?: readonly string[]) => boolean,
  typed: (value: Expression) => boolean,
): boolean {
  if (
    !isCallExpression(node) ||
    !framedNativeConstructor(node.expression, GROUP_BY) ||
    !framedQuietTextPrefix(node, GROUP_BY) ||
    !quietNativeMember(node.expression)
  )
    return false;
  const prefix = framedArgumentPrefix(node, node.arguments, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return false;
  const input = prefix.values[0];
  const callback = prefix.values[1];
  if (
    input === undefined ||
    callback === undefined ||
    !nonemptyQuietInput(input) ||
    !framedQuietInputs(prefix.values.slice(2), GROUP_BY)
  )
    return false;
  const fn = callbackSource(callback);
  const value = fn === undefined ? undefined : quietCallbackResult(fn);
  if (value === undefined) return false;
  const coownedError = (each: Expression, keys?: readonly string[]) =>
    framedOriginCoowned(framedGroupByOwnedInput(each, value), node) && error(each, keys);
  return (
    (framedNativeErrorInput(value, node) && coownedError(value)) ||
    (framedQuietArrayWords(value, coownedError, node) &&
      framedArrayString(value, { error: coownedError, typed }, node))
  );
}

/** A computed native member name must not evaluate an ignored application effect before grouping. */
function quietNativeMember(expression: Expression): boolean {
  let value = framedQuietSource(expression);
  if (value === undefined) return false;
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
      return false;
    value = unwrapped(value.expression);
  }
  return isIdentifier(value);
}

/** Literal array iteration is nonempty only after all finite literal spreads are expanded. */
function nonemptyQuietInput(value: Expression): boolean {
  const source = framedQuietSource(value);
  if (source === undefined || !isArrayLiteralExpression(source) || !framedQuietData(source))
    return false;
  const pending = [source];
  const seen = new Set<Expression>();
  let found = false;
  for (let array = pending.pop(); array !== undefined; array = pending.pop()) {
    if (seen.has(array)) continue;
    seen.add(array);
    for (const item of array.elements) {
      if (!isSpreadElement(item)) {
        found = true;
        continue;
      }
      const spread = framedQuietSource(item.expression);
      if (spread === undefined || !isArrayLiteralExpression(spread)) return false;
      pending.push(spread);
    }
  }
  return found;
}

/** Immutable literal functions and an unchanged named declaration retain their original body. */
function callbackSource(expression: Expression): Answering | undefined {
  const value = framedQuietSource(expression);
  if (value === undefined) return undefined;
  if (isArrowFunction(value) || isFunctionExpression(value)) return value;
  if (!isIdentifier(value) || framedAssignedValues(value).length > 0) return undefined;
  const declared = frameDeclarationOf(value);
  return declared !== undefined && isFunctionDeclaration(declared) ? declared : undefined;
}

/** Callback parameter initialization and returned expression evaluation must run no opaque application code. */
function quietCallbackResult(fn: Answering): Expression | undefined {
  if (
    answersLater(fn) ||
    fn.parameters.some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    ) ||
    fn.body === undefined
  )
    return undefined;
  const body = fn.body;
  if (!isBlock(body)) return framedQuietInputs([body], GROUP_BY) ? body : undefined;
  const statements = [...body.statements];
  const returned = statements.pop();
  if (
    returned === undefined ||
    !isReturnStatement(returned) ||
    returned.expression === undefined ||
    statements.some((statement) => !quietCallbackPrefix(statement)) ||
    !framedQuietInputs([returned.expression], GROUP_BY)
  )
    return undefined;
  return returned.expression;
}

/** Literal directives and quiet whole constants do not mutate the returned Error before key conversion. */
function quietCallbackPrefix(statement: Statement): boolean {
  if (isExpressionStatement(statement) && isStringLiteral(statement.expression)) return true;
  return (
    isVariableStatement(statement) &&
    /^const\b/u.test(statement.declarationList.getText(statement.getSourceFile())) &&
    statement.declarationList.declarations.every((declaration) => {
      return (
        isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        framedQuietInputs([declaration.initializer], GROUP_BY)
      );
    })
  );
}
