import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  type NewExpression,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { quietErrorConstruction } from './framed-copy-guards.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import {
  framedProxyHandlerEntryQuiet,
  framedProxyHandlerKey,
  framedProxySource,
} from './framed-proxy-key-shapes.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Proxy shape observations evaluate all operands without invoking unrelated handler traps. */

const NATIVES = new Set([
  'Error',
  'EvalError',
  'Object',
  'Object.getOwnPropertyNames',
  'Object.hasOwn',
  'Object.prototype',
  'Object.prototype.hasOwnProperty',
  'Proxy',
  'RangeError',
  'ReferenceError',
  'Reflect',
  'Reflect.apply',
  'Reflect.ownKeys',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
const CALLERS = new Set(['apply', 'call']);

/** Native key conversion, every original wrapper operand and prior owner work stay quiet. */
export function framedProxyShapeInputs(
  call: CallExpression,
  creations: ReadonlySet<NewExpression>,
  key: Expression | undefined,
): boolean {
  if (key !== undefined && !framedQuietPrimitive(key)) return false;
  if (!quietValues(call.arguments, call, creations)) return false;
  for (const creation of creations)
    if (!quietValues(creation.arguments ?? [], call, creations)) return false;
  return framedQuietOwnerPrefix(call, {
    primitive: (value) => framedQuietPrimitive(value),
    value: nativeField,
    construct: (node) => creations.has(node) || quietErrorConstruction(node),
    spread: (value) => quietSpread(value, call, creations),
  });
}

/** Full literal tuple construction keeps ignored tails and original spread evaluation. */
function quietSpread(
  expression: Expression,
  call: CallExpression,
  creations: ReadonlySet<NewExpression>,
): boolean {
  const value = framedQuietSource(expression, false);
  return (
    value !== undefined &&
    isArrayLiteralExpression(value) &&
    quietValues(value.elements, call, creations)
  );
}

/** Deferred function creation and simple binding reads do not execute supplied application work. */
function quietValues(
  given: readonly Expression[],
  call: CallExpression,
  creations: ReadonlySet<NewExpression>,
): boolean {
  const pending = [...given];
  const seen = new Set<Expression>();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const value = unwrapped(node);
    if (seen.has(value)) continue;
    seen.add(value);
    if (quietAtom(value, creations)) continue;
    if (!quietComposite(value, pending, call, creations)) return false;
  }
  return true;
}

/** Source aliases and literal containers evaluate only their independently quiet operands. */
function quietComposite(
  value: Expression,
  pending: Expression[],
  call: CallExpression,
  creations: ReadonlySet<NewExpression>,
): boolean {
  if (isIdentifier(value)) {
    const source = framedProxySource(value, call);
    if (source !== undefined) pending.push(source.value);
    return true;
  }
  if (isArrayLiteralExpression(value)) {
    pending.push(...value.elements);
    return true;
  }
  if (isSpreadElement(value)) return quietSpread(value.expression, call, creations);
  return isObjectLiteralExpression(value) && quietRecord(value, pending);
}

/** Only the separately validated native Proxy creations acquire a quiet constructor proof. */
function quietAtom(value: Expression, creations: ReadonlySet<NewExpression>): boolean {
  return (
    framedQuietPrimitive(value) ||
    isOmittedExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    (isNewExpression(value) && creations.has(value)) ||
    quietErrorConstruction(value) ||
    nativeField(value)
  );
}

/** Literal record creation evaluates keys and data values, while accessor bodies stay deferred. */
function quietRecord(value: ObjectLiteralExpression, pending: Expression[]): boolean {
  for (const property of value.properties) {
    const name = 'name' in property ? property.name : undefined;
    if (
      name === undefined ||
      framedProxyHandlerKey(name) === '__proto__' ||
      framedProxyHandlerKey(name) === undefined ||
      !framedProxyHandlerEntryQuiet(property)
    )
      return false;
    if (isPropertyAssignment(property)) pending.push(property.initializer);
    else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
      pending.push(property.name);
  }
  return true;
}

/** Native shape callables and their finite call/apply fields retain lexical constructor aliases. */
function nativeField(expression: Expression): boolean {
  let value = unwrapped(expression);
  while (!framedNativeConstructor(value, NATIVES)) {
    if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
    const name = frameMemberName(value);
    if (
      name === undefined ||
      !CALLERS.has(name) ||
      (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
    )
      return false;
    value = unwrapped(value.expression);
  }
  return true;
}
