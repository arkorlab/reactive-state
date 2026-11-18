import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isArrayLiteralExpression,
  isArrowFunction,
  isComputedPropertyName,
  isFunctionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  type NewExpression,
  type PropertyName,
} from 'typescript/ast';

import { globalPathOf } from './code-globals.ts';
import { framedArgumentPrefix, framedKeyNames } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedPrefixSameOwner, framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Closed RegExp-like data selects source and flags before native text conversion. */

const MATCH = new Set(['Symbol.match']);
const PATTERN = new Set(['RegExp']);
const NATIVES = new Set([
  'Error',
  'Function.prototype.apply',
  'Function.prototype.call',
  'RangeError',
  'Reflect.apply',
  'Reflect.construct',
  'Reflect.construct.apply',
  'Reflect.construct.call',
  'RegExp',
  'RegExp.apply',
  'RegExp.call',
  'Symbol.match',
  'SyntaxError',
  'TypeError',
]);
const FALSY = new Set(['false', 'null', 'number:0', 'text:', 'undefined']);
const HOOKS = new Set(['__proto__', 'toString', 'valueOf']);

interface PatternFields {
  readonly source: Expression | undefined;
  readonly flags: Expression | undefined;
  readonly constructor: Expression | undefined;
}

/** Every original operand is quiet before a written IsRegExp protocol can add an origin. */
export function framedRegExpPattern(
  call: CallExpression | NewExpression,
  args: readonly Expression[],
  mode: boolean | { readonly constructed: boolean; readonly newTarget?: Expression | null },
  error: (value: Expression) => boolean,
): boolean {
  const constructed = typeof mode === 'boolean' ? mode : mode.constructed;
  const newTarget = typeof mode === 'boolean' ? undefined : mode.newTarget;
  const prefix = framedArgumentPrefix(call, args, 2);
  const pattern = prefix.values[0];
  if (
    pattern === undefined ||
    prefix.unknown ||
    prefix.alternatives !== undefined ||
    !knownNewTarget(call, newTarget) ||
    !quietValues(call.arguments ?? []) ||
    !quietPrefix(call)
  )
    return false;
  const fields = patternFields(pattern, call);
  if (fields === undefined) return false;
  const given = prefix.values[1];
  const omitted = given === undefined || framedMapKey(given) === 'undefined';
  if (!constructed && mayReturnPattern(fields, given, error)) return false;
  const source = fields.source;
  if (source !== undefined && convertedError(source, call, error)) return true;
  const flags = omitted ? fields.flags : given;
  return (
    flags !== undefined &&
    (source === undefined || framedQuietPrimitive(source)) &&
    convertedError(flags, call, error)
  );
}

/** A call can return its matching native-constructor pattern before reading either text slot. */
function mayReturnPattern(
  fields: PatternFields,
  flags: Expression | undefined,
  error: (value: Expression) => boolean,
): boolean {
  if (flags !== undefined) {
    const key = framedMapKey(flags);
    if ((key !== undefined && key !== 'undefined') || error(flags)) return false;
  }
  const target = fields.constructor;
  return (
    target !== undefined &&
    (framedNativeConstructor(target, PATTERN) || !framedQuietPrimitive(target))
  );
}

/** Only own closed data fields establish a truthy native match marker and selected slots. */
function patternFields(expression: Expression, consumer: Expression): PatternFields | undefined {
  const value = framedQuietSource(expression);
  if (
    value === undefined ||
    !isObjectLiteralExpression(value) ||
    !framedPrefixSameOwner(value, consumer)
  )
    return undefined;
  const fields = new Map<string, Expression>();
  for (const property of value.properties) {
    if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      fields.set(`text:${property.name.text}`, property.name);
      continue;
    }
    if (!isPropertyAssignment(property)) return undefined;
    const key = propertyKey(property.name);
    if (key === undefined || HOOKS.has(key.slice('text:'.length))) return undefined;
    fields.set(key, property.initializer);
  }
  const marker = fields.get('symbol:match');
  const truth = framedMapKey(marker);
  return truth === undefined || FALSY.has(truth)
    ? undefined
    : {
        source: fields.get('text:source'),
        flags: fields.get('text:flags'),
        constructor: fields.get('text:constructor'),
      };
}

/** A well-known match key stays distinct from every ordinary text property. */
function propertyKey(name: PropertyName): string | undefined {
  if (isIdentifier(name)) return `text:${name.text}`;
  if (isComputedPropertyName(name)) {
    if (framedNativeConstructor(name.expression, MATCH)) return 'symbol:match';
    const keys = framedKeyNames(name.expression);
    return keys?.length === 1 ? `text:${keys[0]}` : undefined;
  }
  return 'text' in name ? `text:${name.text}` : undefined;
}

/** New slot conversions preserve the existing unchanged native Error proof. */
function convertedError(
  expression: Expression,
  call: CallExpression | NewExpression,
  error: (value: Expression) => boolean,
): boolean {
  return framedNativeErrorInput(expression, call) && error(expression);
}

/** A custom Reflect.construct new target can run an application-owned prototype getter. */
function knownNewTarget(
  call: CallExpression | NewExpression,
  newTarget?: Expression | null,
): boolean {
  if (newTarget === null) return false;
  if (newTarget !== undefined) return framedNativeConstructor(newTarget, PATTERN);
  if (!isCallExpression(call) || globalPathOf(call.expression)?.join('.') !== 'Reflect.construct')
    return true;
  const prefix = framedArgumentPrefix(call, call.arguments, Infinity);
  const target = prefix.values[2];
  return (
    !prefix.unknown &&
    prefix.alternatives === undefined &&
    (target === undefined || framedNativeConstructor(target, PATTERN))
  );
}

/** A bounded literal work list allows the well-known computed key without changing shared evaluation rules. */
function quietValues(args: readonly Expression[]): boolean {
  const pending = [...args];
  const seen = new Set<Expression>();
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const value = framedQuietSource(each);
    if (value === undefined) return false;
    if (seen.has(value)) continue;
    seen.add(value);
    if (!quietValue(value, pending)) return false;
  }
  return true;
}

/** Literal containers add their operands; function creation executes no deferred body. */
function quietValue(value: Expression, pending: Expression[]): boolean {
  if (isArrayLiteralExpression(value)) {
    pending.push(...value.elements);
    return true;
  }
  if (isObjectLiteralExpression(value)) {
    return value.properties.every((property) => {
      if (isPropertyAssignment(property) && propertyKey(property.name) !== undefined)
        pending.push(property.initializer);
      else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
        pending.push(property.name);
      else return false;
      return true;
    });
  }
  if (isSpreadElement(value)) {
    const spread = framedQuietSource(value.expression);
    if (spread === undefined || !isArrayLiteralExpression(spread)) return false;
    pending.push(spread);
    return true;
  }
  return (
    isOmittedExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    framedQuietInputs([value], NATIVES)
  );
}

/** Prior source literals may read Symbol.match, while calls, writes and opaque members remain barriers. */
function quietPrefix(consumer: Expression): boolean {
  return framedQuietOwnerPrefix(consumer, {
    primitive: (value) => framedQuietPrimitive(value) || framedNativeConstructor(value, MATCH),
    value: (value) => framedNativeConstructor(value, NATIVES),
    spread: (value) => {
      const source = framedQuietSource(value);
      return source !== undefined && isArrayLiteralExpression(source) && quietValues([source]);
    },
  });
}
