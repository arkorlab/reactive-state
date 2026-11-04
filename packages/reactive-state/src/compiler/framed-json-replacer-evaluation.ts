import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** A prototype hook replacement retains the actual JSON consumer's complete evaluated prefix. */

const NATIVES = new Set([
  'JSON.stringify',
  'Object.assign',
  'Object.getPrototypeOf',
  'Reflect.apply',
]);
const STRINGIFY = new Set(['JSON.stringify']);
const ERRORS = new Set(STANDARD_ERRORS);

interface ReplacerEvaluation {
  readonly call: CallExpression;
  readonly args: readonly Expression[];
  readonly comma: BinaryExpression;
  readonly mutation: CallExpression;
  readonly prototypeRead: CallExpression;
  readonly creations: readonly Expression[];
  readonly returned: Expression;
}

/** Every original argument stays quiet before an unchanged Error is read at the real consumer. */
export function quietJsonReplacerEvaluation(context: ReplacerEvaluation): boolean {
  const { call, returned } = context;
  if (
    !quietCallee(call.expression) ||
    !framedOriginCoowned(returned, call) ||
    !framedQuietOwnerPrefix(call, {
      primitive: framedQuietPrimitive,
      value: (value) => framedNativeConstructor(value, NATIVES),
      construct: quietError,
    })
  )
    return false;
  const unconverted = new Set<Identifier>();
  if (!quietOperands(context, unconverted)) return false;
  const value = unwrapped(returned);
  return (
    quietError(value) ||
    framedNativeErrorInput(returned, call, {
      consumer: call,
      unconverted,
      consumed: new Set(),
    })
  );
}

/** Literal native caller keys retain their written evaluation rather than executing an object key. */
function quietCallee(expression: Expression): boolean {
  const value = unwrapped(expression);
  if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
    return false;
  if (framedNativeConstructor(value, NATIVES)) return true;
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
  const name = frameMemberName(value);
  return (
    (name === 'call' || name === 'apply') && framedNativeConstructor(value.expression, STRINGIFY)
  );
}

/** The two exact proved native calls are the only application-capable evaluations admitted here. */
function quietOperands(context: ReplacerEvaluation, unconverted: Set<Identifier>): boolean {
  const pending = [...context.call.arguments, ...context.args, ...context.creations];
  const seen = new Set<Expression>();
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at);
    if (seen.has(value)) continue;
    seen.add(value);
    if (value === context.comma) pending.push(context.comma.left, context.comma.right);
    else if (
      isCallExpression(value) &&
      (value === context.mutation || value === context.prototypeRead)
    ) {
      if (!quietCallee(value.expression)) return false;
      pending.push(...value.arguments);
    } else if (isIdentifier(value)) unconverted.add(value);
    else if (!quietValue(value, pending)) return false;
  }
  return true;
}

/** Literal creation is quiet; function bodies remain deferred until the separately proved hook call. */
function quietValue(value: Expression, pending: Expression[]): boolean {
  if (
    framedQuietPrimitive(value) ||
    isOmittedExpression(value) ||
    framedNativeConstructor(value, NATIVES) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    quietError(value)
  )
    return true;
  if (isArrayLiteralExpression(value)) {
    pending.push(...value.elements);
    return true;
  }
  if (isObjectLiteralExpression(value)) return quietFields(value, pending);
  if (!isSpreadElement(value)) return false;
  const source = framedQuietSource(value.expression);
  if (source === undefined || !isArrayLiteralExpression(source)) return false;
  pending.push(source);
  return true;
}

/** Literal data fields and method creation run no getter, spread or unknown computed-key conversion. */
function quietFields(value: ObjectLiteralExpression, pending: Expression[]): boolean {
  for (const field of value.properties) {
    const name = 'name' in field ? field.name : undefined;
    if (name === undefined || (!isIdentifier(name) && !isStringLiteral(name))) return false;
    if (isMethodDeclaration(field)) continue;
    if (!isPropertyAssignment(field)) return false;
    pending.push(field.initializer);
  }
  return true;
}

/** A fresh native Error with an absent or primitive message adds no application conversion. */
function quietError(value: Expression): boolean {
  if (!isNewExpression(value) || !framedNativeConstructor(value.expression, ERRORS)) return false;
  const args = value.arguments ?? [];
  return args.length <= 1 && args.every((argument) => framedQuietPrimitive(argument));
}
