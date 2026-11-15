import {
  type CallExpression,
  type Expression,
  type Identifier,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { type FrameBinding, frameBindingOf } from './framed-bindings.ts';
import {
  jsonBoxedArguments,
  jsonBoxedCreation,
  jsonBoxedFields,
  jsonBoxedPrefix,
} from './framed-json-boxed-evaluation.ts';
import { jsonConstantDeclaration } from './framed-json-keys.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Native JSON unboxes closed primitive wrappers after toJSON and before selecting attached fields. */

const BOXES = new Set(['Boolean', 'Number', 'String']);
const MUTATORS = new Set(['Object.assign', 'Object.defineProperties', 'Object.defineProperty']);
const ASSIGN = new Set(['Object.assign']);
const DEFINE = new Set(['Object.defineProperty']);
const STRINGIFY = new Set(['JSON.stringify']);
const CONVERSIONS = new Set(['__proto__', 'toString', 'valueOf']);

interface BoxedTrace {
  readonly aliases: Set<FrameBinding>;
  readonly reads: Set<Identifier>;
  readonly operations: Set<CallExpression>;
}

/** Unknown wrapper identities or conversion effects leave the existing listed-field proof intact. */
export function framedJsonBoxedValue(expression: Expression, consumer: Node): boolean {
  if (!isCallExpression(consumer)) return false;
  const selected = framedNativeArguments(consumer, STRINGIFY);
  if (selected === undefined || selected.constructed || selected.args === undefined) return false;
  const trace: BoxedTrace = { aliases: new Set(), reads: new Set(), operations: new Set() };
  if (!nativeBoxedOrigin(expression, consumer, trace)) return false;
  return (
    !argumentArrayExposed(consumer, trace.aliases, (name) => trace.reads.has(name)) &&
    [...trace.operations].every((call) =>
      jsonBoxedCreation(call.arguments, trace.operations, consumer, true),
    ) &&
    jsonBoxedArguments(consumer, selected.args, trace.operations) &&
    jsonBoxedPrefix(consumer, trace.operations)
  );
}

/** Native object-mutator expressions preserve their first target's primitive-wrapper identity. */
function nativeBoxedOrigin(
  expression: Expression,
  consumer: CallExpression,
  trace: BoxedTrace,
): boolean {
  let value = unwrapped(expression);
  const seen = new Set<Expression>();
  for (;;) {
    if (seen.has(value)) return false;
    seen.add(value);
    if (isIdentifier(value)) {
      const initial = boxedAlias(value, consumer, trace);
      if (initial === undefined) return false;
      value = unwrapped(initial);
      continue;
    }
    if (!isCallExpression(value)) break;
    const target = boxedMutation(value, consumer);
    if (target === undefined) return false;
    trace.operations.add(value);
    value = unwrapped(target);
  }
  return (
    isNewExpression(value) &&
    framedNativeConstructor(value.expression, BOXES) &&
    (value.arguments ?? []).every((argument) => framedQuietPrimitive(argument))
  );
}

/** A stored wrapper has no mutation or capture proof beyond its whole local constant chain. */
function boxedAlias(
  value: Identifier,
  consumer: CallExpression,
  trace: BoxedTrace,
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

/** Closed native copies and data definitions do not replace the target's primitive conversion. */
function boxedMutation(call: CallExpression, consumer: CallExpression): Expression | undefined {
  const selected = framedNativeArguments(call, MUTATORS);
  if (selected === undefined || selected.constructed || selected.args === undefined)
    return undefined;
  const prefix = framedArgumentPrefix(call, selected.args, Infinity);
  const [target, key, descriptor] = prefix.values;
  if (target === undefined || prefix.unknown || prefix.alternatives !== undefined) return undefined;
  if (framedNativeArguments(call, ASSIGN) !== undefined)
    return prefix.values.slice(1).every((source) => jsonBoxedFields(source, consumer))
      ? target
      : undefined;
  if (key === undefined) return undefined;
  if (framedNativeArguments(call, DEFINE) !== undefined)
    return descriptor !== undefined &&
      quietDefinitionKey(key) &&
      jsonBoxedFields(descriptor, consumer)
      ? target
      : undefined;
  return quietDescriptorMap(key, consumer) ? target : undefined;
}

/** A singular own definition cannot install a primitive-conversion hook or change the prototype. */
function quietDefinitionKey(expression: Expression): boolean {
  const value = unwrapped(expression);
  return isStringLiteral(value) && !CONVERSIONS.has(value.text);
}

/** Plural definitions retain direct literal descriptors and exclude custom primitive conversion keys. */
function quietDescriptorMap(expression: Expression, consumer: CallExpression): boolean {
  const value = framedQuietSource(expression);
  return (
    value !== undefined &&
    isObjectLiteralExpression(value) &&
    value.properties.every((field) => {
      return (
        isPropertyAssignment(field) &&
        (isIdentifier(field.name) || isStringLiteral(field.name)) &&
        !CONVERSIONS.has(field.name.text) &&
        jsonBoxedFields(field.initializer, consumer)
      );
    })
  );
}
