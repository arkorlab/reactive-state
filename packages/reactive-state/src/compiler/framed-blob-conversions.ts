import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
  type NewExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedBlobSequence } from './framed-blob-sequence.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietData, framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Reflected Blob origins require quiet native conversions, beyond quiet argument creation. */

const NEW_TARGET_PREFIX = 3;
const BLOBS = new Set(['Blob']);
const ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);
type Original = (value: Expression) => Expression | undefined;

/** The native new target, finite parts and preceding endings conversion retain their written order. */
export function quietBlobConversions(
  call: CallExpression,
  args: readonly Expression[],
  original: Original,
  error: (value: Expression) => boolean,
): boolean {
  const target = framedArgumentPrefix(call, call.arguments, NEW_TARGET_PREFIX).values[2];
  if (target !== undefined && !framedNativeConstructor(target, BLOBS)) return false;
  const prefix = framedArgumentPrefix(call, args, 2);
  if (prefix.unknown || prefix.alternatives !== undefined) return false;
  const [parts, options] = prefix.values;
  const sequence = parts === undefined ? undefined : framedBlobSequence(parts, original);
  return (
    (parts === undefined ||
      (sequence !== undefined && quietParts(sequence.elements, original, error))) &&
    quietEndings(options, original)
  );
}

/** Every preceding part conversion is finite primitive data or an already retained native Error. */
function quietParts(
  parts: readonly Expression[],
  original: Original,
  error: (value: Expression) => boolean,
): boolean {
  const pending = [...parts];
  const seen = new Set<Expression>();
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(original(at) ?? at);
    if (seen.has(value)) continue;
    seen.add(value);
    const children = quietPartChildren(value, original, error);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** Unknown part objects and native Error operands do not inherit quiet initializer evaluation. */
function quietPartChildren(
  value: Expression,
  original: Original,
  error: (value: Expression) => boolean,
): readonly Expression[] | undefined {
  if (isOmittedExpression(value) || framedQuietPrimitive(value)) return [];
  if (isNewExpression(value)) return quietErrorConstruction(value) ? [] : undefined;
  if (isArrayLiteralExpression(value)) return value.elements;
  if (isSpreadElement(value)) {
    const array = unwrapped(original(value.expression) ?? value.expression);
    return isArrayLiteralExpression(array) ? array.elements : undefined;
  }
  return error(value) ? [] : undefined;
}

/** A fresh native Error with only literal data arguments adds no preceding application coercion. */
function quietErrorConstruction(value: NewExpression): boolean {
  return (
    framedNativeConstructor(value.expression, ERRORS) &&
    (value.arguments ?? []).every(framedQuietData)
  );
}

/** Dictionary endings is converted before type; a quiet getter can still return an opaque object. */
function quietEndings(options: Expression | undefined, original: Original): boolean {
  if (options === undefined) return true;
  const value = unwrapped(original(options) ?? options);
  if (framedQuietPrimitive(value)) return true;
  if (!isObjectLiteralExpression(value)) return false;
  const sources = framedObjectSources(value, ['endings']);
  return (
    sources?.every((source) => source.keys.length === 0 && framedQuietPrimitive(source.value)) ===
    true
  );
}
