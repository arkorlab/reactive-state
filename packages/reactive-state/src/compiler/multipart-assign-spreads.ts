import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ParameterDeclaration,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedHeldValues } from './framed-held-members.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedLiteralAccessor } from './framed-member-accessors.ts';
import { framedHeldVariable, framedMemberWrites } from './framed-member-writes.ts';
import { variableMayHideBody } from './multipart-descriptors.ts';
import { isUnrepeatedSelfWrite } from './multipart-held-bindings.ts';
import { selectedValues, uniqueExpressions } from './multipart-held-paths.ts';
import { parameterMayHideBody } from './multipart-parameters.ts';
import {
  type AnalysisState,
  type BodyReading,
  combineBranchReadings,
  EMPTY_BODIES,
  mergeSpread,
  parameterValues,
  PLAIN_EMPTY_BODIES,
  reachesHolderRead,
  resolveHeldReading,
} from './multipart-readings.ts';

/** `Object.assign` target/source resolution and spread argument unfolding for request bodies. */

export interface AssignReadContext {
  readonly point: Node;
  readonly readOptions: (node: Expression, point: Node, state: AnalysisState) => BodyReading;
  readonly state: AnalysisState;
}

const BODY_KEY = 'body';

/** Evaluates `Object.assign(target, ...sources)`, clearing `overwrites` when `target` may hide `body`. */
export function objectAssignCallBodies(
  call: CallExpression,
  context: AssignReadContext,
): BodyReading {
  const merged = objectAssignArgumentsBodies(call, call.arguments, context);
  return assignTargetMayHideBody(call, context) ? { ...merged, overwrites: false } : merged;
}

/** Surviving body candidates across positional and spread sources passed to `Object.assign`. */
export function objectAssignSourcesBodies(
  call: CallExpression,
  args: readonly Expression[],
  context: AssignReadContext,
): BodyReading {
  let current = PLAIN_EMPTY_BODIES;
  for (const argument of args) {
    const reading = isSpreadElement(argument)
      ? spreadArgumentBodies(call, argument.expression, context)
      : context.readOptions(argument, context.point, context.state);
    current = mergeSpread(current, reading);
  }
  return current;
}

/** Evaluates `Object.assign(target, ...sources)` while keeping `target` direct reads distinct from copied sources. */
function objectAssignArgumentsBodies(
  call: CallExpression,
  args: readonly Expression[],
  context: AssignReadContext,
): BodyReading {
  const [first, ...rest] = normalizeLeadingAssignArguments(call, args);
  if (first === undefined) {
    return EMPTY_BODIES;
  }
  const targetReading = isSpreadElement(first)
    ? spreadArgumentBodies(call, first.expression, context)
    : context.readOptions(first, context.point, context.state);
  return mergeSpread(targetReading, objectAssignSourcesBodies(call, rest, context));
}

/** Peels leading tuple and closed array-literal spread arguments until a positional or opaque head is reached. */
function normalizeLeadingAssignArguments(
  call: CallExpression,
  args: readonly Expression[],
): readonly Expression[] {
  let remaining = args;
  for (;;) {
    const [first, ...rest] = remaining;
    if (first === undefined || !isSpreadElement(first)) {
      return remaining;
    }
    const step = unwrapLeadingAssignSpread(call, unwrapped(first.expression), rest);
    if (step === undefined) {
      return remaining;
    }
    remaining = step;
  }
}

/** Expands one leading `...spreadValue` in `Object.assign` when its first element is statically known or empty. */
function unwrapLeadingAssignSpread(
  call: CallExpression,
  spreadValue: Expression,
  rest: readonly Expression[],
): readonly Expression[] | undefined {
  const tuple = framedAppliedArguments(call, spreadValue);
  if (tuple !== undefined) {
    return [...tuple, ...rest];
  }
  if (!isArrayLiteralExpression(spreadValue)) {
    return undefined;
  }
  const [head, ...tail] = spreadValue.elements;
  if (head === undefined) {
    return rest;
  }
  return isSpreadElement(head) || isOmittedExpression(head) ? undefined : [head, ...tail, ...rest];
}

/** Whether `Object.assign`'s target argument may already carry a non-enumerable `body` property. */
function assignTargetMayHideBody(call: CallExpression, context: AssignReadContext): boolean {
  const first = call.arguments[0];
  if (first === undefined) {
    return false;
  }
  const prefix = isSpreadElement(first)
    ? framedArgumentPrefix(call, [first], 1)
    : { unknown: false, values: [first] };
  const target = prefix.unknown ? undefined : prefix.values[0];
  if (target === undefined) {
    return true;
  }
  const value = unwrapped(target);
  if (isObjectLiteralExpression(value) && !framedLiteralAccessor(value, BODY_KEY)) {
    return false;
  }
  if (context.readOptions(value, context.point, context.state).overwrites) {
    return false;
  }
  return !isIdentifier(value) || identifierMayHideBody(value, context.point);
}

/** Whether an identifier target of `Object.assign` may hold or acquire a non-enumerable `body`. */
function identifierMayHideBody(name: Identifier, point: Node): boolean {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) {
    return true;
  }
  if (isParameterDeclaration(selected.binding)) {
    return parameterMayHideBody(name, selected.binding, point);
  }
  return variableMayHideBody(name, selected.binding, (change, holder) =>
    reachesHolderRead(change, holder, point),
  );
}

/** Expands tuple, array, conditional, and mutable-array spread arguments in `Object.assign`. */
function spreadArgumentBodies(
  call: CallExpression,
  expression: Expression,
  context: AssignReadContext,
): BodyReading {
  const value = unwrapped(expression);
  if (context.state.seen.has(value)) {
    context.state.cuts.count += 1;
    return EMPTY_BODIES;
  }
  const nextContext: AssignReadContext = {
    ...context,
    state: { ...context.state, seen: new Set([...context.state.seen, value]) },
  };
  const tuple = framedAppliedArguments(call, value);
  if (tuple !== undefined) {
    return objectAssignSourcesBodies(call, tuple, nextContext);
  }
  if (isArrayLiteralExpression(value)) {
    return objectAssignSourcesBodies(call, value.elements, nextContext);
  }
  const alternatives = selectedValues(value);
  if (alternatives !== undefined) {
    return combineBranchReadings(
      alternatives.map((each) => spreadArgumentBodies(call, each, nextContext)),
    );
  }
  return isIdentifier(value) ? identifierSpreadBodies(call, value, nextContext) : EMPTY_BODIES;
}

/** Conservative fallback candidates when an `Object.assign` spread reads a mutable array binding. */
function identifierSpreadBodies(
  call: CallExpression,
  name: Identifier,
  context: AssignReadContext,
): BodyReading {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) {
    return EMPTY_BODIES;
  }
  const holderArrays = spreadHolderArrays(name, selected.binding, context.point);
  const arrayReadings = holderArrays.expressions.flatMap((candidate) => {
    const array = unwrapped(candidate);
    return isArrayLiteralExpression(array)
      ? [objectAssignSourcesBodies(call, array.elements, context)]
      : [];
  });
  const memberReadings = isVariableDeclaration(selected.binding)
    ? spreadMemberReadings(name, selected.binding, context)
    : [];
  const allReadings = [...arrayReadings, ...memberReadings];
  return {
    ambiguous: holderArrays.ambiguous || allReadings.some((each) => each.ambiguous === true),
    bodies: uniqueExpressions(allReadings.flatMap((each) => each.bodies)),
    overwrites: false,
  };
}

/** Member-write `BodyReading`s on a mutable array variable spread into `Object.assign`. */
function spreadMemberReadings(
  name: Identifier,
  binding: VariableDeclaration,
  context: AssignReadContext,
): readonly BodyReading[] {
  const holder = framedHeldVariable(binding);
  return framedMemberWrites(name.getSourceFile())
    .filter((write) => write.holder === holder && write.path.length === 1)
    .map((write) => context.readOptions(write.value, context.point, context.state));
}

/** Array expressions assigned or defaulted on a variable or parameter spread source. */
function spreadHolderArrays(
  name: Identifier,
  binding: VariableDeclaration | ParameterDeclaration,
  point: Node,
): { readonly ambiguous: boolean; readonly expressions: readonly Expression[] } {
  if (isVariableDeclaration(binding)) {
    const held = framedHeldValues(name, [], point);
    const liveHeld =
      held === undefined
        ? []
        : held.held.filter((entry) => !isUnrepeatedSelfWrite(entry.value, point, binding));
    const entries =
      held === undefined ? [] : [...(held.initial ? [held.initial] : []), ...liveHeld];
    const readings = entries.map((each) => resolveHeldReading(each, point, name));
    return {
      ambiguous: readings.some((each) => each.ambiguous || each.typedFormData),
      expressions: readings.flatMap((each) => each.expressions),
    };
  }
  const resolved = parameterValues(name, binding);
  const readings = resolved.sources.map((each) => resolveHeldReading(each, point, name));
  const sourceValues = readings.flatMap((each) => each.expressions);
  return {
    ambiguous: readings.some((each) => each.ambiguous || each.typedFormData),
    expressions:
      resolved.replaced || binding.initializer === undefined
        ? sourceValues
        : [binding.initializer, ...sourceValues],
  };
}
