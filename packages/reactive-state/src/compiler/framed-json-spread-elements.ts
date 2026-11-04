import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { type FrameBinding, frameBindingOf } from './framed-bindings.ts';
import { jsonConstantDeclaration } from './framed-json-keys.ts';
import {
  jsonSpreadEvaluation,
  jsonSpreadFields,
  jsonSpreadName,
  type JsonSpreadTrace,
} from './framed-json-spread-evaluation.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';

/** Array spread consumes a closed native iterator before JSON invokes the yielded values' hooks. */

const MUTATORS = new Set(['Object.assign', 'Object.defineProperties', 'Object.defineProperty']);
const ASSIGN = new Set(['Object.assign']);
const DEFINE = new Set(['Object.defineProperty']);
const STRINGIFY = new Set(['JSON.stringify']);

interface SpreadSource {
  readonly value: Expression;
  readonly seen: ReadonlySet<Expression>;
}

/** Unproved iterator identities and evaluation effects retain the existing serialized-source path. */
export function framedJsonSpreadElements(
  expression: Expression,
  consumer: Node,
  error: (value: Expression) => boolean,
): readonly Expression[] | undefined {
  if (!isCallExpression(consumer)) return undefined;
  const selected = framedNativeArguments(consumer, STRINGIFY);
  if (selected === undefined || selected.constructed || selected.args === undefined)
    return undefined;
  const trace: JsonSpreadTrace = {
    aliases: new Set<FrameBinding>(),
    reads: new Set<Identifier>(),
    operations: new Set<CallExpression>(),
    spreads: new Set<Expression>(),
    error,
  };
  const values = spreadValues(expression, consumer, trace);
  if (
    values === undefined ||
    !jsonSpreadEvaluation(consumer, selected.args, values, trace) ||
    argumentArrayExposed(consumer, trace.aliases, (name) => trace.reads.has(name))
  )
    return undefined;
  return values;
}

/** Only spread edges flatten; an ordinary nested array remains one independently serialized value. */
function spreadValues(
  expression: Expression,
  consumer: CallExpression,
  trace: JsonSpreadTrace,
): readonly Expression[] | undefined {
  const pending: SpreadSource[] = [{ value: expression, seen: new Set() }];
  const values: Expression[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at.value);
    if (at.seen.has(value)) return undefined;
    const seen = new Set([...at.seen, value]);
    if (!appendSpreadSource(value, seen, { consumer, trace, pending, values })) return undefined;
  }
  trace.spreads.add(expression);
  return values;
}

interface SpreadContext {
  readonly consumer: CallExpression;
  readonly trace: JsonSpreadTrace;
  readonly pending: SpreadSource[];
  readonly values: Expression[];
}

/** Each finite source step either retains target identity or appends the literal array's elements. */
function appendSpreadSource(
  value: Expression,
  seen: ReadonlySet<Expression>,
  context: SpreadContext,
): boolean {
  const { consumer, trace, pending, values } = context;
  if (isIdentifier(value)) {
    const initial = spreadAlias(value, consumer, trace);
    if (initial === undefined) return false;
    pending.push({ value: initial, seen });
    return true;
  }
  if (isCallExpression(value)) {
    const target = spreadMutation(value);
    if (target === undefined) return false;
    trace.operations.add(value);
    pending.push({ value: target, seen });
    return true;
  }
  if (!isArrayLiteralExpression(value)) return false;
  trace.spreads.add(value);
  for (const entry of value.elements) {
    if (isOmittedExpression(entry)) continue;
    if (isSpreadElement(entry)) {
      trace.spreads.add(entry.expression);
      pending.push({ value: entry.expression, seen });
    } else values.push(entry);
  }
  return true;
}

/** Stored iterator sources retain only completed same-owner whole constant aliases. */
function spreadAlias(
  value: Identifier,
  consumer: CallExpression,
  trace: JsonSpreadTrace,
): Expression | undefined {
  const selected = frameBindingOf(value);
  const declared = jsonConstantDeclaration(value);
  if (
    selected === undefined ||
    selected.keys.length > 0 ||
    declared?.initializer === undefined ||
    declared.end > value.pos ||
    !framedPrefixSameOwner(declared, consumer) ||
    !framedPrefixSameOwner(value, consumer)
  )
    return undefined;
  trace.aliases.add(declared);
  trace.reads.add(value);
  return declared.initializer;
}

/** Native target-returning mutations may add hooks but cannot replace slots, length or iteration. */
function spreadMutation(call: CallExpression): Expression | undefined {
  const selected = framedNativeArguments(call, MUTATORS);
  if (selected === undefined || selected.constructed || selected.args === undefined)
    return undefined;
  const prefix = framedArgumentPrefix(call, selected.args, Infinity);
  const [target, key, descriptor] = prefix.values;
  if (target === undefined || prefix.unknown || prefix.alternatives !== undefined) return undefined;
  if (framedNativeArguments(call, ASSIGN) !== undefined)
    return prefix.values.slice(1).every((source) => jsonSpreadFields(source)) ? target : undefined;
  if (key === undefined) return undefined;
  if (framedNativeArguments(call, DEFINE) !== undefined)
    return descriptor !== undefined && definitionKey(key) && literalDescriptor(descriptor)
      ? target
      : undefined;
  return descriptorMap(key) ? target : undefined;
}

/** A literal definition can add an unrelated own key without changing the iterator's indexed reads. */
function definitionKey(expression: Expression): boolean {
  const value = unwrapped(expression);
  return isStringLiteral(value) && jsonSpreadName(value);
}

/** Descriptor fields are data or deferred function values; descriptor getters stay opaque. */
function literalDescriptor(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  return value !== undefined && isObjectLiteralExpression(value) && jsonSpreadFields(value, false);
}

/** Plural definitions keep the same exact-key and quiet descriptor boundary as singular ones. */
function descriptorMap(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  return (
    value !== undefined &&
    isObjectLiteralExpression(value) &&
    value.properties.every((property) => {
      return (
        isPropertyAssignment(property) &&
        jsonSpreadName(property.name) &&
        literalDescriptor(property.initializer)
      );
    })
  );
}
