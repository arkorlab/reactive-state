import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isFunctionExpression,
  isNewExpression,
  isSpreadElement,
  type ParameterDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietInputs, framedQuietSource } from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** New native callback argument-spread inputs keep each original evaluated operand quiet. */

const COLLECTIONS = new Set(['Map', 'Set']);
const NATIVES = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException', 'Map', 'Set']);

/** Full original arguments, both execution prefixes and source ownership precede the callback read. */
export function framedCallbackSpreadInput(
  call: CallExpression,
  receiver: Expression,
  read: Expression,
  parameter?: ParameterDeclaration,
): boolean {
  const given = framedArgumentPrefix(call, call.arguments, Infinity);
  return (
    !given.unknown &&
    (given.alternatives?.length ?? 0) === 0 &&
    framedOriginPrefix(call) &&
    framedOriginPrefix(read, {
      parameter: (each) => each === parameter && each.dotDotDotToken !== undefined,
    }) &&
    framedOriginCoowned(receiver, call) &&
    quietCreation([receiver, ...call.arguments])
  );
}

/** Deferred callable creation is quiet; literal spreads retain all of their evaluated entries. */
function quietCreation(values: readonly Expression[]): boolean {
  const pending = [...values];
  const seen = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    if (seen.has(value)) continue;
    seen.add(value);
    if (isArrowFunction(value) || isFunctionExpression(value)) continue;
    if (framedQuietInputs([value], NATIVES)) continue;
    const children = quietChildren(value);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** Only literal arrays or native collections of a literal entry list add completed evaluation. */
function quietChildren(value: Expression): readonly Expression[] | undefined {
  if (isArrayLiteralExpression(value)) return value.elements;
  if (isNewExpression(value) && framedNativeConstructor(value.expression, COLLECTIONS)) {
    const args = value.arguments ?? [];
    const first = args[0];
    const entries = first === undefined ? undefined : framedQuietSource(first);
    return first === undefined || (entries !== undefined && isArrayLiteralExpression(entries))
      ? args
      : undefined;
  }
  const source = isSpreadElement(value) ? framedQuietSource(value.expression) : undefined;
  return source !== undefined && isArrayLiteralExpression(source) ? [source] : undefined;
}
