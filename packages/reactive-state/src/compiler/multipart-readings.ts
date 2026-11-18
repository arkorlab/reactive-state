import {
  type BinaryExpression,
  type BindingName,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isSourceFile,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { ownerKeyFirst } from './class-key-order.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedMemberDeletes } from './framed-member-writes.ts';
import { framedValueShape } from './framed-values.ts';
import { framedAssignedSources, framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { namesLocalMemberType } from './local-type-reading.ts';
import { leafMayBeOpaqueFormData } from './multipart-dynamic-sources.ts';
import {
  bindingDefaultsOf,
  type HeldResolution,
  isUnrepeatedSelfWrite,
  lastDefiniteBindingWrite,
  type ProjectionCallbacks,
} from './multipart-held-bindings.ts';
import {
  inspectHeldPath,
  peeledMemberHolder,
  selectedValues,
  uniqueExpressions,
} from './multipart-held-paths.ts';
import {
  NO_PATTERN_REASSIGNMENT,
  patternBindingReassignments,
  type PatternReassignmentScan,
  type PatternTargetDeclaration,
} from './multipart-projections.ts';

/** Shared multipart `BodyReading` combinators, parameter value cuts, and `FormData` checks. */

export interface BodyReading {
  readonly ambiguous?: boolean | undefined;
  readonly bodies: readonly Expression[];
  readonly enumerableBodies?: readonly Expression[] | undefined;
  readonly noEnumerableBody?: boolean | undefined;
  readonly overwrites: boolean;
}

export interface AnalysisState {
  readonly cuts: { count: number };
  readonly formData: Map<Expression, boolean>;
  readonly readings: Map<Expression, Map<Node, BodyReading>>;
  readonly seen: ReadonlySet<Expression>;
}

export interface ParameterResolution {
  readonly ambiguous?: boolean | undefined;
  readonly cut?: BinaryExpression | undefined;
  readonly dynamicOpaque?: boolean | undefined;
  readonly replaced: boolean;
  readonly sources: readonly Held[];
  readonly values: readonly Expression[];
}

export const EMPTY_BODIES: BodyReading = { bodies: [], overwrites: false };
export const PLAIN_EMPTY_BODIES: BodyReading = {
  bodies: [],
  enumerableBodies: [],
  noEnumerableBody: true,
  overwrites: false,
};

const BODY_KEY = 'body';

const FORM_DATA_NAMES: ReadonlySet<string> = new Set(['FormData']);

const PROJECTION_CALLBACKS: ProjectionCallbacks = {
  bindingDefaults: bindingDefaultsOf,
  isAssertedFormData: assertedAtMemberPath,
  isBindingTypedFormData: bindingTypedAtMemberPath,
  isOpaqueLeaf: (leaf, point) => leafMayBeOpaqueFormData(leaf, point, PROJECTION_CALLBACKS),
  readParameter: parameterValues,
  readVariablePattern: variablePatternReassignments,
  selectValues: selectedValues,
};

/** Whether `leaf` may evaluate to an opaque runtime value rather than a closed non-`FormData` syntax. */
export function opaqueBodyLeaf(leaf: Expression, point: Node): boolean {
  return leafMayBeOpaqueFormData(leaf, point, PROJECTION_CALLBACKS);
}

/** Fresh memoization tables and empty cycle trail for one multipart construction check. */
export function startAnalysis(): AnalysisState {
  return {
    cuts: { count: 0 },
    formData: new Map(),
    readings: new Map(),
    seen: new Set(),
  };
}

/** Enumerable own `body` candidates of `reading`, defaulting to `reading.bodies` when unfiltered. */
export function enumerableBodiesOf(reading: BodyReading): readonly Expression[] {
  return reading.enumerableBodies ?? reading.bodies;
}

/** Combines alternative branch `BodyReading`s across conditionals and logical expressions. */
export function combineBranchReadings(readings: readonly BodyReading[]): BodyReading {
  return {
    ambiguous: readings.some((each) => each.ambiguous === true),
    bodies: uniqueExpressions(readings.flatMap((each) => each.bodies)),
    enumerableBodies: uniqueExpressions(readings.flatMap((each) => enumerableBodiesOf(each))),
    noEnumerableBody:
      readings.length > 0 && readings.every((each) => each.noEnumerableBody === true),
    overwrites: readings.length > 0 && readings.every((each) => each.overwrites),
  };
}

/** Combines an earlier body reading with a spread source that copies only enumerable own properties. */
export function mergeSpread(previous: BodyReading, spread: BodyReading): BodyReading {
  if (spread.noEnumerableBody === true && spread.ambiguous !== true) {
    return previous;
  }
  const spreadBodies = enumerableBodiesOf(spread);
  const prevEnumerable = enumerableBodiesOf(previous);
  return {
    ambiguous: spread.overwrites
      ? Boolean(spread.ambiguous)
      : Boolean(previous.ambiguous) || Boolean(spread.ambiguous),
    bodies: uniqueExpressions(
      spread.overwrites ? spreadBodies : [...previous.bodies, ...spreadBodies],
    ),
    enumerableBodies: uniqueExpressions(
      spread.overwrites ? spreadBodies : [...prevEnumerable, ...spreadBodies],
    ),
    overwrites: previous.overwrites || spread.overwrites,
  };
}

/** Whether `name`'s declared `'body'` type names `FormData` while surviving `bodies` carry an opaque leaf. */
export function opaqueTypedHolderBodies(
  name: Identifier,
  bodies: readonly Expression[],
  point: Node,
): boolean {
  return (
    bindingTypedAtMemberPath(name, [BODY_KEY]) && bodies.some((each) => opaqueBodyLeaf(each, point))
  );
}

/** Whether any reachable deletion or whole-object hand-off on `holder` may remove `'body'`. */
export function holderMayDeleteBody(
  file: SourceFile,
  holder: VariableDeclaration,
  reaches: (change: Node) => boolean,
): boolean {
  return framedMemberDeletes(file).some((each) => {
    if (each.holder !== holder || !reaches(each.node)) {
      return false;
    }
    return each.handed
      ? each.path.length === 0
      : each.path.length === 1 && each.path[0]?.includes(BODY_KEY) !== false;
  });
}

/** Evaluation point where an option source's own fields are read rather than forwarded by reference. */
export function readingPoint(expression: Expression, point: Node): Node {
  const value = unwrapped(expression);
  return isCallExpression(value) || isObjectLiteralExpression(value) ? value : point;
}

/** Whether `change` can execute before `point`, from another owner, on a shared holder, or via a loop. */
export function reachesHolderRead(change: Node, holder: VariableDeclaration, point: Node): boolean {
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

/** Unfolds concrete expressions and cycle/type flags along a `Held` member path at `point`. */
export function resolveHeldReading(
  entry: Held,
  point: Node,
  activeSource?: Identifier,
): HeldResolution {
  return inspectHeldPath(entry, point, PROJECTION_CALLBACKS, activeSource);
}

/** Values assigned to a parameter before `name`, noting whether a definite write replaced the initial binding. */
export function parameterValues(
  name: Identifier,
  parameter: ParameterDeclaration,
): ParameterResolution {
  const owner = executionOwner(name);
  const cut = lastDefiniteBindingWrite(name, name, parameter, owner);
  const sources = framedAssignedSources(name).filter(
    (each) => !isUnrepeatedSelfWrite(each.value, name, parameter),
  );
  const patternScan = patternBindingReassignments(
    name,
    parameter,
    (change) => {
      return (
        reachesPoint(change, name, parameter, name) &&
        (cut === undefined || (change !== cut && !supersededBefore(change, cut, name)))
      );
    },
    PROJECTION_CALLBACKS,
  );
  if (cut === undefined) {
    const allSources = [...sources, ...patternScan.extraSources];
    const assigned = allSources.filter((each) => each.keys.length === 0).map((each) => each.value);
    return {
      ambiguous: patternScan.ambiguous || allSources.length !== assigned.length,
      dynamicOpaque: patternScan.dynamicOpaque,
      replaced: false,
      sources: allSources,
      values: assigned,
    };
  }
  const laterSources = [
    ...sources.filter((each) => {
      return (
        each.value !== cut.right &&
        (each.value.pos > cut.pos || executionOwner(each.value) !== owner)
      );
    }),
    ...patternScan.extraSources,
  ];
  const later = laterSources.filter((each) => each.keys.length === 0).map((each) => each.value);
  return {
    ambiguous: patternScan.ambiguous || laterSources.length !== later.length,
    cut,
    dynamicOpaque: patternScan.dynamicOpaque,
    replaced: true,
    sources: [{ keys: [], value: cut.right }, ...laterSources],
    values: [cut.right, ...later],
  };
}

/** Scans dynamic/rest pattern reassignments reaching a mutable `VariableDeclaration` at `point`. */
export function variablePatternReassignments(
  name: Identifier,
  declaration: VariableDeclaration,
  point: Node,
): PatternReassignmentScan {
  if (
    isIdentifier(declaration.name) &&
    isVariableDeclarationList(declaration.parent) &&
    /^const\s/u.test(declaration.parent.getText(declaration.getSourceFile()))
  ) {
    return NO_PATTERN_REASSIGNMENT;
  }
  const owner = executionOwner(point);
  const cut = lastDefiniteBindingWrite(point, name, declaration, owner);
  return patternBindingReassignments(
    name,
    declaration,
    (change) => {
      return (
        reachesPoint(change, name, declaration, point) &&
        (cut === undefined || (change !== cut && !supersededBefore(change, cut, point)))
      );
    },
    PROJECTION_CALLBACKS,
  );
}

/** Whether a change may run before `point`: from another owner, earlier, or via an enclosing loop. */
export function reachesPoint(
  change: Node,
  name: Identifier,
  binding: PatternTargetDeclaration,
  point: Node,
): boolean {
  if (!framedPossibleBranch(change)) {
    return false;
  }
  const owner = executionOwner(point);
  if (
    isBinaryExpression(change) &&
    point.pos >= change.right.pos &&
    point.end <= change.right.end &&
    !repeatedFrameRead(change, point, binding, owner)
  ) {
    return false;
  }
  if (
    executionOwner(change) !== owner ||
    change.pos < point.end ||
    destructuredFirst(change, point)
  ) {
    return true;
  }
  return repeatedFrameRead(change, name, binding, owner);
}

/** Whether `change` ran in the same execution owner strictly before `cut`. */
export function supersededBefore(change: Node, cut: Node, anchor: Node): boolean {
  return change.pos < cut.pos && executionOwner(change) === executionOwner(anchor);
}

/** Whether `change` is an earlier statement of an enclosing block in the same execution owner as `point`. */
export function definitelyBefore(change: Node, point: Node): boolean {
  if (executionOwner(change) !== executionOwner(point)) {
    return false;
  }
  const statement = change.parent;
  if (!isExpressionStatement(statement)) {
    return false;
  }
  const block = statement.parent;
  if (!isBlock(block) && !isSourceFile(block)) {
    return false;
  }
  for (let at: Node = point; !isSourceFile(at); at = at.parent) {
    if (at.parent === block) {
      return at.pos > statement.pos;
    }
  }
  return false;
}

/** Whether a body is FormData the code constructs, assigns, or annotates, memoized across DAGs. */
export function isFormData(node: Expression, state: AnalysisState): boolean {
  const value = unwrapped(node);
  if (assertedAtMemberPath(node, []) && opaqueBodyLeaf(value, node)) {
    return true;
  }
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
  const peeled = peeledMemberHolder(value);
  if (peeled !== undefined) {
    return heldFormData(peeled, following, value);
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
    return variableFormData(name, selected.binding, selected.keys, state);
  }
  return (
    isParameterDeclaration(selected.binding) &&
    parameterFormData(name, selected.binding, selected.keys, state)
  );
}

/** Whether a held, destructured, or defaulted variable read may hold `FormData`. */
function variableFormData(
  name: Identifier,
  declaration: VariableDeclaration,
  _keys: readonly string[],
  state: AnalysisState,
): boolean {
  const held = framedHeldValues(name, [], name);
  if (held === undefined) {
    return false;
  }
  const patternScan = variablePatternReassignments(name, declaration, name);
  if (patternScan.dynamicOpaque) {
    return true;
  }
  const defaulted =
    held.initial !== undefined && bindingDefaultFormData(name, declaration.name, state);
  const liveHeld = held.held.filter(
    (entry) => !isUnrepeatedSelfWrite(entry.value, name, declaration),
  );
  const entries = [
    ...(held.initial === undefined ? [] : [held.initial]),
    ...liveHeld,
    ...patternScan.extraSources,
  ];
  const declaredTyped = bindingTypedAtMemberPath(name, []);
  if (entries.length === 0) {
    return defaulted || declaredTyped;
  }
  const hasOpaqueTypedLeaf =
    declaredTyped &&
    entries.some((entry) => entry.keys.length === 0 && opaqueBodyLeaf(entry.value, name));
  return (
    defaulted ||
    hasOpaqueTypedLeaf ||
    entries.some((entry) => heldFormData(entry, state, name, name))
  );
}

/** Whether a parameter read (including projected reassignments or defaults) may hold `FormData`. */
function parameterFormData(
  name: Identifier,
  parameter: ParameterDeclaration,
  keys: readonly string[],
  state: AnalysisState,
): boolean {
  const resolved = parameterValues(name, parameter);
  if (
    resolved.dynamicOpaque === true ||
    resolved.sources.some((each) => heldFormData(each, state, name, name))
  ) {
    return true;
  }
  const typed = bindingTypedAtMemberPath(name, []);
  if (resolved.replaced && resolved.ambiguous !== true) {
    return (
      typed &&
      resolved.sources.some((each) => each.keys.length === 0 && opaqueBodyLeaf(each.value, name))
    );
  }
  const paramDefault =
    parameter.initializer !== undefined &&
    heldFormData({ keys, value: parameter.initializer }, state, name);
  const patternDefault = keys.length > 0 && bindingDefaultFormData(name, parameter.name, state);
  const assigned = framedAssignedSources(name)
    .filter((each) => !isUnrepeatedSelfWrite(each.value, name, parameter))
    .some((each) => heldFormData(each, state, name, name));
  return paramDefault || patternDefault || assigned || typed;
}

/** Checks any `BindingElement` default initializer matching `name` within a destructuring pattern. */
function bindingDefaultFormData(
  name: Identifier,
  root: BindingName,
  state: AnalysisState,
): boolean {
  return bindingDefaultsOf(name, root).some((each) => isFormData(each, state));
}

/** Whether a held value or destructured member path may evaluate to `FormData`. */
function heldFormData(
  entry: Held,
  state: AnalysisState,
  point: Node,
  activeSource?: Identifier,
): boolean {
  if (entry.keys.length === 0) {
    return isFormData(entry.value, state);
  }
  const resolved = resolveHeldReading(entry, point, activeSource);
  return (
    resolved.ambiguous ||
    resolved.typedFormData ||
    resolved.expressions.some((each) => isFormData(each, state))
  );
}

/** Whether explicit type assertions on `raw` name `FormData` at `keys`. */
function assertedAtMemberPath(raw: Expression, keys: readonly string[]): boolean {
  const { assertions } = framedValueShape(raw);
  return assertions.some((each) =>
    namesLocalMemberType(each.type, [...each.keys, ...keys], FORM_DATA_NAMES),
  );
}

/** Whether `id`'s declared binding type annotation names `FormData` at `keys`. */
export function bindingTypedAtMemberPath(id: Identifier, keys: readonly string[]): boolean {
  const selected = frameBindingOf(id);
  return (
    selected?.binding.type !== undefined &&
    namesLocalMemberType(selected.binding.type, [...selected.keys, ...keys], FORM_DATA_NAMES)
  );
}
