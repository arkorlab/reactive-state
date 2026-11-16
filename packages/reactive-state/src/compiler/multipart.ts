import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { ownerKeyFirst } from './class-key-order.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedLiteralAccessor } from './framed-member-accessors.ts';
import {
  framedHeldVariable,
  framedMemberDeletes,
  framedMemberWrites,
  type MemberDelete,
} from './framed-member-writes.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import {
  applyDescriptorWrite,
  holderDescriptorBodyWrites,
  mapDescriptorBodyWrite,
  optionPropertyKey,
  optionPropertyValue,
  singleDescriptorBodyWrite,
  variableMayHideBody,
} from './multipart-descriptors.ts';
import { parameterBodies, parameterMayHideBody } from './multipart-parameters.ts';
import {
  type AnalysisState,
  type BodyReading,
  definitelyBefore,
  EMPTY_BODIES,
  isFormData,
  mergeSpread,
  parameterValues,
  resolveHeldExpressions,
  selectedValues,
  startAnalysis,
  uniqueExpressions,
} from './multipart-readings.ts';

/** What constructing a Request or Response draws at random for a FormData multipart boundary. */

const BODY_KEY = 'body';
const DEFINED = { slots: 3 } as const;

/** What constructing a Request or Response draws at random for a FormData multipart boundary. */
export function multipartMaking(node: NewExpression, path: string | undefined): string | undefined {
  const state = startAnalysis();
  const first = node.arguments?.[0];
  const bodies =
    path === 'Response' && first !== undefined ? [first] : requestBodies(node, path, state);
  return bodies.some((body) => isFormData(body, { ...state, seen: new Set() }))
    ? 'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random'
    : undefined;
}

/** What a Request's options show of its body, after aliases, mutations and object spreads. */
function requestBodies(
  node: NewExpression,
  path: string | undefined,
  state: AnalysisState,
): readonly Expression[] {
  const options = path === 'Request' ? node.arguments?.[1] : undefined;
  return options === undefined ? [] : bodiesOf(options, node, state).bodies;
}

/** The surviving body property of options the code writes, memoized across cycle-free subwalks. */
function bodiesOf(node: Expression, point: Node, state: AnalysisState): BodyReading {
  const value = unwrapped(node);
  const cachePoint = isObjectLiteralExpression(value) ? value : point;
  const cached = state.readings.get(value)?.get(cachePoint);
  if (cached !== undefined) {
    return cached;
  }
  if (state.seen.has(value)) {
    state.cuts.count += 1;
    return EMPTY_BODIES;
  }
  const cutsBefore = state.cuts.count;
  const following: AnalysisState = { ...state, seen: new Set([...state.seen, value]) };
  const reading = computeBodiesOf(value, cachePoint, following);
  if (state.cuts.count === cutsBefore) {
    rememberReading(state.readings, value, cachePoint, reading);
  }
  return reading;
}

/** Stores a cycle-free `BodyReading` indexed by unwrapped expression and evaluation point. */
function rememberReading(
  readings: Map<Expression, Map<Node, BodyReading>>,
  value: Expression,
  point: Node,
  reading: BodyReading,
): void {
  let byPoint = readings.get(value);
  if (byPoint === undefined) {
    byPoint = new Map();
    readings.set(value, byPoint);
  }
  byPoint.set(point, reading);
}

/** Computes a single `BodyReading` without consulting the memoization table. */
function computeBodiesOf(value: Expression, point: Node, following: AnalysisState): BodyReading {
  if (isIdentifier(value)) {
    return identifierBodies(value, point, following);
  }
  const alternatives = selectedValues(value);
  if (alternatives !== undefined) {
    const readings = alternatives.map((each) => bodiesOf(each, point, following));
    return {
      bodies: uniqueExpressions(readings.flatMap((each) => each.bodies)),
      overwrites: readings.length > 0 && readings.every((each) => each.overwrites),
    };
  }
  if (isCallExpression(value)) {
    return callExpressionBodies(value, point, following);
  }
  return isObjectLiteralExpression(value) ? literalBodies(value, following) : EMPTY_BODIES;
}

/** Evaluates `Object.assign`, `Object.defineProperty`, `Object.defineProperties`, and `Object.create` options. */
function callExpressionBodies(
  call: CallExpression,
  point: Node,
  following: AnalysisState,
): BodyReading {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path === 'Object.assign') {
    const merged = objectAssignSourcesBodies(call, call.arguments, point, following);
    return assignTargetMayHideBody(call, point, following)
      ? { bodies: merged.bodies, overwrites: false }
      : merged;
  }
  if (path === 'Object.defineProperty') {
    const [target, key, descriptor] = framedArgumentPrefix(
      call,
      call.arguments,
      DEFINED.slots,
    ).values;
    return target === undefined
      ? EMPTY_BODIES
      : applyDescriptorWrite(
          bodiesOf(target, point, following),
          singleDescriptorBodyWrite(key, descriptor, false),
        );
  }
  if (path === 'Object.defineProperties') {
    const [target, descriptors] = framedArgumentPrefix(call, call.arguments).values;
    return target === undefined
      ? EMPTY_BODIES
      : applyDescriptorWrite(
          bodiesOf(target, point, following),
          mapDescriptorBodyWrite(descriptors),
        );
  }
  return path === 'Object.create' ? objectCreateBodies(call, point, following) : EMPTY_BODIES;
}

/** Evaluates `Object.create(proto, descriptors?)`, keeping prototype `body` reads non-enumerable. */
function objectCreateBodies(
  call: CallExpression,
  point: Node,
  following: AnalysisState,
): BodyReading {
  const [proto, descriptors] = framedArgumentPrefix(call, call.arguments).values;
  const protoBodies = proto === undefined ? [] : bodiesOf(proto, point, following).bodies;
  const firstOnly =
    call.arguments.length < 2 &&
    (call.arguments[0] === undefined || !isSpreadElement(call.arguments[0]));
  if (firstOnly) {
    return { bodies: protoBodies, overwrites: false };
  }
  const write = mapDescriptorBodyWrite(descriptors);
  if (write === undefined) {
    return { bodies: protoBodies, overwrites: false };
  }
  return {
    bodies: uniqueExpressions(write.exactBody ? write.values : [...protoBodies, ...write.values]),
    overwrites: write.enumerableBody,
  };
}

/** Whether `Object.assign`'s target argument may already carry a non-enumerable `body` property. */
function assignTargetMayHideBody(call: CallExpression, point: Node, state: AnalysisState): boolean {
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
  if (bodiesOf(value, point, state).overwrites) {
    return false;
  }
  return !isIdentifier(value) || identifierMayHideBody(value, point);
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

/** Surviving body candidates across the properties and spreads of a written options literal. */
function literalBodies(value: ObjectLiteralExpression, following: AnalysisState): BodyReading {
  let current = EMPTY_BODIES;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      current = mergeSpread(current, bodiesOf(property.expression, property, following));
      continue;
    }
    current = propertyBodies(property, current, following);
  }
  return current;
}

/** Surviving body candidates across positional and spread sources passed to `Object.assign`. */
function objectAssignSourcesBodies(
  call: CallExpression,
  args: readonly Expression[],
  point: Node,
  following: AnalysisState,
): BodyReading {
  let current = EMPTY_BODIES;
  for (const argument of args) {
    const reading = isSpreadElement(argument)
      ? spreadArgumentBodies(call, argument.expression, point, following)
      : bodiesOf(argument, point, following);
    current = mergeSpread(current, reading);
  }
  return current;
}

/** Expands tuple, array, conditional, and mutable-array spread arguments in `Object.assign`. */
function spreadArgumentBodies(
  call: CallExpression,
  expression: Expression,
  point: Node,
  state: AnalysisState,
): BodyReading {
  const value = unwrapped(expression);
  if (state.seen.has(value)) {
    state.cuts.count += 1;
    return EMPTY_BODIES;
  }
  const next: AnalysisState = { ...state, seen: new Set([...state.seen, value]) };
  const tuple = framedAppliedArguments(call, value);
  if (tuple !== undefined) {
    return objectAssignSourcesBodies(call, tuple, point, next);
  }
  if (isArrayLiteralExpression(value)) {
    return objectAssignSourcesBodies(call, value.elements, point, next);
  }
  const alternatives = selectedValues(value);
  if (alternatives !== undefined) {
    const readings = alternatives.map((each) => spreadArgumentBodies(call, each, point, next));
    return {
      bodies: uniqueExpressions(readings.flatMap((each) => each.bodies)),
      overwrites: readings.length > 0 && readings.every((each) => each.overwrites),
    };
  }
  return isIdentifier(value) ? identifierSpreadBodies(call, value, point, next) : EMPTY_BODIES;
}

/** Conservative fallback candidates when an `Object.assign` spread reads a mutable array binding. */
function identifierSpreadBodies(
  call: CallExpression,
  name: Identifier,
  point: Node,
  state: AnalysisState,
): BodyReading {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) {
    return EMPTY_BODIES;
  }
  const collected: Expression[] = [];
  for (const candidate of spreadHolderArrays(name, selected.binding, point)) {
    const array = unwrapped(candidate);
    if (isArrayLiteralExpression(array)) {
      collected.push(...objectAssignSourcesBodies(call, array.elements, point, state).bodies);
    }
  }
  if (isVariableDeclaration(selected.binding)) {
    const holder = framedHeldVariable(selected.binding);
    for (const write of framedMemberWrites(name.getSourceFile())) {
      if (write.holder === holder && write.path.length === 1) {
        collected.push(...bodiesOf(write.value, point, state).bodies);
      }
    }
  }
  return { bodies: uniqueExpressions(collected), overwrites: false };
}

/** Array expressions assigned or defaulted on a variable or parameter spread source. */
function spreadHolderArrays(
  name: Identifier,
  binding: VariableDeclaration | ParameterDeclaration,
  point: Node,
): readonly Expression[] {
  if (isVariableDeclaration(binding)) {
    const held = framedHeldValues(name, [], point);
    const entries =
      held === undefined ? [] : [...(held.initial ? [held.initial] : []), ...held.held];
    return entries.flatMap((each) => resolveHeldExpressions(each, point));
  }
  const resolved = parameterValues(name, binding);
  const sourceValues = resolved.sources.flatMap((each) => resolveHeldExpressions(each, point));
  return resolved.replaced || binding.initializer === undefined
    ? sourceValues
    : [binding.initializer, ...sourceValues];
}

/** Possible request bodies carried by a variable or parameter options alias at `point`. */
function identifierBodies(name: Identifier, point: Node, state: AnalysisState): BodyReading {
  const selected = frameBindingOf(name);
  if (selected === undefined) {
    return EMPTY_BODIES;
  }
  if (isVariableDeclaration(selected.binding)) {
    return variableBodies(name, selected.binding, point, state);
  }
  return isParameterDeclaration(selected.binding)
    ? parameterBodies(name, selected.binding, point, {
        readAssign: (call, sources, at) => objectAssignSourcesBodies(call, sources, at, state),
        readOptions: (each, at) => bodiesOf(each, at, state),
      })
    : EMPTY_BODIES;
}

/** Surviving request body candidates of a variable, including reassignments and member writes. */
function variableBodies(
  name: Identifier,
  declaration: VariableDeclaration,
  point: Node,
  state: AnalysisState,
): BodyReading {
  const whole = framedHeldValues(name, [], name);
  const bodyHeld = framedHeldValues(name, [BODY_KEY], point);
  if (whole === undefined || bodyHeld === undefined) {
    return EMPTY_BODIES;
  }
  const entries =
    bodyHeld.initial === undefined ? bodyHeld.held : [bodyHeld.initial, ...bodyHeld.held];
  const holder = framedHeldVariable(declaration);
  const descriptorWrites = holderDescriptorBodyWrites(holder, (change) =>
    reachesHolderRead(change, holder, point),
  );
  const bodies = uniqueExpressions([
    ...entries.flatMap((entry) => heldOptionBodies(entry, point, state)),
    ...descriptorWrites.flatMap((each) => each.values),
  ]);
  const hidesBody = descriptorWrites.some((each) => each.mayHideBody);
  if (hidesBody || removesHolderBody(name, holder, point)) {
    return { bodies, overwrites: false };
  }
  const definiteEnumerable =
    bodyHeld.initial === undefined ||
    descriptorWrites.some((each) => each.enumerableBody && definitelyBefore(each.node, point));
  if (definiteEnumerable && whole.initial !== undefined && whole.held.length === 0) {
    return { bodies, overwrites: true };
  }
  const wholeEntries = whole.initial === undefined ? whole.held : [whole.initial, ...whole.held];
  const overwrites =
    wholeEntries.length > 0 &&
    wholeEntries.every((each) => {
      return (
        each.keys.length === 0 &&
        bodiesOf(each.value, readingPoint(each.value, point), state).overwrites
      );
    });
  return { bodies, overwrites };
}

/** Body expressions selected by one held options path. */
function heldOptionBodies(entry: Held, point: Node, state: AnalysisState): readonly Expression[] {
  if (entry.keys.length === 0) {
    return [entry.value];
  }
  if (entry.keys.length === 1 && entry.keys[0] === BODY_KEY) {
    return bodiesOf(entry.value, readingPoint(entry.value, point), state).bodies;
  }
  if (entry.keys.at(-1) === BODY_KEY) {
    const holders = resolveHeldExpressions(
      { keys: entry.keys.slice(0, -1), value: entry.value },
      point,
    );
    if (holders.length > 0) {
      return uniqueExpressions(
        holders.flatMap((each) => bodiesOf(each, readingPoint(each, point), state).bodies),
      );
    }
  }
  return resolveHeldExpressions(entry, point);
}

/** Evaluation point where an option source's own fields are read rather than forwarded by reference. */
function readingPoint(expression: Expression, point: Node): Node {
  const value = unwrapped(expression);
  return isCallExpression(value) || isObjectLiteralExpression(value) ? value : point;
}

/** Whether any reachable deletion or whole-object hand-off on `holder` may remove its `body` field. */
function removesHolderBody(name: Identifier, holder: VariableDeclaration, point: Node): boolean {
  return framedMemberDeletes(name.getSourceFile()).some((each) => {
    return (
      each.holder === holder &&
      removesBodyField(each) &&
      reachesHolderRead(each.node, holder, point)
    );
  });
}

/** Whether a recorded deletion or hand-off targets `body`, an unknown key, or the root holder itself. */
function removesBodyField(change: MemberDelete): boolean {
  if (change.handed) {
    return change.path.length === 0;
  }
  return change.path.length === 1 && change.path[0]?.includes(BODY_KEY) !== false;
}

/** Whether `change` can execute before `point`, from another owner, on a shared holder, or via a loop. */
function reachesHolderRead(change: Node, holder: VariableDeclaration, point: Node): boolean {
  if (!framedPossibleBranch(change)) {
    return false;
  }
  const owner = executionOwner(point);
  if (
    executionOwner(change) !== owner ||
    executionOwner(holder) !== owner ||
    change.pos < point.end ||
    destructuredFirst(change, point) ||
    ownerKeyFirst(change, point)
  ) {
    return true;
  }
  return repeatedFrameRead(change, point, holder, owner);
}

/** What a surviving property proves or may add to the possible request bodies. */
function propertyBodies(
  property: ObjectLiteralElementLike,
  previous: BodyReading,
  state: AnalysisState,
): BodyReading {
  if (isSpreadAssignment(property)) {
    return previous;
  }
  const key = optionPropertyKey(property.name);
  const held = optionPropertyValue(property);
  if (key === BODY_KEY) {
    return { bodies: held === undefined ? [] : [held], overwrites: true };
  }
  return key === undefined && held !== undefined && isFormData(held, { ...state, seen: new Set() })
    ? { ...previous, bodies: uniqueExpressions([...previous.bodies, held]) }
    : previous;
}
