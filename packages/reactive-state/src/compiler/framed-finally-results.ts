import {
  type CallExpression,
  type Expression,
  isArrowFunction,
  isAwaitExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isStringLiteral,
  isPropertyAccessExpression,
  isReturnStatement,
  isSpreadElement,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName, frameTypeOf } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedPromiseBatchResult } from './framed-promise-batches.ts';
import { framedRaceResult } from './framed-race-results.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedValueShape } from './framed-values.ts';
import { namesLocalMemberType } from './local-type-reading.ts';
import { constantValue } from './numbers.ts';

/** Immediate native fulfillments retain possible Error origins without proving local words. */
const PROMISES = new Set(['Promise']);
const THENABLES = new Set(['Promise', 'PromiseLike']);
const UNDEFINED = new Set(['undefined']);

/** Quiet native finalizers and omitted fulfillment handlers preserve an Error possibility. */
export function framedFinallyResult(
  node: Expression,
  made: boolean,
  keys: readonly string[],
  error: (value: Expression, made: boolean, keys: readonly string[]) => boolean,
): true | undefined {
  const batch = framedPromiseBatchResult(node, made, keys, error);
  if (batch !== undefined) return batch;
  const raced = framedRaceResult(node, made, keys, error);
  if (raced !== undefined) return raced;
  const outer = unwrapped(node);
  if (!isAwaitExpression(outer)) return undefined;
  let value = unwrapped(outer.expression);
  const seen = new Set<Node>();
  let forwarded = false;
  while (isCallExpression(value) && !seen.has(value)) {
    seen.add(value);
    const receiver = forwardedReceiver(value);
    if (receiver !== undefined) {
      forwarded = true;
      value = unwrapped(receiver);
      continue;
    }
    const argument = forwarded ? resolveArgument(value) : undefined;
    return argument !== undefined && !writtenThenable(argument) && error(argument, made, keys)
      ? true
      : undefined;
  }
  return undefined;
}

/** Only an immediate member call retains a native Promise receiver proved at the chain root. */
function forwardedReceiver(call: CallExpression): Expression | undefined {
  const method = unwrapped(call.expression);
  if (!isPropertyAccessExpression(method) && !isElementAccessExpression(method)) return undefined;
  const callback = call.arguments[0];
  const name = frameMemberName(method);
  if ((name === 'then' || name === 'finally') && !quietTrailingArguments(call)) return undefined;
  if (name === 'catch' && call.arguments.slice(1).some((argument) => !quietVoidOperand(argument)))
    return undefined;
  if (name === 'then' || name === 'catch')
    return callback === undefined || undefinedHandler(callback) ? method.expression : undefined;
  if (name !== 'finally') return undefined;
  return callback === undefined ||
    ignoredFinalizer(callback) ||
    (!isSpreadElement(callback) && quietCallback(callback))
    ? method.expression
    : undefined;
}

/** A written primitive finalizer installs no callable handler and performs no application work. */
function ignoredFinalizer(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    undefinedHandler(value) ||
    (!isIdentifier(value) && quietVoidOperand(value)) ||
    value.kind === SyntaxKind.BigIntLiteral
  );
}

/** Ignored trailing operands are evaluated before a native handler is installed. */
function quietTrailingArguments(call: CallExpression): boolean {
  const given = framedArgumentPrefix(call, call.arguments, Infinity);
  return (
    !given.unknown &&
    (given.alternatives?.length ?? 0) === 0 &&
    given.values.slice(1).every((argument) => {
      const value = unwrapped(argument);
      return quietVoidOperand(value) || isArrowFunction(value) || isFunctionExpression(value);
    })
  );
}

/** Only a source-known absent fulfillment handler forwards without running application code. */
function undefinedHandler(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    framedNativeConstructor(value, UNDEFINED) ||
    (isVoidExpression(value) && quietVoidOperand(value.expression))
  );
}

/** A void binding read or literal performs no application call before the native handler runs. */
function quietVoidOperand(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isIdentifier(value) ||
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(value.kind)
  );
}

/** A source-known native resolve supplies the possible fulfillment at the chain root. */
function resolveArgument(call: CallExpression): Expression | undefined {
  const method = unwrapped(call.expression);
  if (!isPropertyAccessExpression(method) && !isElementAccessExpression(method)) return undefined;
  const argument = call.arguments[0];
  return argument !== undefined &&
    frameMemberName(method) === 'resolve' &&
    framedNativeConstructor(method.expression, PROMISES) &&
    !isSpreadElement(argument) &&
    quietTrailingArguments(call)
    ? argument
    : undefined;
}

/** Empty callbacks and primitive returns execute no application calls or thenable adoption. */
function quietCallback(node: Expression): boolean {
  const callback = unwrapped(node);
  if (!isArrowFunction(callback) && !isFunctionExpression(callback)) return false;
  if (callback.parameters.length > 0 || (callback.modifiers?.length ?? 0) > 0) return false;
  const body = callback.body;
  if (!isBlock(body)) return constantValue(body) !== undefined;
  if (body.statements.length === 0) return true;
  if (body.statements.length !== 1) return false;
  const statement = body.statements[0];
  return (
    statement !== undefined &&
    isReturnStatement(statement) &&
    (statement.expression === undefined || constantValue(statement.expression) !== undefined)
  );
}

/** Explicit native thenable declarations keep the earlier await boundary rather than claiming identity. */
function writtenThenable(value: Expression): boolean {
  const typed = frameTypeOf(value);
  if (typed !== undefined && namesLocalMemberType(typed.type, typed.keys, THENABLES)) return true;
  return framedValueShape(value).assertions.some((assertion) =>
    namesLocalMemberType(assertion.type, assertion.keys, THENABLES),
  );
}
