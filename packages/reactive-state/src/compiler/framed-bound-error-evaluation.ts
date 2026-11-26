import {
  type CallExpression,
  type Expression,
  isBlock,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isPropertyAccessExpression,
  isReturnStatement,
  isStringLiteral,
  isVariableStatement,
  type NewExpression,
  type Statement,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameMemberName } from './framed-bindings.ts';
import {
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Added bound word origins require quiet evaluation through the actual native invocation. */

const ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);

/** Bound and runtime arguments are evaluated even when the native constructor ignores their values. */
export function quietBoundErrorEvaluation(
  node: CallExpression | NewExpression,
  bound: CallExpression,
): boolean {
  const owner = executionOwner(node);
  if (!isAnswering(owner) || executionOwner(bound) !== owner) return false;
  if (
    owner.parameters.some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  )
    return false;
  if (!framedQuietInputs([...bound.arguments, ...(node.arguments ?? [])], ERRORS)) return false;
  const { body } = owner;
  if (body === undefined) return false;
  if (!isBlock(body)) return directReturnedCall(body, node);
  const statements = [...body.statements];
  const returned = statements.pop();
  return (
    returned !== undefined &&
    isReturnStatement(returned) &&
    returned.expression !== undefined &&
    directReturnedCall(returned.expression, node) &&
    statements.every((statement) => quietBoundPrefix(statement, bound))
  );
}

/** A single returned member chain introduces no earlier call or computed-key side effect. */
function directReturnedCall(expression: Expression, node: Expression): boolean {
  let value = unwrapped(expression);
  while (value !== unwrapped(node)) {
    if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
    if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
      return false;
    if (frameMemberName(value) === undefined) return false;
    value = unwrapped(value.expression);
  }
  return true;
}

/** Literal directives and quiet whole constants can precede a captured native bind result. */
function quietBoundPrefix(statement: Statement, bound: CallExpression): boolean {
  if (isExpressionStatement(statement) && isStringLiteral(statement.expression)) return true;
  if (
    !isVariableStatement(statement) ||
    !/^const\b/u.test(statement.declarationList.getText(statement.getSourceFile()))
  )
    return false;
  return statement.declarationList.declarations.every((declaration) => {
    const { initializer } = declaration;
    return (
      isIdentifier(declaration.name) &&
      initializer !== undefined &&
      (framedQuietSource(initializer, false) === bound || framedQuietInputs([initializer], ERRORS))
    );
  });
}
