import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  type Node,
  type PropertyName,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { jsonConstantDeclaration } from './framed-json-keys.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner, framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Added spread origins cross neither prior application work nor earlier serialization effects. */

const ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);
const NATIVES = new Set([
  ...ERRORS,
  'JSON.stringify',
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Reflect.apply',
]);
const SLOTS = { replacer: 1, gap: 2 } as const;
const FORBIDDEN = new Set(['__proto__', 'length']);
const ASSIGN = new Set(['Object.assign']);

export interface JsonSpreadTrace {
  readonly aliases: Set<FrameBinding>;
  readonly reads: Set<Identifier>;
  readonly operations: Set<CallExpression>;
  readonly spreads: Set<Expression>;
  readonly error: (value: Expression) => boolean;
}

/** Complete native argument evaluation and serialization of selected elements remain source-known. */
export function jsonSpreadEvaluation(
  consumer: CallExpression,
  args: readonly Expression[],
  values: readonly Expression[],
  trace: JsonSpreadTrace,
): boolean {
  const originalValue = args[0];
  const replacer = args[SLOTS.replacer];
  const gap = args[SLOTS.gap];
  if (
    originalValue === undefined ||
    replacer === undefined ||
    !primitiveList(replacer) ||
    (gap !== undefined && !framedQuietPrimitive(gap))
  )
    return false;
  const context: CreationContext = {
    consumer,
    trace,
    inputs: new Set(),
    serialized: false,
    values,
  };
  if (!quietValues(consumer.arguments, context)) return false;
  if (!quietValues([originalValue], { ...context, serialized: true })) return false;
  if (
    [...context.inputs].some((source) => {
      return !framedNativeErrorInput(source, consumer, {
        consumer,
        unconverted: new Set([...context.inputs, ...trace.reads]),
        consumed: new Set(),
      });
    })
  )
    return false;
  return framedQuietOwnerPrefix(consumer, {
    primitive: framedQuietPrimitive,
    value: (value) => framedNativeConstructor(value, NATIVES),
    call: (call) => trace.operations.has(call),
    construct: (node) => {
      return (
        framedNativeConstructor(node.expression, ERRORS) &&
        (node.arguments ?? []).every((argument) => framedQuietPrimitive(argument))
      );
    },
    spread: (value) => trace.spreads.has(value),
  });
}

/** A native property list contains only primitives, without an earlier application key conversion. */
function primitiveList(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  return (
    value !== undefined &&
    isArrayLiteralExpression(value) &&
    value.elements.every((entry) => isOmittedExpression(entry) || framedQuietPrimitive(entry))
  );
}

/** Added fields may not affect indexed iterator reads or change an array's prototype. */
export function jsonSpreadName(name: PropertyName | undefined): boolean {
  return (
    name !== undefined &&
    (isIdentifier(name) ||
      isStringLiteral(name) ||
      isNumericLiteral(name) ||
      isNoSubstitutionTemplateLiteral(name)) &&
    !FORBIDDEN.has(name.text) &&
    !/^\d+$/u.test(name.text)
  );
}

/** Assign sources and descriptor records create literal data and deferred methods, without getters. */
export function jsonSpreadFields(expression: Expression, indexed = true): boolean {
  const value = framedQuietSource(expression);
  return (
    value !== undefined &&
    isObjectLiteralExpression(value) &&
    value.properties.every((property) => {
      if (
        !isPropertyAssignment(property) &&
        !isMethodDeclaration(property) &&
        (!isShorthandPropertyAssignment(property) || !isIdentifier(property.name))
      )
        return false;
      return indexed ? jsonSpreadName(property.name) : literalName(property.name);
    })
  );
}

interface CreationContext {
  readonly consumer: CallExpression;
  readonly trace: JsonSpreadTrace;
  readonly inputs: Set<Identifier>;
  readonly serialized: boolean;
  readonly values: readonly Expression[];
}

/** Quiet syntax retains original nodes and never executes application functions or constant evaluators. */
function quietValues(expressions: readonly Expression[], context: CreationContext): boolean {
  const pending = [...expressions];
  const seen = new Set<Expression>();
  for (let expression = pending.pop(); expression !== undefined; expression = pending.pop()) {
    const value = unwrapped(expression);
    if (seen.has(value)) continue;
    seen.add(value);
    if (!quietValue(value, pending, context)) return false;
  }
  return true;
}

/** Supported native operations have separately qualified targets and all original creation arguments. */
function quietValue(value: Expression, pending: Expression[], context: CreationContext): boolean {
  if (framedQuietPrimitive(value) || isOmittedExpression(value)) return true;
  if (framedNativeConstructor(value, NATIVES)) return true;
  if (isIdentifier(value)) return quietBinding(value, pending, context);
  if (isCallExpression(value) && quietCall(value, context.trace)) {
    pending.push(...value.arguments);
    return true;
  }
  if (isNewExpression(value))
    return (
      framedNativeConstructor(value.expression, ERRORS) &&
      (value.arguments ?? []).every((argument) => framedQuietPrimitive(argument))
    );
  if (isSpreadElement(value)) {
    if (!context.trace.spreads.has(value.expression)) return false;
    if (context.serialized) pending.push(...context.values);
    else pending.push(value.expression);
    return true;
  }
  if (isArrayLiteralExpression(value)) {
    pending.push(...value.elements);
    return true;
  }
  if (isObjectLiteralExpression(value)) return quietFields(value.properties, pending, context);
  return quietCallable(value, pending, context.serialized, context.trace.reads);
}

/** A nested serialized element may have a native copy's own hook without flattening that element. */
function quietCall(call: CallExpression, trace: JsonSpreadTrace): boolean {
  if (trace.operations.has(call)) return true;
  const selected = framedNativeArguments(call, ASSIGN);
  if (selected === undefined || selected.constructed || selected.args === undefined) return false;
  const prefix = framedArgumentPrefix(call, selected.args, Infinity);
  const [first] = prefix.values;
  if (first === undefined || prefix.unknown || prefix.alternatives !== undefined) return false;
  const target = unwrapped(first);
  if (!isArrayLiteralExpression(target) && !isObjectLiteralExpression(target)) return false;
  if (prefix.values.slice(1).some((source) => !jsonSpreadFields(source, false))) return false;
  trace.operations.add(call);
  return true;
}

/** Selected Error inputs stay unchanged at the actual JSON call, including aliases and captured sources. */
function quietBinding(value: Identifier, pending: Expression[], context: CreationContext): boolean {
  const selected = frameBindingOf(value);
  if (
    selected === undefined ||
    selected.keys.length > 0 ||
    !framedOriginCoowned(value, context.consumer)
  )
    return false;
  const declared = jsonConstantDeclaration(value);
  if (declared?.initializer !== undefined) {
    if (declared.end > value.pos || !framedPrefixSameOwner(declared, context.consumer))
      return false;
    context.trace.aliases.add(declared);
    context.trace.reads.add(value);
    pending.push(declared.initializer);
    return true;
  }
  if (context.serialized && !context.trace.error(value)) return false;
  context.inputs.add(value);
  return true;
}

/** Literal fields have no invoked getter or computed key before a later Error element is serialized. */
function quietFields(
  fields: readonly Node[],
  pending: Expression[],
  context: CreationContext,
): boolean {
  for (const field of fields) {
    if (isPropertyAssignment(field) && literalName(field.name)) pending.push(field.initializer);
    else if (isShorthandPropertyAssignment(field) && isIdentifier(field.name))
      pending.push(field.name);
    else if (
      !isMethodDeclaration(field) ||
      !literalName(field.name) ||
      !quietCallable(field, pending, context.serialized, context.trace.reads)
    )
      return false;
  }
  return true;
}

/** A deferred function's creation is quiet; a potentially invoked method retains a closed direct return. */
function quietCallable(
  value: Node,
  pending: Expression[],
  serialized: boolean,
  inert: Set<Identifier>,
): boolean {
  if (!isArrowFunction(value) && !isFunctionExpression(value) && !isMethodDeclaration(value))
    return false;
  if (!serialized) {
    const deferred: Node[] = [value];
    for (let node = deferred.pop(); node !== undefined; node = deferred.pop()) {
      if (isIdentifier(node)) inert.add(node);
      node.forEachChild((child) => {
        deferred.push(child);
      });
    }
    return true;
  }
  if (
    value.parameters.some((parameter) => {
      return (
        !isIdentifier(parameter.name) ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined
      );
    })
  )
    return false;
  if (answersLater(value) || value.body === undefined) return false;
  if (!isBlock(value.body)) {
    pending.push(value.body);
    return true;
  }
  const [first, ...remaining] = value.body.statements;
  if (first === undefined || remaining.length > 0 || !isReturnStatement(first)) return false;
  if (first.expression !== undefined) pending.push(first.expression);
  return true;
}

/** Literal field names do not execute source-written key conversions. */
function literalName(name: PropertyName | undefined): boolean {
  return (
    name !== undefined &&
    (isIdentifier(name) ||
      isStringLiteral(name) ||
      isNumericLiteral(name) ||
      isNoSubstitutionTemplateLiteral(name)) &&
    name.text !== '__proto__'
  );
}
