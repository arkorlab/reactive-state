import {
  type BinaryExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isConditionalExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isRegularExpressionLiteral,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTypeOfExpression,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, parametersOf } from './answers.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { rootOf, targetsOf } from './kept.ts';
import { readsOf } from './local-module-reads.ts';
import { constantValue } from './numbers.ts';
import { parameterValue } from './parameter-values.ts';
import {
  type Context,
  type Frame,
  type Origin,
  type PresenceCache,
  type PresenceMode,
  sourcePath,
  sourceValue,
} from './proxy-values.ts';
import { freeReads, hoistedIn } from './scope.ts';
import { writtenBy } from './written.ts';

/** Bound parameter metadata for a reference inside an active call frame. */
export interface ParameterFrame {
  readonly frame: Frame;
  readonly index: number;
  readonly parameter: ParameterDeclaration;
}

interface PresenceSlots {
  readonly active: Map<Expression, number>;
  readonly permanent: Map<Expression, boolean>;
  readonly provisional: Map<Expression, number>;
}

interface PresenceOutcome {
  readonly depth: number;
  readonly lowlink: number;
  readonly result: boolean;
  readonly value: Expression;
}

/** Built-in calls whose completion value is never `undefined`. */
const DEFINED_CALLS: ReadonlySet<string> = new Set([
  'Boolean',
  'Number',
  'Proxy.revocable',
  'String',
  'Symbol',
]);

/** The nearest active source invocation whose lexical formal this identifier reads. */
export function parameterFrame(
  name: Identifier,
  frames: readonly Frame[],
): ParameterFrame | undefined {
  for (const frame of frames.toReversed()) {
    const parameters = parametersOf(frame.fn);
    const index = parameters.findIndex(
      (parameter) => isIdentifier(parameter.name) && readsOf(parameter.name, frame.fn)(name),
    );
    const parameter = parameters[index];
    if (parameter !== undefined) {
      return { frame, index, parameter };
    }
  }
  return undefined;
}

/** A possibly reassigned or mutated rest parameter no longer preserves its incoming tuple arity. */
export function bindingChanged(fn: Answering, declared: Identifier, members = false): boolean {
  const isRead = readsOf(declared, fn);
  const visit = (node: Node): boolean => {
    if (members && handedParameter(node, isRead)) {
      return true;
    }
    const target = !members && isCallExpression(node) ? undefined : writtenBy(node);
    if (
      target !== undefined &&
      targetsOf(target).some((each) => {
        const name = members ? rootOf(each) : each;
        return name !== undefined && isIdentifier(name) && isRead(name);
      })
    ) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return fn.body !== undefined && visit(fn.body);
}

/** A handed rest array can have its entries replaced before its selected value is returned. */
function handedParameter(node: Node, isRead: (name: Identifier) => boolean): boolean {
  let given: readonly Expression[] = [];
  if (isCallExpression(node) || isNewExpression(node)) {
    given = node.arguments ?? [];
  } else if (isTaggedTemplateExpression(node)) {
    given = [node.template];
  }
  return given.some(
    (each) => !isSpreadElement(each) && [...freeReads(each)].some((name) => isRead(name)),
  );
}

/** Classifies whether an argument origin is guaranteed `undefined`, defined, or possibly either. */
export function argumentPresence(given: Origin): 'defined' | 'possible' | 'undefined' {
  if (given.keys.length > 0) {
    return 'possible';
  }
  if (guaranteedUndefined(given)) {
    return 'undefined';
  }
  return guaranteedDefined(given.value, given.context, true) ? 'defined' : 'possible';
}

/** Resolves `node` unless it names an active parameter binding in `context.frames`. */
function resolvePresenceTarget(node: Expression, context: Context): Expression {
  const direct = unwrapped(node);
  return isIdentifier(direct) && parameterFrame(direct, context.frames) !== undefined
    ? direct
    : sourceValue(direct, context);
}

/** Checks whether `given` evaluates to `undefined` on every path across active parameter frames. */
function guaranteedUndefined(given: Origin): boolean {
  if (given.keys.length > 0) {
    return false;
  }
  const value = resolvePresenceTarget(given.value, given.context);
  return evaluateCachedPresence(given.context, 'undefined', value, () => {
    if (isVoidExpression(value) || globalOf(value) === 'undefined') {
      return true;
    }
    return isIdentifier(value) && parameterUndefined(value, given.context);
  });
}

/** Checks whether a parameter reference `name` evaluates to `undefined` on every path. */
function parameterUndefined(name: Identifier, context: Context): boolean {
  const binding = parameterFrame(name, context.frames);
  if (binding === undefined || !isIdentifier(binding.parameter.name)) {
    return false;
  }
  const { frame, index, parameter } = binding;
  const scoped = frameContextOf(context, frame);
  const replaced = parameterValue(frame.fn, parameter.name, name);
  if (replaced !== undefined) {
    return guaranteedUndefined({
      context: scoped,
      keys: [],
      seen: new Set(),
      value: replaced.value,
    });
  }
  if (
    parameter.dotDotDotToken !== undefined ||
    parameterReassigned(frame.fn, parameter.name) ||
    frame.given === undefined
  ) {
    return false;
  }
  const given = frame.given[index];
  if (given === undefined || guaranteedUndefined(given)) {
    return (
      parameter.initializer === undefined ||
      guaranteedUndefined({
        context: scoped,
        keys: [],
        seen: new Set(),
        value: parameter.initializer,
      })
    );
  }
  return false;
}

/** Checks whether `node` never evaluates to `undefined` (or `null` when `!nullable`). */
function guaranteedDefined(node: Expression, context: Context, nullable: boolean): boolean {
  const value = resolvePresenceTarget(node, context);
  const mode: PresenceMode = nullable ? 'defined' : 'non-nullish';
  return evaluateCachedPresence(context, mode, value, () =>
    computeDefined(value, context, nullable),
  );
}

/** Evaluates non-`undefined` (or non-nullish) status for a resolved expression `value`. */
function computeDefined(value: Expression, context: Context, nullable: boolean): boolean {
  if (constantValue(value) !== undefined || nonUndefinedLeaf(value, nullable)) {
    return true;
  }
  if (isIdentifier(value)) {
    return parameterDefined(value, context, nullable);
  }
  if (isConditionalExpression(value)) {
    return (
      guaranteedDefined(value.whenTrue, context, nullable) &&
      guaranteedDefined(value.whenFalse, context, nullable)
    );
  }
  if (isBinaryExpression(value)) {
    return guaranteedDefinedBinary(value, context, nullable);
  }
  return isCallExpression(value) && DEFINED_CALLS.has(sourcePath(value.expression, context) ?? '');
}

/** Checks whether a parameter reference `name` never evaluates to `undefined` (or `null`). */
function parameterDefined(name: Identifier, context: Context, nullable: boolean): boolean {
  const binding = parameterFrame(name, context.frames);
  if (binding === undefined || !isIdentifier(binding.parameter.name)) {
    return false;
  }
  const { frame, parameter } = binding;
  const scoped = frameContextOf(context, frame);
  const replaced = parameterValue(frame.fn, parameter.name, name);
  if (replaced !== undefined) {
    return guaranteedDefined(replaced.value, scoped, nullable);
  }
  if (parameterReassigned(frame.fn, parameter.name)) {
    return false;
  }
  if (parameter.dotDotDotToken !== undefined) {
    return true;
  }
  return incomingParameterDefined(binding, scoped, nullable);
}

/** Checks whether an unchanged parameter's incoming argument and default are guaranteed defined. */
function incomingParameterDefined(
  binding: ParameterFrame,
  scoped: Context,
  nullable: boolean,
): boolean {
  const { frame, index, parameter } = binding;
  const { initializer } = parameter;
  if (frame.given === undefined) {
    return (
      nullable && initializer !== undefined && guaranteedDefined(initializer, scoped, nullable)
    );
  }
  const given = frame.given[index];
  if (given === undefined || guaranteedUndefined(given)) {
    return initializer !== undefined && guaranteedDefined(initializer, scoped, nullable);
  }
  const givenDefined =
    given.keys.length === 0 && guaranteedDefined(given.value, given.context, nullable);
  if (givenDefined) {
    return true;
  }
  return nullable && initializer !== undefined && guaranteedDefined(initializer, scoped, nullable);
}

/** Whether `fn` writes to `declared` or declares an initialized or loop-head `var` of its name. */
function parameterReassigned(fn: Answering, declared: Identifier): boolean {
  if (bindingChanged(fn, declared)) {
    return true;
  }
  const declarations = fn.body === undefined ? [] : hoistedIn([fn.body]);
  return declarations.some(
    (each) =>
      isIdentifier(each.name) &&
      each.name.text === declared.text &&
      (each.initializer !== undefined ||
        isForInStatement(each.parent.parent) ||
        isForOfStatement(each.parent.parent)),
  );
}

/** Trims `context.frames` to `frame` and its enclosing callers when evaluating `frame`'s code. */
function frameContextOf(context: Context, frame: Frame): Context {
  const index = context.frames.lastIndexOf(frame);
  return index === -1 || index === context.frames.length - 1
    ? context
    : { ...context, frames: context.frames.slice(0, index + 1) };
}

/** Checks binary operators whose result is guaranteed non-`undefined`. */
function guaranteedDefinedBinary(
  value: BinaryExpression,
  context: Context,
  nullable: boolean,
): boolean {
  const kind = value.operatorToken.kind;
  if (kind === SyntaxKind.CommaToken || kind === SyntaxKind.BarBarToken) {
    return guaranteedDefined(value.right, context, nullable);
  }
  if (kind === SyntaxKind.QuestionQuestionToken) {
    return (
      guaranteedDefined(value.left, context, false) ||
      guaranteedDefined(value.right, context, nullable)
    );
  }
  return (
    kind === SyntaxKind.AmpersandAmpersandToken &&
    guaranteedDefined(value.left, context, nullable) &&
    guaranteedDefined(value.right, context, nullable)
  );
}

/** Checks literal, unary, and constructed expressions that never evaluate to `undefined`. */
function nonUndefinedLeaf(value: Expression, nullable: boolean): boolean {
  return (
    (nullable && value.kind === SyntaxKind.NullKeyword) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    isBigIntLiteral(value) ||
    isTemplateExpression(value) ||
    isRegularExpressionLiteral(value) ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isNewExpression(value) ||
    isTypeOfExpression(value) ||
    isPrefixUnaryExpression(value) ||
    isPostfixUnaryExpression(value)
  );
}

/** Evaluates `compute` once per `(frame, mode, value)` state while tracking Tarjan back-edges. */
function evaluateCachedPresence(
  context: Context,
  mode: PresenceMode,
  value: Expression,
  compute: () => boolean,
): boolean {
  const { presence } = context;
  const frame = context.frames.at(-1);
  const permanent = slotMap(presence.permanent, frame, mode);
  const cached = permanent.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const active = slotMap(presence.active, frame, mode);
  const activeDepth = active.get(value);
  if (activeDepth !== undefined) {
    notePresenceCycle(presence, activeDepth);
    return false;
  }
  const provisional = slotMap(presence.provisional, frame, mode);
  const provisionalDepth = provisional.get(value);
  if (provisionalDepth !== undefined) {
    notePresenceCycle(presence, Math.min(provisionalDepth, presence.lowlinks.length));
    return false;
  }
  return runPresenceFrame(presence, { active, permanent, provisional }, value, compute);
}

/** Opens a Tarjan frame for `value`, executes `compute`, and records the completed result. */
function runPresenceFrame(
  presence: PresenceCache,
  slots: PresenceSlots,
  value: Expression,
  compute: () => boolean,
): boolean {
  const depth = presence.lowlinks.length + 1;
  presence.lowlinks.push(depth);
  slots.active.set(value, depth);
  const result = compute();
  slots.active.delete(value);
  const lowlink = presence.lowlinks.pop() ?? depth;
  if (lowlink < depth) {
    notePresenceCycle(presence, lowlink);
  }
  recordPresenceResult(presence, slots, { depth, lowlink, result, value });
  return result;
}

/** Stores permanent `true` or closed `false` results, and provisional `false` inside open cycles. */
function recordPresenceResult(
  presence: PresenceCache,
  slots: PresenceSlots,
  outcome: PresenceOutcome,
): void {
  const { depth, lowlink, result, value } = outcome;
  if (result) {
    slots.permanent.set(value, true);
    if (presence.provisional.size > 0) {
      presence.provisional.clear();
    }
    return;
  }
  if (lowlink === depth) {
    slots.permanent.set(value, false);
    if (presence.lowlinks.length === 0 && presence.provisional.size > 0) {
      presence.provisional.clear();
    }
    return;
  }
  slots.provisional.set(value, lowlink);
}

/** Propagates an active cycle back-edge depth to the current top Tarjan frame. */
function notePresenceCycle(presence: PresenceCache, targetDepth: number): void {
  const index = presence.lowlinks.length - 1;
  const current = presence.lowlinks[index];
  if (current !== undefined && targetDepth < current) {
    presence.lowlinks[index] = targetDepth;
  }
}

/** Looks up or creates the `Expression` map for `(frame, mode)` in `table`. */
function slotMap<T>(
  table: Map<Frame | undefined, Map<PresenceMode, Map<Expression, T>>>,
  frame: Frame | undefined,
  mode: PresenceMode,
): Map<Expression, T> {
  let byMode = table.get(frame);
  if (byMode === undefined) {
    byMode = new Map();
    table.set(frame, byMode);
  }
  let byExpression = byMode.get(mode);
  if (byExpression === undefined) {
    byExpression = new Map();
    byMode.set(mode, byExpression);
  }
  return byExpression;
}
