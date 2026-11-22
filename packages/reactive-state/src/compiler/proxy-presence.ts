import {
  type BinaryExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
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
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isRegularExpressionLiteral,
  isSatisfiesExpression,
  isTemplateExpression,
  isTypeAssertion,
  isTypeOfExpression,
  isVariableDeclarationList,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, parametersOf } from './answers.ts';
import { globalOf } from './bounded.ts';
import { targetsOf } from './kept.ts';
import { constantValue } from './numbers.ts';
import { parameterValue } from './parameter-values.ts';
import { bindsHoistedName, cachedParameterReads } from './proxy-parameter-writes.ts';
import {
  type Context,
  type Frame,
  type Origin,
  peeled,
  type PresenceCache,
  type PresenceMode,
  sourcePath,
  sourceValue,
} from './proxy-values.ts';
import { bindingIdentifiers, hoistedIn, isBlockScoped, isTypeOnly } from './scope.ts';
import { writtenBy } from './written.ts';

/** Bound parameter metadata for a reference inside an active call frame. */
export interface ParameterFrame {
  readonly declared: Identifier;
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

/** Memoized parameter-reassignment flags keyed by parameter declaration identifier. */
const PARAMETER_REASSIGNED = new WeakMap<Identifier, boolean>();

/** Memoized identifier names directly targeted by bindings or `var` declarations in a subtree. */
const ANY_TARGET_NAMES = new WeakMap<Node, ReadonlySet<string>>();

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
    for (const [index, parameter] of parametersOf(frame.fn).entries()) {
      const declared = bindingIdentifiers(parameter.name).find(
        (each) => each.text === name.text && cachedParameterReads(each, frame.fn)(name),
      );
      if (declared !== undefined) {
        return { declared, frame, index, parameter };
      }
    }
  }
  return undefined;
}

/** Checks whether `root` contains a non-call write targeting `declared` inside `fn`. */
function subtreeWritesBinding(root: Node, fn: Answering, declared: Identifier): boolean {
  if (!anyTargetNamesIn(root).has(declared.text)) {
    return false;
  }
  const isRead = cachedParameterReads(declared, fn);
  const visit = (node: Node): boolean => {
    const target = isCallExpression(node) ? undefined : writtenBy(node);
    if (
      target !== undefined &&
      targetsOf(target).some((each) => {
        const leaf = unwrappedNode(each);
        return isIdentifier(leaf) && isRead(leaf);
      })
    ) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return visit(root);
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
  const direct = peeled(node);
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
  if (binding === undefined) {
    return false;
  }
  const { declared, frame, index, parameter } = binding;
  const scoped = frameContextOf(context, frame);
  const reassigned = frameReassignsParameter(binding);
  const replaced = reassigned ? parameterValue(frame.fn, declared, name) : undefined;
  if (replaced !== undefined) {
    return guaranteedUndefined({
      context: scoped,
      keys: [],
      seen: new Set(),
      value: replaced.value,
    });
  }
  if (
    reassigned ||
    frame.given === undefined ||
    parameter.dotDotDotToken !== undefined ||
    (frame.openTail === true && index >= frame.given.length) ||
    !isIdentifier(parameter.name)
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
  if (binding === undefined) {
    return false;
  }
  const { declared, frame, parameter } = binding;
  const scoped = frameContextOf(context, frame);
  const reassigned = frameReassignsParameter(binding);
  const replaced = reassigned ? parameterValue(frame.fn, declared, name) : undefined;
  if (replaced !== undefined) {
    return guaranteedDefined(replaced.value, scoped, nullable);
  }
  if (reassigned || !isIdentifier(parameter.name)) {
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
  if (frame.given === undefined || (frame.openTail === true && index >= frame.given.length)) {
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

/** Whether `fn.body` writes to `declared` or declares an initialized or loop-head `var` of it. */
function bodyReassigned(fn: Answering, declared: Identifier): boolean {
  const cached = PARAMETER_REASSIGNED.get(declared);
  if (cached !== undefined) {
    return cached;
  }
  if (fn.body === undefined || !anyTargetNamesIn(fn.body).has(declared.text)) {
    PARAMETER_REASSIGNED.set(declared, false);
    return false;
  }
  const result =
    subtreeWritesBinding(fn.body, fn, declared) ||
    hoistedIn([fn.body]).some((each) => {
      return (
        bindsHoistedName(each.name, declared.text) &&
        (each.initializer !== undefined ||
          isForInStatement(each.parent.parent) ||
          isForOfStatement(each.parent.parent))
      );
    });
  PARAMETER_REASSIGNED.set(declared, result);
  return result;
}

/** Whether `fn` writes to `declared` across parameter defaults, body, or `var` declarations. */
export function parameterReassigned(fn: Answering, declared: Identifier): boolean {
  return (
    bodyReassigned(fn, declared) ||
    parametersOf(fn).some((param) => subtreeWritesBinding(param, fn, declared))
  );
}

/** Checks whether `binding.declared` can be reassigned in `binding.frame`'s reachable code. */
function frameReassignsParameter(binding: ParameterFrame): boolean {
  const { declared, frame } = binding;
  if (bodyReassigned(frame.fn, declared)) {
    return true;
  }
  return parametersOf(frame.fn).some((param, index) => {
    if (subtreeWritesBinding(param.name, frame.fn, declared)) {
      return true;
    }
    if (
      param.initializer === undefined ||
      !subtreeWritesBinding(param.initializer, frame.fn, declared)
    ) {
      return false;
    }
    const arg =
      frame.given !== undefined && index < frame.given.length ? frame.given[index] : undefined;
    return !(arg?.keys.length === 0 && guaranteedDefined(arg.value, arg.context, true));
  });
}

/** Collects and memoizes all identifier texts written or `var`-declared anywhere inside `node`. */
function anyTargetNamesIn(node: Node): ReadonlySet<string> {
  const cached = ANY_TARGET_NAMES.get(node);
  if (cached !== undefined) {
    return cached;
  }
  if (isTypeOnly(node)) {
    const empty = new Set<string>();
    ANY_TARGET_NAMES.set(node, empty);
    return empty;
  }
  const names = new Set<string>();
  addDirectTargetNames(node, names);
  node.forEachChild((child) => {
    for (const text of anyTargetNamesIn(child)) {
      names.add(text);
    }
  });
  ANY_TARGET_NAMES.set(node, names);
  return names;
}

/** Adds all identifier texts bound by `list`'s variable declarations into `out`. */
function addDeclarationListNames(
  list: Node & {
    readonly declarations: readonly { readonly name: Parameters<typeof bindingIdentifiers>[0] }[];
  },
  out: Set<string>,
): void {
  for (const declaration of list.declarations) {
    for (const ident of bindingIdentifiers(declaration.name)) {
      out.add(ident.text);
    }
  }
}

/** Adds identifier names targeted directly at `node` by non-call writes or `var` declarations. */
function addDirectTargetNames(node: Node, out: Set<string>): void {
  if (isVariableDeclarationList(node) && !isBlockScoped(node)) {
    addDeclarationListNames(node, out);
    return;
  }
  const target = isCallExpression(node) ? undefined : writtenBy(node);
  if (target === undefined) {
    return;
  }
  if (isVariableDeclarationList(target)) {
    addDeclarationListNames(target, out);
    return;
  }
  for (const each of targetsOf(target)) {
    const leaf = unwrappedNode(each);
    if (isIdentifier(leaf)) {
      out.add(leaf.text);
    }
  }
}

/** Unwraps parenthesized and type-assertion wrappers around an arbitrary AST `Node`. */
function unwrappedNode(node: Node): Node {
  let current = node;
  while (
    isParenthesizedExpression(current) ||
    isAsExpression(current) ||
    isSatisfiesExpression(current) ||
    isNonNullExpression(current) ||
    isTypeAssertion(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Trims `context.frames` to `frame` and its enclosing callers when evaluating `frame`'s code. */
export function frameContextOf(context: Context, frame: Frame): Context {
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
