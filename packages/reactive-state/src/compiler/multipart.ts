import {
  type CallExpression,
  type Expression,
  type Identifier,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedHeldVariable } from './framed-member-writes.ts';
import { objectAssignCallBodies, objectAssignSourcesBodies } from './multipart-assign-spreads.ts';
import { resolveVariableDescriptorWrites } from './multipart-descriptor-cuts.ts';
import {
  applyDescriptorWrite,
  mapDescriptorBodyWrite,
  optionPropertyKey,
  optionPropertyValue,
  singleDescriptorBodyWrite,
  type RecordedDescriptorBodyWrite,
} from './multipart-descriptors.ts';
import { sourceFactory } from './multipart-factories.ts';
import { peeledMemberHolder, selectedValues, uniqueExpressions } from './multipart-held-paths.ts';
import { parameterBodies } from './multipart-parameters.ts';
import {
  type AnalysisState,
  type BodyReading,
  combineBranchReadings,
  definitelyBefore,
  EMPTY_BODIES,
  enumerableBodiesOf,
  holderMayDeleteBody,
  isFormData,
  mergeSpread,
  opaqueTypedHolderBodies,
  PLAIN_EMPTY_BODIES,
  reachesHolderRead,
  readingPoint,
  resolveHeldReading,
  startAnalysis,
  variablePatternReassignments,
} from './multipart-readings.ts';

/** What constructing a Request or Response draws at random for a FormData multipart boundary. */

const BODY_KEY = 'body';
const DEFINED = { slots: 3 } as const;
const MULTIPART_MESSAGE =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

/** What constructing a Request or Response draws at random for a FormData multipart boundary. */
export function multipartMaking(node: NewExpression, path: string | undefined): string | undefined {
  const state = startAnalysis();
  const first = node.arguments?.[0];
  if (path === 'Response') {
    return first !== undefined && isFormData(first, { ...state, seen: new Set() })
      ? MULTIPART_MESSAGE
      : undefined;
  }
  const reading = requestReading(node, path, state);
  return reading.ambiguous === true ||
    reading.bodies.some((body) => isFormData(body, { ...state, seen: new Set() }))
    ? MULTIPART_MESSAGE
    : undefined;
}

/** What a Request's options show of its body, after aliases, mutations and object spreads. */
function requestReading(
  node: NewExpression,
  path: string | undefined,
  state: AnalysisState,
): BodyReading {
  const options = path === 'Request' ? node.arguments?.[1] : undefined;
  return options === undefined ? EMPTY_BODIES : bodiesOf(options, node, state);
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
    return combineBranchReadings(alternatives.map((each) => bodiesOf(each, point, following)));
  }
  if (isCallExpression(value)) {
    return callExpressionBodies(value, point, following);
  }
  if (isObjectLiteralExpression(value)) {
    return literalBodies(value, following);
  }
  const isFreshEmptyObject =
    isNewExpression(value) &&
    (value.arguments?.length ?? 0) === 0 &&
    globalPathOf(unwrapped(value.expression))?.join('.') === 'Object';
  return isFreshEmptyObject ? PLAIN_EMPTY_BODIES : EMPTY_BODIES;
}

/** Evaluates `Object.assign`, `Object.defineProperty`, `Object.defineProperties`, and `Object.create` options. */
function callExpressionBodies(
  call: CallExpression,
  point: Node,
  following: AnalysisState,
): BodyReading {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path === 'Object.assign') {
    return objectAssignCallBodies(call, { point, readOptions: bodiesOf, state: following });
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
  return path === 'Object.create'
    ? objectCreateBodies(call, point, following)
    : factoryBodies(call, following);
}

/**
 * The options a source-written function returns, each read where its `return` writes it, and
 * ambiguous when the call gives it `FormData` or options that carry it: the function may put
 * what it is given into the options it returns. Never an overwrite: a function can return nothing,
 * by a bare `return`, a path without one, or a `switch` without a default, and the spread of
 * nothing leaves the earlier body.
 */
function factoryBodies(call: CallExpression, following: AnalysisState): BodyReading {
  const factory = sourceFactory(call);
  if (factory === undefined) {
    return EMPTY_BODIES;
  }
  const reading = {
    ...combineBranchReadings(factory.returned.map((each) => bodiesOf(each, each, following))),
    overwrites: false,
  };
  return factory.given.some((each) => givesFormData(each, call, following))
    ? { ...reading, ambiguous: true }
    : reading;
}

/** Whether an argument is `FormData`, or options whose body may be. */
function givesFormData(argument: Expression, point: Node, state: AnalysisState): boolean {
  const fresh: AnalysisState = { ...state, seen: new Set() };
  const reading = bodiesOf(argument, point, state);
  return (
    isFormData(argument, fresh) ||
    reading.ambiguous === true ||
    reading.bodies.some((body) => isFormData(body, fresh))
  );
}

/** Evaluates `Object.create(proto, descriptors?)`, keeping prototype `body` reads non-enumerable. */
function objectCreateBodies(
  call: CallExpression,
  point: Node,
  following: AnalysisState,
): BodyReading {
  const [proto, descriptors] = framedArgumentPrefix(call, call.arguments).values;
  const protoReading = proto === undefined ? EMPTY_BODIES : bodiesOf(proto, point, following);
  const base: BodyReading = {
    ambiguous: protoReading.ambiguous,
    bodies: protoReading.bodies,
    enumerableBodies: [],
    noEnumerableBody: true,
    overwrites: false,
  };
  const firstOnly =
    call.arguments.length < 2 &&
    (call.arguments[0] === undefined || !isSpreadElement(call.arguments[0]));
  return firstOnly ? base : applyDescriptorWrite(base, mapDescriptorBodyWrite(descriptors));
}

/** Surviving body candidates across the properties and spreads of a written options literal. */
function literalBodies(value: ObjectLiteralExpression, following: AnalysisState): BodyReading {
  let current = PLAIN_EMPTY_BODIES;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      current = mergeSpread(current, bodiesOf(property.expression, property, following));
      continue;
    }
    current = propertyBodies(property, current, following);
  }
  return current;
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
        readAssign: (call, sources, at) =>
          objectAssignSourcesBodies(call, sources, { point: at, readOptions: bodiesOf, state }),
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
  const patternScan = variablePatternReassignments(name, declaration, point);
  const holder = framedHeldVariable(declaration);
  const filteredDescriptors = resolveVariableDescriptorWrites({
    ambiguousPattern: patternScan.ambiguous,
    declaration,
    holder,
    overwritesAssign: (call, sources) => {
      return objectAssignSourcesBodies(call, sources, { point: call, readOptions: bodiesOf, state })
        .overwrites;
    },
    point,
    reaches: (change) => reachesHolderRead(change, holder, point),
    whole,
  });
  const entries = [
    ...(bodyHeld.initial === undefined ? [] : [bodyHeld.initial]),
    ...bodyHeld.held,
    ...filteredDescriptors.extraHeld,
    ...patternScan.extraSources.map((each) => ({ ...each, keys: [...each.keys, BODY_KEY] })),
  ];
  const entryReadings = entries.map((entry) => heldOptionReading(entry, point, state, name));
  const bodies = uniqueExpressions([
    ...entryReadings.flatMap((each) => each.bodies),
    ...filteredDescriptors.activeValues.flatMap((each) => each.values),
  ]);
  const ambiguous =
    patternScan.dynamicOpaque ||
    entryReadings.some((each) => each.ambiguous === true) ||
    opaqueTypedHolderBodies(name, bodies, point);
  const mayDelete = holderMayDeleteBody(name.getSourceFile(), holder, (change) =>
    reachesHolderRead(change, holder, point),
  );
  if (
    !mayDelete &&
    !ambiguous &&
    !patternScan.ambiguous &&
    filteredDescriptors.definitelyNonEnumerable
  ) {
    return { ambiguous, bodies, enumerableBodies: [], noEnumerableBody: true, overwrites: false };
  }
  const pureWhole =
    !mayDelete &&
    filteredDescriptors.activeMetadata.length === 0 &&
    bodyHeld.held.length === 0 &&
    patternScan.extraSources.length === 0;
  const wholeEnum = pureWholeVariableEnumeration({
    ambiguous: ambiguous || patternScan.ambiguous,
    name,
    point,
    pureWhole,
    state,
    whole,
  });
  const overwrites = variableOverwritesBody({
    activeMetadata: filteredDescriptors.activeMetadata,
    blocked:
      ambiguous ||
      mayDelete ||
      patternScan.ambiguous ||
      filteredDescriptors.activeMetadata.some((each) => each.mayHideBody),
    hasBodyInitial: bodyHeld.initial !== undefined,
    point,
    state,
    whole,
  });
  return { ambiguous, bodies, ...wholeEnum, overwrites };
}

/** Enumerable copy candidates when a variable only forwards whole-object initializers/rebindings. */
function pureWholeVariableEnumeration(input: {
  readonly ambiguous: boolean;
  readonly name: Identifier;
  readonly point: Node;
  readonly pureWhole: boolean;
  readonly state: AnalysisState;
  readonly whole: { readonly held: readonly Held[]; readonly initial?: Held | undefined };
}): Pick<BodyReading, 'enumerableBodies' | 'noEnumerableBody'> {
  if (!input.pureWhole) {
    return {};
  }
  const entries =
    input.whole.initial === undefined
      ? input.whole.held
      : [input.whole.initial, ...input.whole.held];
  const readings = entries.map((each) => {
    return each.keys.length === 0
      ? bodiesOf(each.value, readingPoint(each.value, input.point), input.state)
      : projectedHolderReading(each, input.point, input.state, input.name);
  });
  return {
    enumerableBodies: uniqueExpressions(readings.flatMap((each) => enumerableBodiesOf(each))),
    noEnumerableBody:
      !input.ambiguous &&
      readings.length > 0 &&
      readings.every((each) => each.noEnumerableBody === true),
  };
}

/** Whether spreading a variable definitely overwrites an earlier `body` property. */
function variableOverwritesBody(input: {
  readonly activeMetadata: readonly RecordedDescriptorBodyWrite[];
  readonly blocked: boolean;
  readonly hasBodyInitial: boolean;
  readonly point: Node;
  readonly state: AnalysisState;
  readonly whole: { readonly held: readonly Held[]; readonly initial?: Held | undefined };
}): boolean {
  if (input.blocked) {
    return false;
  }
  const definiteEnumerable =
    !input.hasBodyInitial ||
    input.activeMetadata.some(
      (each) => each.enumerableBody && definitelyBefore(each.node, input.point),
    );
  if (definiteEnumerable && input.whole.initial !== undefined && input.whole.held.length === 0) {
    return true;
  }
  const entries =
    input.whole.initial === undefined
      ? input.whole.held
      : [input.whole.initial, ...input.whole.held];
  return (
    entries.length > 0 &&
    entries.every((each) => {
      return (
        each.keys.length === 0 &&
        bodiesOf(each.value, readingPoint(each.value, input.point), input.state).overwrites
      );
    })
  );
}

/** Body reading selected by one held options path, preserving ambiguity across member cycles. */
function heldOptionReading(
  entry: Held,
  point: Node,
  state: AnalysisState,
  activeSource?: Identifier,
): BodyReading {
  if (entry.keys.length === 0) {
    return { bodies: [entry.value], overwrites: false };
  }
  if (entry.keys.length === 1 && entry.keys[0] === BODY_KEY) {
    const peeled = peeledMemberHolder(entry.value);
    return peeled === undefined
      ? bodiesOf(entry.value, readingPoint(entry.value, point), state)
      : projectedHolderReading(peeled, point, state, activeSource);
  }
  if (entry.keys.at(-1) === BODY_KEY) {
    const projected = projectedHolderReading(
      { keys: entry.keys.slice(0, -1), value: entry.value },
      point,
      state,
      activeSource,
    );
    if (projected.ambiguous === true || projected.bodies.length > 0) {
      return projected;
    }
  }
  const fallback = resolveHeldReading(entry, point, activeSource);
  return {
    ambiguous: fallback.ambiguous || fallback.typedFormData,
    bodies: fallback.expressions,
    overwrites: false,
  };
}

/** Resolves holder expressions along `holderEntry` and combines their option `BodyReading`s. */
function projectedHolderReading(
  holderEntry: Held,
  point: Node,
  state: AnalysisState,
  activeSource?: Identifier,
): BodyReading {
  const holders = resolveHeldReading(holderEntry, point, activeSource);
  const readings = holders.expressions.map((each) =>
    bodiesOf(each, readingPoint(each, point), state),
  );
  const ambiguous =
    holders.ambiguous || holders.typedFormData || readings.some((each) => each.ambiguous === true);
  return {
    ambiguous,
    bodies: uniqueExpressions(readings.flatMap((each) => each.bodies)),
    enumerableBodies: uniqueExpressions(readings.flatMap((each) => enumerableBodiesOf(each))),
    noEnumerableBody:
      !ambiguous &&
      holders.closed &&
      readings.length > 0 &&
      readings.every((each) => each.noEnumerableBody === true),
    overwrites: false,
  };
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
  if (key !== undefined) {
    return previous;
  }
  const cleared: BodyReading =
    previous.noEnumerableBody === true ? { ...previous, noEnumerableBody: false } : previous;
  return held !== undefined && isFormData(held, { ...state, seen: new Set() })
    ? {
        ...cleared,
        bodies: uniqueExpressions([...cleared.bodies, held]),
        enumerableBodies: uniqueExpressions([...enumerableBodiesOf(cleared), held]),
      }
    : cleared;
}
