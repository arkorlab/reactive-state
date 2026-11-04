import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadAssignment,
  type NewExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import {
  framedProxyFieldName,
  framedProxyTrapResult,
  framedProxyInputQuiet,
} from './framed-proxy-descriptor-inputs.ts';

/** Native descriptor observation keeps the actual source call and selected map-key execution. */

const SINGULAR = new Set(['Object.getOwnPropertyDescriptor', 'Reflect.getOwnPropertyDescriptor']);

/** Exact native calls and unexposed aliases retain their original selected Proxy creation. */
export function framedProxyDescriptorCall(
  observation: Expression,
  creation?: NewExpression,
  names?: readonly string[],
): CallExpression | undefined {
  const value = observationCall(observation);
  if (value === undefined) return undefined;
  const path = globalPathOf(unwrapped(value.expression))?.join('.');
  if (path === undefined || (path !== 'Object.getOwnPropertyDescriptors' && !SINGULAR.has(path)))
    return undefined;
  if (creation === undefined) return value;
  const target = value.arguments[0];
  const selected = target === undefined ? undefined : framedQuietSource(target);
  if (selected === undefined || selected !== creation || !isNewExpression(selected))
    return undefined;
  if (SINGULAR.has(path)) {
    const key = value.arguments[1];
    return key !== undefined && framedQuietPrimitive(key) ? value : undefined;
  }
  return selectedPlural(creation, names) ? value : undefined;
}

/** Unexposed descriptor aliases and selected map members retain the original native call. */
function observationCall(observation: Expression): CallExpression | undefined {
  let value = framedQuietSource(observation);
  if (value === undefined) return undefined;
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
      return undefined;
    value = framedQuietSource(value.expression);
  }
  if (value === undefined || !isCallExpression(value)) return undefined;
  return value;
}

/** A descriptor-map key executes only when a quiet written ownKeys result includes that key. */
function selectedPlural(creation: NewExpression, names: readonly string[] | undefined): boolean {
  if (names === undefined || names.length === 0) return false;
  const handler = creation.arguments?.[1];
  const methods = handler === undefined ? undefined : framedQuietSource(handler);
  if (methods === undefined || !isObjectLiteralExpression(methods)) return false;
  let result: Expression | undefined;
  for (const property of methods.properties) {
    if (isSpreadAssignment(property)) return false;
    if (framedProxyFieldName(property.name) === 'ownKeys')
      result = framedProxyTrapResult(property, 1);
  }
  const array = result === undefined ? undefined : framedQuietSource(result);
  if (array === undefined || !isArrayLiteralExpression(array)) return false;
  const keys: string[] = [];
  for (const element of array.elements) {
    const value = framedQuietSource(element);
    if (value === undefined || (!isStringLiteral(value) && !isNoSubstitutionTemplateLiteral(value)))
      return false;
    keys.push(value.text);
  }
  return new Set(keys).size === keys.length && names.every((name) => keys.includes(name));
}

/** The final value read evaluates every own key or reflected receiver operand before exposing it. */
export function framedProxyObservationQuiet(
  consumer: Expression,
  observation: Expression,
  binding: boolean,
): boolean {
  if (binding) return true;
  let value = unwrapped(consumer);
  if (isCallExpression(value)) return quietReflectedValue(value);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
      return false;
    if (unwrapped(value.expression) === unwrapped(observation)) return true;
    value = unwrapped(value.expression);
  }
  return false;
}

/** Reflect.get evaluates its third receiver argument even when the resulting descriptor holds data. */
function quietReflectedValue(call: CallExpression): boolean {
  const key = call.arguments[1];
  return (
    globalPathOf(unwrapped(call.expression))?.join('.') === 'Reflect.get' &&
    key !== undefined &&
    framedQuietPrimitive(key) &&
    call.arguments.slice(1).every((argument) => framedProxyInputQuiet(argument))
  );
}
