import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isSpreadElement,
  isVariableDeclaration,
  isVariableStatement,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { constantValue } from './numbers.ts';

/** Source-known call arguments retained by directly returned factory parameters. */

type Resolve = (name: Identifier) => Node | undefined;

/** A returned bare parameter or immutable alias keeps its call-site value and selected default. */
export function framedFactoryArguments(
  returned: Expression,
  call: CallExpression,
  fn: Answering,
  context: Resolve | { readonly resolve: Resolve; readonly given: readonly Expression[] | null },
): readonly Expression[] {
  const { resolve, given } = argumentContext(call, context);
  const parameter = returnedParameter(returned, fn, resolve);
  if (parameter === undefined || given === null) return [returned];
  const parameters = fn.parameters.filter(
    (each) => !isIdentifier(each.name) || each.name.text !== 'this',
  );
  const index = parameters.indexOf(parameter);
  if (index === -1 || parameter.dotDotDotToken !== undefined) return [returned];
  const prefix = framedArgumentPrefix(call, given);
  if (prefix.alternatives !== undefined) return [returned];
  const direct = given.every((argument) => !isSpreadElement(argument));
  if (!direct && index >= 2) return [returned];
  const argument = direct ? given[index] : prefix.values[index];
  if (argument === undefined) {
    if (prefix.unknown) return [returned];
    return parameter.initializer === undefined ? [] : [parameter.initializer];
  }
  const values = undefinedValue(argument) ? [] : [argument];
  if (parameter.initializer !== undefined && !presentValue(argument))
    values.push(parameter.initializer);
  return values;
}

/** Immutable aliases retain the original read position; visible writes leave the prior proof opaque. */
function returnedParameter(
  returned: Expression,
  fn: Answering,
  resolve: Resolve,
): ParameterDeclaration | undefined {
  let value = unwrapped(returned);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    if (framedAssignedValues(value).length > 0) return undefined;
    const declared = resolve(value);
    if (declared === undefined) return undefined;
    if (isParameterDeclaration(declared)) {
      return isIdentifier(declared.name) && fn.parameters.includes(declared) ? declared : undefined;
    }
    const initializer = constantAlias(declared);
    if (initializer === undefined) return undefined;
    value = unwrapped(initializer);
  }
  return undefined;
}

/** A whole immutable alias retains its initializer's original lexical read. */
function constantAlias(declared: Node): Expression | undefined {
  if (
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    declared.initializer === undefined
  )
    return undefined;
  const statement = declared.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? declared.initializer
    : undefined;
}

/** Native undefined and void arguments select a written parameter default. */
function undefinedValue(value: Expression): boolean {
  const actual = unwrapped(value);
  return isVoidExpression(actual) || globalPathOf(actual)?.join('.') === 'undefined';
}

/** Source-proven present values skip the default; unknown arguments retain both possibilities. */
function presentValue(value: Expression): boolean {
  const actual = unwrapped(value);
  return (
    isObjectLiteralExpression(actual) ||
    isArrayLiteralExpression(actual) ||
    isNewExpression(actual) ||
    actual.kind === SyntaxKind.NullKeyword ||
    actual.kind === SyntaxKind.TrueKeyword ||
    actual.kind === SyntaxKind.FalseKeyword ||
    constantValue(actual) !== undefined
  );
}

/** An ordinary invocation uses its own arguments; normalized wrappers retain that original call identity. */
function argumentContext(
  call: CallExpression,
  context: Resolve | { readonly resolve: Resolve; readonly given: readonly Expression[] | null },
): { readonly resolve: Resolve; readonly given: readonly Expression[] | null } {
  return typeof context === 'function' ? { resolve: context, given: call.arguments } : context;
}
