import {
  type BinaryExpression,
  type Expression,
  type Identifier,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBinaryExpression,
  isClassExpression,
  isDeleteExpression,
  isFunctionExpression,
  isNewExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isRegularExpressionLiteral,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import {
  framedHeldVariable,
  framedMemberDeletes,
  framedMemberWrites,
  framedPrototypeWrites,
} from './framed-member-writes.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import {
  hasNarrowingTypeAnnotation,
  isUnrepeatedSelfWrite,
  type ProjectionCallbacks,
} from './multipart-held-bindings.ts';
import { inspectHeldPath, peeledMemberHolder } from './multipart-held-paths.ts';
import { constantValue } from './numbers.ts';

/** Dynamic computed-key destructuring container unfolding across aliases, spreads, and writes. */

interface DynamicScanContext {
  readonly callbacks: ProjectionCallbacks;
  readonly pending: Expression[];
  readonly values: Held[];
  readonly writeNode: Node;
}

const OBJECT_ASSIGN = 'Object.assign';

/** Collects candidate property values across dynamic-key object sources, noting any opaque container. */
export function resolveDynamicObjectSources(
  sources: readonly Held[],
  writeNode: Node,
  callbacks: ProjectionCallbacks,
): { readonly opaque: boolean; readonly values: readonly Held[] } {
  const context: DynamicScanContext = {
    callbacks,
    pending: [],
    values: [],
    writeNode,
  };
  let opaque = pushHeldContainers(sources, context);
  const visited = new Set<Expression>();
  for (let raw = context.pending.pop(); raw !== undefined; raw = context.pending.pop()) {
    const container = unwrapped(raw);
    if (visited.has(container)) {
      continue;
    }
    visited.add(container);
    if (inspectDynamicContainer(container, context)) {
      opaque = true;
    }
  }
  return { opaque, values: context.values };
}

/** Resolves a static property key name on an object literal or assignment pattern property. */
export function staticPropertyName(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  if (isComputedPropertyName(name)) {
    const constant = constantValue(name.expression);
    return typeof constant === 'string' || typeof constant === 'number'
      ? String(constant)
      : undefined;
  }
  return undefined;
}

/** Unfolds `Held` entries into container expressions, returning `true` if any path was unclosed. */
function pushHeldContainers(entries: readonly Held[], context: DynamicScanContext): boolean {
  let opaque = false;
  for (const entry of entries) {
    if (entry.keys.length === 0) {
      context.pending.push(entry.value);
      continue;
    }
    const resolved = inspectHeldPath(entry, context.writeNode, context.callbacks);
    if (!resolved.closed || resolved.ambiguous || resolved.typedFormData) {
      opaque = true;
    }
    context.pending.push(...resolved.expressions);
  }
  return opaque;
}

/** Inspects one unwrapped container expression for dynamic property reads, returning `true` if opaque. */
function inspectDynamicContainer(container: Expression, context: DynamicScanContext): boolean {
  const alternatives = context.callbacks.selectValues(container);
  if (alternatives !== undefined) {
    context.pending.push(...alternatives);
    return false;
  }
  if (isPropertyAccessExpression(container) || isElementAccessExpression(container)) {
    const peeled = peeledMemberHolder(container);
    return peeled === undefined || pushHeldContainers([peeled], context);
  }
  if (isObjectLiteralExpression(container)) {
    return inspectObjectLiteralContainer(container, context);
  }
  if (
    isCallExpression(container) &&
    globalPathOf(unwrapped(container.expression))?.join('.') === OBJECT_ASSIGN
  ) {
    return inspectObjectAssignContainer(container.arguments, context.pending);
  }
  if (isIdentifier(container)) {
    return inspectIdentifierContainer(container, context);
  }
  return true;
}

/** Collects property values, spreads, prototypes, and getter flags on an `ObjectLiteralExpression`. */
function inspectObjectLiteralContainer(
  object: ObjectLiteralExpression,
  context: DynamicScanContext,
): boolean {
  let opaque = false;
  for (const property of object.properties) {
    if (isPropertyAssignment(property)) {
      if (staticPropertyName(property.name) === '__proto__') {
        context.pending.push(property.initializer);
      } else {
        context.values.push({ keys: [], value: property.initializer });
      }
    } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      context.values.push({ keys: [], value: property.name });
    } else if (isSpreadAssignment(property)) {
      context.pending.push(property.expression);
    } else if (isGetAccessorDeclaration(property)) {
      opaque = true;
    }
  }
  return opaque;
}

/** Pushes `Object.assign(...)` arguments onto `pending`, flagging spread argument lists as opaque. */
function inspectObjectAssignContainer(args: readonly Expression[], pending: Expression[]): boolean {
  if (args.length === 0) {
    return true;
  }
  let opaque = false;
  for (const arg of args) {
    if (isSpreadElement(arg)) {
      opaque = true;
    } else {
      pending.push(arg);
    }
  }
  return opaque;
}

/** Resolves a variable or parameter identifier acting as a dynamic-key destructuring container. */
function inspectIdentifierContainer(id: Identifier, context: DynamicScanContext): boolean {
  const selected = frameBindingOf(id);
  if (selected === undefined) {
    return true;
  }
  if (selected.keys.length > 0) {
    context.pending.push(...context.callbacks.bindingDefaults(id, selected.binding.name));
  }
  if (isVariableDeclaration(selected.binding)) {
    return inspectVariableContainer(id, selected.binding, selected.keys.length === 0, context);
  }
  if (!isParameterDeclaration(selected.binding)) {
    return true;
  }
  const resolved = context.callbacks.readParameter(id, selected.binding);
  const sourcesOpaque = pushHeldContainers(resolved.sources, context);
  return (
    !resolved.replaced ||
    resolved.ambiguous === true ||
    resolved.dynamicOpaque === true ||
    sourcesOpaque
  );
}

/** Collects held values, pattern reassignments, and member writes on a `VariableDeclaration` container. */
function inspectVariableContainer(
  id: Identifier,
  declaration: VariableDeclaration,
  directBinding: boolean,
  context: DynamicScanContext,
): boolean {
  const held = framedHeldValues(id, [], context.writeNode);
  if (held === undefined) {
    return true;
  }
  const patternScan = context.callbacks.readVariablePattern(id, declaration, context.writeNode);
  const entries = [
    ...(held.initial === undefined ? [] : [held.initial]),
    ...held.held,
    ...patternScan.extraSources,
  ];
  let opaque =
    patternScan.dynamicOpaque || entries.length === 0 || pushHeldContainers(entries, context);
  if (!directBinding) {
    return opaque;
  }
  const holder = framedHeldVariable(declaration);
  const file = id.getSourceFile();
  for (const write of framedMemberWrites(file)) {
    if (
      write.holder === holder &&
      write.path.length === 1 &&
      reachesContainerPoint(write.node, id, declaration, context.writeNode)
    ) {
      context.values.push({ keys: [], value: write.value });
    }
  }
  for (const proto of framedPrototypeWrites(file)) {
    if (
      proto.holder === holder &&
      proto.path.length === 0 &&
      reachesContainerPoint(proto.node, id, declaration, context.writeNode)
    ) {
      context.pending.push(proto.value);
    }
  }
  const handedOff = framedMemberDeletes(file).some((each) => {
    return (
      each.holder === holder &&
      each.handed &&
      each.path.length === 0 &&
      reachesContainerPoint(each.node, id, declaration, context.writeNode)
    );
  });
  if (handedOff) {
    opaque = true;
  }
  return opaque;
}

/** Whether a mutation on `declaration` may execute before `point`. */
function reachesContainerPoint(
  change: Node,
  id: Identifier,
  declaration: VariableDeclaration,
  point: Node,
): boolean {
  if (!framedPossibleBranch(change)) {
    return false;
  }
  const owner = executionOwner(point);
  if (
    executionOwner(change) !== owner ||
    change.pos < point.pos ||
    destructuredFirst(change, point)
  ) {
    return true;
  }
  return repeatedFrameRead(change, id, declaration, owner);
}

const ASSIGNMENT_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);
const HANDING_CONSTRUCTORS: ReadonlySet<string> = new Set(['FormData', 'Object', 'Proxy']);

/** Whether `leaf` is an opaque expression whose concrete runtime value is not proven non-`FormData`. */
export function leafMayBeOpaqueFormData(
  leaf: Expression,
  point: Node,
  callbacks: ProjectionCallbacks,
): boolean {
  return checkOpaqueLeaf(leaf, point, callbacks, new Set());
}

/** Recursive opaque-leaf check guarded by `(value.pos, point.pos)` against binding cycles. */
function checkOpaqueLeaf(
  leaf: Expression,
  point: Node,
  callbacks: ProjectionCallbacks,
  seen: Set<string>,
): boolean {
  if (callbacks.isAssertedFormData(leaf, [])) {
    return true;
  }
  const value = unwrapped(leaf);
  const visitKey = `${String(value.pos)}:${String(point.pos)}`;
  if (seen.has(visitKey)) {
    return true;
  }
  seen.add(visitKey);
  const alternatives = callbacks.selectValues(value);
  if (alternatives !== undefined) {
    return alternatives.some((each) => checkOpaqueLeaf(each, point, callbacks, seen));
  }
  if (isClosedNonFormDataSyntax(value)) {
    return false;
  }
  if (isBinaryExpression(value)) {
    return inspectBinaryLeaf(value, point, callbacks, seen);
  }
  if (isNewExpression(value)) {
    const ctor = globalPathOf(unwrapped(value.expression))?.join('.');
    return ctor === undefined || HANDING_CONSTRUCTORS.has(ctor);
  }
  if (isIdentifier(value)) {
    return inspectIdentifierLeaf(value, point, callbacks, seen);
  }
  const peeled = peeledMemberHolder(value);
  return peeled === undefined || inspectMemberLeaf(peeled, point, callbacks, seen);
}

/** Whether `value` is literal, container, callable, or unary syntax that never evaluates to `FormData`. */
function isClosedNonFormDataSyntax(value: Expression): boolean {
  if (
    isStringLiteral(value) ||
    isNumericLiteral(value) ||
    isBigIntLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isTemplateExpression(value) ||
    isRegularExpressionLiteral(value)
  ) {
    return true;
  }
  if (
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword
  ) {
    return true;
  }
  return (
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isPrefixUnaryExpression(value) ||
    isPostfixUnaryExpression(value) ||
    isTypeOfExpression(value) ||
    isVoidExpression(value) ||
    isDeleteExpression(value)
  );
}

/** Evaluates binary expressions, recursing into assignment operands and treating arithmetic/comparisons as non-`FormData`. */
function inspectBinaryLeaf(
  value: BinaryExpression,
  point: Node,
  callbacks: ProjectionCallbacks,
  seen: Set<string>,
): boolean {
  if (!ASSIGNMENT_OPERATORS.has(value.operatorToken.kind)) {
    return false;
  }
  if (value.operatorToken.kind === SyntaxKind.EqualsToken) {
    return checkOpaqueLeaf(value.right, point, callbacks, seen);
  }
  return (
    checkOpaqueLeaf(value.left, point, callbacks, seen) ||
    checkOpaqueLeaf(value.right, point, callbacks, seen)
  );
}

/** Evaluates an identifier leaf across bound variables, parameters, and `undefined`. */
function inspectIdentifierLeaf(
  id: Identifier,
  point: Node,
  callbacks: ProjectionCallbacks,
  seen: Set<string>,
): boolean {
  if (id.text === 'undefined' && frameDeclarationOf(id) === undefined) {
    return false;
  }
  const selected = frameBindingOf(id);
  if (selected === undefined) {
    return true;
  }
  if (isVariableDeclaration(selected.binding)) {
    return inspectVariableLeaf(id, selected.binding, point, { callbacks, seen });
  }
  return (
    !isParameterDeclaration(selected.binding) ||
    inspectParameterLeaf(id, selected.binding, point, { callbacks, seen })
  );
}

/** Checks whether a `VariableDeclaration` leaf may resolve to an opaque value at `point`. */
function inspectVariableLeaf(
  id: Identifier,
  declaration: VariableDeclaration,
  point: Node,
  state: { readonly callbacks: ProjectionCallbacks; readonly seen: Set<string> },
): boolean {
  const { callbacks, seen } = state;
  if (declaration.type?.kind === SyntaxKind.StringKeyword) {
    return false;
  }
  const held = framedHeldValues(id, [], point);
  if (held === undefined) {
    return true;
  }
  const patternScan = callbacks.readVariablePattern(id, declaration, point);
  if (patternScan.ambiguous || patternScan.dynamicOpaque) {
    return true;
  }
  const defaults = isIdentifier(declaration.name)
    ? []
    : callbacks.bindingDefaults(id, declaration.name);
  if (defaults.some((each) => checkOpaqueLeaf(each, each, callbacks, seen))) {
    return true;
  }
  const liveHeld = held.held.filter(
    (entry) => !isUnrepeatedSelfWrite(entry.value, point, declaration),
  );
  const entries = [
    ...(held.initial === undefined ? [] : [held.initial]),
    ...liveHeld,
    ...patternScan.extraSources,
  ];
  if (entries.length === 0) {
    return declaration.initializer !== undefined;
  }
  return entries.some((entry) => {
    return entry.keys.length === 0
      ? checkOpaqueLeaf(entry.value, entry.value, callbacks, seen)
      : inspectMemberLeaf(entry, point, callbacks, seen);
  });
}

/** Checks whether a `ParameterDeclaration` leaf may resolve to an opaque value at `point`. */
function inspectParameterLeaf(
  id: Identifier,
  parameter: ParameterDeclaration,
  point: Node,
  state: { readonly callbacks: ProjectionCallbacks; readonly seen: Set<string> },
): boolean {
  const { callbacks, seen } = state;
  const resolved = callbacks.readParameter(id, parameter);
  if (resolved.dynamicOpaque === true) {
    return true;
  }
  const sourceOpaque = resolved.sources.some((entry) => {
    return entry.keys.length === 0
      ? checkOpaqueLeaf(entry.value, point, callbacks, seen)
      : inspectMemberLeaf(entry, point, callbacks, seen);
  });
  if (resolved.replaced && resolved.ambiguous !== true) {
    return sourceOpaque;
  }
  return parameter.type?.kind !== SyntaxKind.StringKeyword;
}

/** Checks whether a peeled member path leaf (`obj.prop`) may resolve to an opaque value. */
function inspectMemberLeaf(
  peeled: Held,
  point: Node,
  callbacks: ProjectionCallbacks,
  seen: Set<string>,
): boolean {
  const sub = inspectHeldPath(peeled, point, callbacks);
  if (sub.ambiguous || sub.typedFormData) {
    return true;
  }
  if (!sub.closed) {
    const holder = unwrapped(peeled.value);
    if (!isIdentifier(holder)) {
      return true;
    }
    const selected = frameBindingOf(holder);
    return (
      selected === undefined ||
      !hasNarrowingTypeAnnotation(selected.binding.type) ||
      callbacks.isBindingTypedFormData(holder, peeled.keys)
    );
  }
  return sub.expressions.some((expr) => checkOpaqueLeaf(expr, point, callbacks, seen));
}
