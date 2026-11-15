import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isIdentifier,
  isNewExpression,
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
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedHeldVariable, framedMemberDeletes } from './framed-member-writes.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { namesType } from './framed.ts';
import { type BodyReading, parameterBodies, parameterValues } from './multipart-parameters.ts';
import { constantValue } from './numbers.ts';

/** What constructing a Request or Response draws at random for a FormData multipart boundary. */

interface AnalysisState {
  readonly cuts: { count: number };
  readonly formData: Map<Expression, boolean>;
  readonly readings: Map<Expression, Map<Node, BodyReading>>;
  readonly seen: ReadonlySet<Expression>;
}

const EMPTY_BODIES: BodyReading = { bodies: [], overwrites: false };
const FORM_DATA_NAMES: ReadonlySet<string> = new Set(['FormData']);

/** Fresh memoization tables and empty cycle trail for one multipart construction check. */
function startAnalysis(): AnalysisState {
  return {
    cuts: { count: 0 },
    formData: new Map(),
    readings: new Map(),
    seen: new Set(),
  };
}

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
      bodies: readings.flatMap((each) => each.bodies),
      overwrites: readings.length > 0 && readings.every((each) => each.overwrites),
    };
  }
  if (
    isCallExpression(value) &&
    globalPathOf(unwrapped(value.expression))?.join('.') === 'Object.assign'
  ) {
    return objectAssignBodies(value.arguments, point, following);
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

/** Surviving body candidates across positional sources passed to `Object.assign`. */
function objectAssignBodies(
  args: readonly Expression[],
  point: Node,
  following: AnalysisState,
): BodyReading {
  let current = EMPTY_BODIES;
  for (const argument of args) {
    if (isSpreadElement(argument)) {
      continue;
    }
    current = mergeSpread(current, bodiesOf(argument, point, following));
  }
  return current;
}

/** Combines an earlier body reading with a spread source that may or may not define `body`. */
function mergeSpread(previous: BodyReading, spread: BodyReading): BodyReading {
  return {
    bodies: spread.overwrites ? spread.bodies : [...previous.bodies, ...spread.bodies],
    overwrites: previous.overwrites || spread.overwrites,
  };
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
    ? parameterBodies(name, selected.binding, point, (each, at) => bodiesOf(each, at, state))
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
  const bodyHeld = framedHeldValues(name, ['body'], point);
  if (whole === undefined || bodyHeld === undefined) {
    return EMPTY_BODIES;
  }
  const entries =
    bodyHeld.initial === undefined ? bodyHeld.held : [bodyHeld.initial, ...bodyHeld.held];
  const bodies = entries.flatMap((entry) => heldOptionBodies(entry, point, state));
  const holder = framedHeldVariable(declaration);
  const deleted = framedMemberDeletes(name.getSourceFile()).some((each) => each.holder === holder);
  if (deleted) {
    return { bodies, overwrites: false };
  }
  if (whole.initial !== undefined && whole.held.length === 0 && bodyHeld.initial === undefined) {
    return { bodies, overwrites: true };
  }
  const wholeEntries = whole.initial === undefined ? whole.held : [whole.initial, ...whole.held];
  const overwrites =
    wholeEntries.length > 0 &&
    wholeEntries.every(
      (each) => each.keys.length === 0 && bodiesOf(each.value, each.value, state).overwrites,
    );
  return { bodies, overwrites };
}

/** Body expressions selected by one held options path. */
function heldOptionBodies(entry: Held, point: Node, state: AnalysisState): readonly Expression[] {
  if (entry.keys.length === 0) {
    return [entry.value];
  }
  if (entry.keys.length === 1 && entry.keys[0] === 'body') {
    const at = isIdentifier(unwrapped(entry.value)) ? point : entry.value;
    return bodiesOf(entry.value, at, state).bodies;
  }
  return (framedObjectSources(entry.value, entry.keys) ?? [])
    .filter((each) => each.keys.length === 0)
    .map((each) => each.value);
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
  if (key === 'body') {
    return { bodies: held === undefined ? [] : [held], overwrites: true };
  }
  return key === undefined && held !== undefined && isFormData(held, { ...state, seen: new Set() })
    ? { ...previous, bodies: [...previous.bodies, held] }
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

/** The alternatives an expression can select as its value, without interpreting its condition. */
function selectedValues(value: Expression): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse];
  }
  if (isBinaryExpression(value)) {
    if (value.operatorToken.kind === SyntaxKind.CommaToken) {
      return [value.right];
    }
    if (
      [
        SyntaxKind.AmpersandAmpersandToken,
        SyntaxKind.BarBarToken,
        SyntaxKind.QuestionQuestionToken,
      ].includes(value.operatorToken.kind)
    ) {
      return [value.left, value.right];
    }
  }
  return undefined;
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

/** Whether a body is FormData the code constructs, assigns, or annotates, memoized across DAGs. */
function isFormData(node: Expression, state: AnalysisState): boolean {
  const value = unwrapped(node);
  const cached = state.formData.get(value);
  if (cached !== undefined) {
    return cached;
  }
  if (state.seen.has(value)) {
    state.cuts.count += 1;
    return false;
  }
  const cutsBefore = state.cuts.count;
  const following: AnalysisState = { ...state, seen: new Set([...state.seen, value]) };
  const result = computeFormData(value, following);
  if (state.cuts.count === cutsBefore) {
    state.formData.set(value, result);
  }
  return result;
}

/** Evaluates whether one unwrapped body expression may hold `FormData` without consulting cache. */
function computeFormData(value: Expression, following: AnalysisState): boolean {
  if (isIdentifier(value)) {
    return identifierFormData(value, following);
  }
  const alternatives = selectedValues(value);
  if (alternatives !== undefined) {
    return alternatives.some((each) => isFormData(each, following));
  }
  return (
    isNewExpression(value) && globalPathOf(unwrapped(value.expression))?.join('.') === 'FormData'
  );
}

/** Whether a variable or parameter read may hold a `FormData` instance at `name`. */
function identifierFormData(name: Identifier, state: AnalysisState): boolean {
  const selected = frameBindingOf(name);
  if (selected === undefined) {
    return false;
  }
  if (isVariableDeclaration(selected.binding)) {
    const held = framedHeldValues(name, [], name);
    if (held === undefined) {
      return false;
    }
    const entries = held.initial === undefined ? held.held : [held.initial, ...held.held];
    if (entries.length === 0) {
      return selected.keys.length === 0 && namesType(selected.binding.type, FORM_DATA_NAMES);
    }
    return entries.some((entry) => heldFormData(entry, state));
  }
  if (!isParameterDeclaration(selected.binding)) {
    return false;
  }
  const resolved =
    selected.keys.length === 0
      ? parameterValues(name, selected.binding)
      : { replaced: false, values: [] };
  if (resolved.replaced) {
    return resolved.values.some((each) => isFormData(each, state));
  }
  const assigned = framedAssignedSources(name).some((each) => heldFormData(each, state));
  const typed = selected.keys.length === 0 && namesType(selected.binding.type, FORM_DATA_NAMES);
  return assigned || typed;
}

/** Whether a held value or destructured member path may evaluate to `FormData`. */
function heldFormData(entry: Held, state: AnalysisState): boolean {
  if (entry.keys.length === 0) {
    return isFormData(entry.value, state);
  }
  const sources = framedObjectSources(entry.value, entry.keys) ?? [];
  return sources.some((each) => each.keys.length === 0 && isFormData(each.value, state));
}
