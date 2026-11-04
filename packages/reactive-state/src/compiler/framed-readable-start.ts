import {
  type ArrowFunction,
  type Expression,
  type FunctionExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type MethodDeclaration,
  type NewExpression,
  type ParameterDeclaration,
  type PropertyName,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import {
  framedQuietData,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** A closed native ReadableStream start callback retains its first synchronously enqueued chunk. */

const STREAMS = new Set(['ReadableStream']);
const ERRORS = new Set([
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
type StartCallback = ArrowFunction | FunctionExpression | MethodDeclaration;

export interface ReadableStart {
  readonly value: Expression;
  readonly owned: Expression;
}

/** Only source-written start and a quiet high-water mark precede the first default read. */
export function framedReadableStart(created: NewExpression): ReadableStart | undefined {
  if (!framedNativeConstructor(created.expression, STREAMS)) return undefined;
  const args = created.arguments ?? [];
  const source = args[0];
  if (source === undefined || args.slice(1).some((value) => !framedQuietData(value)))
    return undefined;
  const strategy = args[1];
  if (strategy !== undefined && !quietStrategy(strategy)) return undefined;
  const callback = sourceStart(source);
  return callback === undefined ? undefined : queuedByStart(callback);
}

/** A single directly written start callback has no opaque source dictionary access. */
function sourceStart(source: Expression): StartCallback | undefined {
  const literal = unwrapped(source);
  if (!isObjectLiteralExpression(literal) || literal.properties.length !== 1) return undefined;
  const first = literal.properties[0];
  if (
    first === undefined ||
    (!isMethodDeclaration(first) && !isPropertyAssignment(first)) ||
    !quietWrittenName(first.name, 'start')
  )
    return undefined;
  if (isMethodDeclaration(first)) return first;
  const value = unwrapped(first.initializer);
  return isArrowFunction(value) || isFunctionExpression(value) ? value : undefined;
}

/** Native queue-size callbacks and dictionary coercions remain outside the source proof. */
function quietStrategy(expression: Expression): boolean {
  const value = unwrapped(expression);
  return (
    isObjectLiteralExpression(value) &&
    value.properties.every((property) => {
      return (
        isPropertyAssignment(property) &&
        quietWrittenName(property.name, 'highWaterMark') &&
        validHighWaterMark(property.initializer)
      );
    })
  );
}

/** A literal finite nonnegative queue limit lets native construction reach start. */
function validHighWaterMark(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  if (value === undefined) return false;
  if (isNumericLiteral(value)) return Number.isFinite(Number(value.text));
  if (!isPrefixUnaryExpression(value) || value.operator !== SyntaxKind.PlusToken) return false;
  const operand = unwrapped(value.operand);
  return isNumericLiteral(operand) && Number.isFinite(Number(operand.text));
}

/** A selected dictionary name cannot run an application conversion before the native callback. */
function quietWrittenName(name: PropertyName, key: string): boolean {
  return (
    writtenArrayKey(name) === key &&
    (!isComputedPropertyName(name) || framedQuietPrimitive(name.expression))
  );
}

/** A simple native controller parameter and a closed statement list cannot run application work. */
function queuedByStart(callback: StartCallback): ReadableStart | undefined {
  const controller = startController(callback);
  const body = callback.body;
  if (controller === undefined || body === undefined || !isBlock(body)) return undefined;
  const state: { value: Expression | undefined; closed: boolean } = {
    value: undefined,
    closed: false,
  };
  for (const statement of body.statements) {
    if (quietStartStatement(statement)) continue;
    const call = controllerCall(statement, controller);
    if (call === undefined || !queueStep(call, state)) return undefined;
  }
  const { value } = state;
  return value === undefined || !quietChunk(value)
    ? undefined
    : { value, owned: wholeStartAlias(value, callback) };
}

/** Native enqueue and close are the only completed calls in the closed callback. */
function queueStep(
  call: { readonly name: string | undefined; readonly args: readonly Expression[] },
  state: { value: Expression | undefined; closed: boolean },
): boolean {
  if (state.closed) return false;
  if (call.name === 'close' && call.args.length === 0) {
    state.closed = true;
    return true;
  }
  if (call.name !== 'enqueue' || state.value !== undefined || call.args.length !== 1) return false;
  const value = call.args[0];
  if (value === undefined) return false;
  state.value = value;
  return true;
}

/** A synchronous start receives one native controller without application parameter initialization. */
function startController(callback: StartCallback): ParameterDeclaration | undefined {
  const parameters = callback.parameters;
  const controller = parameters[0];
  return controller !== undefined &&
    parameters.length === 1 &&
    isIdentifier(controller.name) &&
    controller.initializer === undefined &&
    controller.dotDotDotToken === undefined &&
    !answersLater(callback)
    ? controller
    : undefined;
}

/** Directives and whole const creation perform no implicit conversion or application invocation. */
function quietStartStatement(statement: Statement): boolean {
  if (isExpressionStatement(statement)) return isStringLiteral(statement.expression);
  return (
    isVariableStatement(statement) &&
    /^const\b/u.test(statement.declarationList.getText(statement.getSourceFile())) &&
    statement.declarationList.declarations.every((declaration) => {
      return (
        isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        quietChunk(declaration.initializer)
      );
    })
  );
}

/** Enqueue stores a value without converting it, and native close invokes no source callback here. */
function controllerCall(
  statement: Statement,
  controller: ParameterDeclaration,
): { readonly name: string | undefined; readonly args: readonly Expression[] } | undefined {
  if (!isExpressionStatement(statement) || !isCallExpression(statement.expression))
    return undefined;
  const call = statement.expression;
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  if (isElementAccessExpression(member) && !framedQuietPrimitive(member.argumentExpression))
    return undefined;
  const receiver = unwrapped(member.expression);
  if (!isIdentifier(receiver)) return undefined;
  const source = frameBindingOf(receiver);
  return source?.binding === controller && source.keys.length === 0
    ? { name: frameMemberName(member), args: call.arguments }
    : undefined;
}

/** A chunk creation reads only literals, unchanged bindings or native Error literal arguments. */
function quietChunk(value: Expression): boolean {
  return framedQuietInputs([value], ERRORS);
}

/** Callback-local whole aliases are projected only for the separate lexical ownership guard. */
function wholeStartAlias(expression: Expression, callback: StartCallback): Expression {
  let value = expression;
  const seen = new Set<Expression>();
  for (;;) {
    const name = unwrapped(value);
    if (!isIdentifier(name) || seen.has(name)) return value;
    seen.add(name);
    const source = frameBindingOf(name);
    const binding = source?.binding;
    if (
      binding === undefined ||
      source?.keys.length !== 0 ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      binding.initializer === undefined ||
      binding.pos < callback.pos ||
      binding.end > callback.end ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    )
      return value;
    value = binding.initializer;
  }
}
