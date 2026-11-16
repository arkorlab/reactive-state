import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { ownerKeyFirst } from './class-key-order.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedAppliedArguments } from './framed-keys.ts';
import {
  framedHeldVariable,
  framedMemberDeletes,
  framedMemberWrites,
  type MemberDelete,
} from './framed-member-writes.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { parameterBodies } from './multipart-parameters.ts';
import {
  type AnalysisState,
  type BodyReading,
  EMPTY_BODIES,
  isFormData,
  mergeSpread,
  parameterValues,
  selectedValues,
  startAnalysis,
  uniqueExpressions,
} from './multipart-readings.ts';
import { constantValue } from './numbers.ts';

/** What constructing a Request or Response draws at random for a FormData multipart boundary. */

const BODY_KEY = 'body';

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

/** Evaluates `BodyReading` for one unwrapped options expression without consulting the cache. */
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
  if (
    isCallExpression(value) &&
    globalPathOf(unwrapped(value.expression))?.join('.') === 'Object.assign'
  ) {
    return objectAssignSourcesBodies(value, value.arguments, point, following);
  }
  return isObjectLiteralExpression(value) ? literalBodies(value, following) : EMPTY_BODIES;
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
    return entries.filter((each) => each.keys.length === 0).map((each) => each.value);
  }
  const resolved = parameterValues(name, binding);
  return resolved.replaced || binding.initializer === undefined
    ? resolved.values
    : [binding.initializer, ...resolved.values];
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
  const bodies = uniqueExpressions(
    entries.flatMap((entry) => heldOptionBodies(entry, point, state)),
  );
  const holder = framedHeldVariable(declaration);
  if (removesHolderBody(name, holder, point)) {
    return { bodies, overwrites: false };
  }
  if (whole.initial !== undefined && whole.held.length === 0 && bodyHeld.initial === undefined) {
    return { bodies, overwrites: true };
  }
  const wholeEntries = whole.initial === undefined ? whole.held : [whole.initial, ...whole.held];
  const overwrites =
    wholeEntries.length > 0 &&
    wholeEntries.every(
      (each) =>
        each.keys.length === 0 &&
        bodiesOf(each.value, readingPoint(each.value, point), state).overwrites,
    );
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
  return (framedObjectSources(entry.value, entry.keys) ?? [])
    .filter((each) => each.keys.length === 0)
    .map((each) => each.value);
}

/** Evaluation point where an option source's own fields are read rather than forwarded by reference. */
function readingPoint(expression: Expression, point: Node): Node {
  const value = unwrapped(expression);
  return isCallExpression(value) || isObjectLiteralExpression(value) ? value : point;
}

/** Whether any reachable deletion or whole-object hand-off on `holder` may remove its `body` field. */
function removesHolderBody(name: Identifier, holder: VariableDeclaration, point: Node): boolean {
  return framedMemberDeletes(name.getSourceFile()).some(
    (each) =>
      each.holder === holder &&
      removesBodyField(each) &&
      reachesHolderRead(each.node, holder, point),
  );
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
  const key = optionKey(property.name);
  const held = propertyValue(property);
  if (key === BODY_KEY) {
    return { bodies: held === undefined ? [] : [held], overwrites: true };
  }
  return key === undefined && held !== undefined && isFormData(held, { ...state, seen: new Set() })
    ? { ...previous, bodies: uniqueExpressions([...previous.bodies, held]) }
    : previous;
}

/** The value an ordinary option property writes, rather than what an accessor may compute. */
function propertyValue(property: ObjectLiteralElementLike): Expression | undefined {
  if (isPropertyAssignment(property)) {
    return property.initializer;
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}

/** What an option's property name writes, including a key computed from constants. */
function optionKey(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return isComputedPropertyName(name) ? constantKey(name.expression, new Set()) : undefined;
}

/** The text of a constant key, including additions of text through single-valued bindings. */
function constantKey(node: Expression, seen: ReadonlySet<Expression>): string | undefined {
  const constant = constantValue(node, singleIdentifierValue);
  if (constant !== undefined) {
    return String(constant);
  }
  const value = singleExpressionOf(node, seen);
  if (
    seen.has(value) ||
    !isBinaryExpression(value) ||
    value.operatorToken.kind !== SyntaxKind.PlusToken
  ) {
    return undefined;
  }
  const following = new Set([...seen, value]);
  const left = constantKey(value.left, following);
  const right = constantKey(value.right, following);
  return left === undefined || right === undefined ? undefined : left + right;
}

/** Follows single-valued identifier bindings without treating multi-branch writes as constants. */
function singleExpressionOf(node: Expression, seen: ReadonlySet<Expression>): Expression {
  let value = unwrapped(node);
  const local = new Set(seen);
  while (isIdentifier(value) && !local.has(value)) {
    const single = singleIdentifierValue(value);
    if (single === undefined) {
      break;
    }
    local.add(value);
    value = unwrapped(single);
  }
  return value;
}

/** The unique expression a variable holds at `name`, or undefined when multiple values reach it. */
function singleIdentifierValue(name: Identifier): Expression | undefined {
  const held = framedHeldValues(name, [], name);
  if (held === undefined) {
    return undefined;
  }
  const entries = held.initial === undefined ? held.held : [held.initial, ...held.held];
  const only = entries.length === 1 ? entries[0] : undefined;
  return only !== undefined && only.keys.length === 0 ? only.value : undefined;
}
