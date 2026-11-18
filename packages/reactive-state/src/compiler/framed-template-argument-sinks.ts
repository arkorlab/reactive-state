import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  isDirectMutatingMethod,
  knownMutatedTargetArguments,
} from './framed-template-argument-builtins.ts';
import { resolveCallbackTargets, resolveCallTargets } from './framed-template-argument-callees.ts';
import {
  type TargetCallable,
  type TargetResolution,
  thisKeyOfNode,
} from './framed-template-argument-classes.ts';
import {
  immutablePrimitiveConst,
  isPrimitiveExpression,
  propertyWriteMayInvokeSetter,
  type TaintKey,
} from './framed-template-argument-receivers.ts';
import {
  isAssignmentOperator,
  queueBranchExpressions,
  type SpreadUnfold,
  unfoldCallArguments,
} from './framed-template-argument-spreads.ts';
import { peeled } from './framed-written-targets.ts';

export { constantDeclaration } from './framed-template-argument-spreads.ts';

/**
 * Value, per-slot parameter, receiver-link, and container-mutation sink extraction for
 * `arguments` taint analysis across resolved local callables, constructors, and built-ins.
 */

export interface UnfoldedArgumentTask {
  readonly node: Expression;
  readonly value: readonly TaintKey[];
}

export interface NodeSinks {
  readonly externalBodies: readonly Node[];
  readonly mutated: readonly TaintKey[];
  readonly receiverLinks: readonly (readonly [TaintKey, TaintKey])[];
  readonly returnedFrom: readonly TaintKey[];
  readonly scopedValue: ReadonlyMap<Node, readonly TaintKey[]>;
  readonly unfoldedTasks: readonly UnfoldedArgumentTask[];
  readonly unresolvable: boolean;
  readonly value: readonly TaintKey[];
}

const NO_SINKS: NodeSinks = {
  externalBodies: [],
  mutated: [],
  receiverLinks: [],
  returnedFrom: [],
  scopedValue: new Map(),
  unfoldedTasks: [],
  unresolvable: false,
  value: [],
};

/** Extracts value and container-mutation sinks introduced at `node` within `owner`. */
export function sinksForNode(node: Node, owner: Node): NodeSinks {
  if (isVariableDeclaration(node) || isParameterDeclaration(node)) {
    return { ...NO_SINKS, value: [node] };
  }
  if (
    node.pos > owner.pos &&
    node.end <= owner.end &&
    (isFunctionDeclaration(node) || isClassDeclaration(node))
  ) {
    return { ...NO_SINKS, value: [node] };
  }
  if (isArrowFunction(node) && !isBlock(node.body)) {
    return { ...NO_SINKS, scopedValue: new Map([[node.body, [node]]]) };
  }
  if (isReturnStatement(node) && node.expression !== undefined) {
    const fn = enclosingAnswering(node);
    return fn === undefined ? NO_SINKS : { ...NO_SINKS, value: [fn] };
  }
  if (isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return assignmentTargetSinks(node.left);
  }
  if (isForOfStatement(node) || isForInStatement(node)) {
    return loopTargetSinks(node.initializer);
  }
  if (isCallExpression(node) || isNewExpression(node)) {
    return callTargetSinks(node, owner);
  }
  return NO_SINKS;
}

function enclosingAnswering(node: Node): Answering | undefined {
  for (let at: Node = node.parent; !isSourceFile(at); at = at.parent) {
    if (isAnswering(at)) return at;
    if (
      isConstructorDeclaration(at) ||
      isSetAccessorDeclaration(at) ||
      isPropertyDeclaration(at) ||
      isClassStaticBlockDeclaration(at)
    ) {
      return undefined;
    }
  }
  return undefined;
}

function loopTargetSinks(initializer: Node): NodeSinks {
  if (isVariableDeclarationList(initializer)) {
    return { ...NO_SINKS, value: initializer.declarations };
  }
  return assignmentTargetSinks(initializer);
}

function assignmentTargetSinks(lhs: Node): NodeSinks {
  const mutated: TaintKey[] = [];
  const value: TaintKey[] = [];
  let unresolvable = false;
  const pending: Node[] = [lhs];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const target = isExpression(current) ? peeled(current) : current;
    if (isIdentifier(target)) {
      const decl = frameDeclarationOf(target);
      if (decl === undefined) unresolvable = true;
      else value.push(decl);
      continue;
    }
    if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      if (
        !collectReceiverHolders(target.expression, mutated) ||
        propertyWriteMayInvokeSetter(target)
      ) {
        unresolvable = true;
      }
      continue;
    }
    queueAssignmentPatternChildren(target, pending);
  }
  return { ...NO_SINKS, mutated, unresolvable, value };
}

function queueAssignmentPatternChildren(target: Node, pending: Node[]): void {
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
    pending.push(target.left);
  } else if (isSpreadElement(target) || isSpreadAssignment(target)) {
    pending.push(target.expression);
  } else if (isPropertyAssignment(target)) {
    pending.push(target.initializer);
  } else if (isShorthandPropertyAssignment(target)) {
    pending.push(target.name);
  } else if (isArrayLiteralExpression(target)) {
    for (const element of target.elements) pending.push(element);
  } else if (isObjectLiteralExpression(target)) {
    for (const prop of target.properties) pending.push(prop);
  }
}

interface CallSinkAccumulator {
  readonly call: CallExpression | NewExpression;
  readonly externalBodies: Node[];
  readonly externalTasks: Map<Expression, Set<TaintKey>>;
  readonly mutated: TaintKey[];
  readonly owner: Node;
  readonly receiverLinks: [TaintKey, TaintKey][];
  readonly returnedFrom: TaintKey[];
  readonly scopedValue: Map<Node, Set<TaintKey>>;
  unresolvable: boolean;
  readonly value: TaintKey[];
}

function callTargetSinks(call: CallExpression | NewExpression, owner: Node): NodeSinks {
  const callee = peeled(call.expression);
  const argsUnfold = unfoldCallArguments(call.arguments, owner);
  const resolution = resolveCallTargets(call, argsUnfold, owner);
  const acc: CallSinkAccumulator = {
    call,
    externalBodies: [],
    externalTasks: new Map(),
    mutated: [],
    owner,
    receiverLinks: [],
    returnedFrom: [],
    scopedValue: new Map(),
    unresolvable: resolution.unresolvable || !argsUnfold.resolved,
    value: [],
  };
  for (const mutatedTarget of knownMutatedTargetArguments(call, callee, argsUnfold.slots)) {
    if (!collectReceiverHolders(mutatedTarget, acc.mutated)) acc.unresolvable = true;
  }
  if (resolution.targets.length === 0) {
    populateBuiltInCallSinks(callee, argsUnfold, resolution, acc);
  } else {
    populateResolvedTargetSinks(argsUnfold, resolution, acc);
  }
  return finalizeCallSinks(acc);
}

function finalizeCallSinks(acc: CallSinkAccumulator): NodeSinks {
  const scopedValue = new Map<Node, readonly TaintKey[]>();
  for (const [node, set] of acc.scopedValue) scopedValue.set(node, [...set]);
  const unfoldedTasks: UnfoldedArgumentTask[] = [];
  for (const [node, set] of acc.externalTasks) unfoldedTasks.push({ node, value: [...set] });
  return {
    externalBodies: acc.externalBodies,
    mutated: acc.mutated,
    receiverLinks: acc.receiverLinks,
    returnedFrom: acc.returnedFrom,
    scopedValue,
    unfoldedTasks,
    unresolvable: acc.unresolvable,
    value: acc.value,
  };
}

function populateBuiltInCallSinks(
  callee: Expression,
  argsUnfold: SpreadUnfold,
  resolution: TargetResolution,
  acc: CallSinkAccumulator,
): void {
  if (
    !resolution.unresolvable &&
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
    isDirectMutatingMethod(callee) &&
    !collectReceiverHolders(callee.expression, acc.mutated)
  ) {
    acc.unresolvable = true;
  }
  collectCallbackSinksFromItems(argsUnfold.elements, acc);
  if (resolution.effectiveSlots !== undefined) {
    for (const exprs of resolution.effectiveSlots.values()) {
      collectCallbackSinksFromItems(exprs, acc);
    }
  }
}

function collectCallbackSinksFromItems(
  items: readonly Expression[],
  acc: CallSinkAccumulator,
): void {
  const pending: Expression[] = [...items];
  const visited = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = peeled(next);
    if (visited.has(current)) continue;
    visited.add(current);
    stepBuiltInArgumentSink(current, pending, acc);
  }
}

function stepBuiltInArgumentSink(
  current: Expression,
  pending: Expression[],
  acc: CallSinkAccumulator,
): void {
  if (isAnswering(current)) {
    acc.value.push(...parametersOf(current));
    return;
  }
  if (isIdentifier(current)) {
    recordCallbackTarget(current, acc);
    return;
  }
  if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    recordCallbackTarget(current, acc);
    pending.push(current.expression);
    return;
  }
  if (queueBranchExpressions(current, pending)) return;
  queueLiteralContainerValues(current, pending);
}

function recordCallbackTarget(expr: Expression, acc: CallSinkAccumulator): void {
  const cbRes = resolveCallbackTargets(expr, acc.owner);
  if (cbRes.unresolvable) return;
  for (const target of cbRes.targets) {
    acc.value.push(...target.parameters);
    for (const bodyNode of target.bodyNodes) queueExternalBody(bodyNode, acc);
  }
}

function populateResolvedTargetSinks(
  argsUnfold: SpreadUnfold,
  resolution: TargetResolution,
  acc: CallSinkAccumulator,
): void {
  const slotMap = resolution.effectiveSlots ?? argsUnfold.slots;
  const hasSuppliedArgs = slotMap.size > 0 || !argsUnfold.resolved;
  for (const target of resolution.targets) {
    if (hasSuppliedArgs && target.readsOwnArguments) acc.unresolvable = true;
    for (const bodyNode of target.bodyNodes) queueExternalBody(bodyNode, acc);
    recordTargetReturnKey(target, acc);
  }
  for (const [slotIndex, exprs] of slotMap) {
    const params = collectSlotParameters(resolution.targets, slotIndex);
    if (params.length === 0) continue;
    for (const expr of exprs) attachExpressionSinks(expr, params, acc);
  }
  linkResolvedReceivers(resolution, acc);
}

function queueExternalBody(bodyNode: Node, acc: CallSinkAccumulator): void {
  if (bodyNode.pos < acc.owner.pos || bodyNode.end > acc.owner.end) {
    acc.externalBodies.push(bodyNode);
  }
}

function recordTargetReturnKey(target: TargetCallable, acc: CallSinkAccumulator): void {
  if (isNewExpression(acc.call)) {
    if (target.thisKey !== undefined) acc.returnedFrom.push(target.thisKey);
    return;
  }
  if (target.callableNode !== undefined && isAnswering(target.callableNode)) {
    acc.returnedFrom.push(target.callableNode);
  }
}

function collectSlotParameters(
  targets: readonly TargetCallable[],
  slotIndex: number,
): readonly ParameterDeclaration[] {
  const matched: ParameterDeclaration[] = [];
  for (const target of targets) {
    const param = matchSingleTargetParameter(target, slotIndex);
    if (param !== undefined) matched.push(param);
  }
  return matched;
}

function matchSingleTargetParameter(
  target: TargetCallable,
  callSlot: number,
): ParameterDeclaration | undefined {
  if (callSlot < target.callSlotSkip) return undefined;
  const paramIndex = callSlot - target.callSlotSkip + target.paramOffset;
  const { parameters } = target;
  if (paramIndex < parameters.length) return parameters[paramIndex];
  const last = parameters.at(-1);
  return last?.dotDotDotToken === undefined ? undefined : last;
}

function attachExpressionSinks(
  expr: Expression,
  keys: readonly TaintKey[],
  acc: CallSinkAccumulator,
): void {
  if (expr.pos >= acc.call.pos && expr.end <= acc.call.end) {
    addSinkSetEntries(acc.scopedValue, expr, keys);
  } else {
    addSinkSetEntries(acc.externalTasks, expr, keys);
  }
}

function addSinkSetEntries<K>(
  table: Map<K, Set<TaintKey>>,
  mapKey: K,
  values: readonly TaintKey[],
): void {
  let set = table.get(mapKey);
  if (set === undefined) {
    set = new Set();
    table.set(mapKey, set);
  }
  for (const val of values) set.add(val);
}

function linkResolvedReceivers(resolution: TargetResolution, acc: CallSinkAccumulator): void {
  const thisKeys = collectActiveThisKeys(resolution.targets);
  if (thisKeys.length === 0 || resolution.receiverExprs.length === 0) return;
  for (const recvExpr of resolution.receiverExprs) {
    attachExpressionSinks(recvExpr, thisKeys, acc);
    const holders: TaintKey[] = [];
    if (!collectReceiverHolders(recvExpr, holders)) acc.unresolvable = true;
    emitHolderReceiverLinks(thisKeys, holders, acc.receiverLinks);
  }
}

function collectActiveThisKeys(targets: readonly TargetCallable[]): readonly TaintKey[] {
  const thisKeys: TaintKey[] = [];
  for (const target of targets) {
    if (target.mentionsThis && target.thisKey !== undefined) thisKeys.push(target.thisKey);
  }
  return thisKeys;
}

function emitHolderReceiverLinks(
  thisKeys: readonly TaintKey[],
  holders: readonly TaintKey[],
  links: [TaintKey, TaintKey][],
): void {
  for (const thisKey of thisKeys) {
    for (const holder of holders) {
      if (thisKey !== holder) links.push([thisKey, holder]);
    }
  }
}

function queueLiteralContainerValues(current: Expression, pending: Expression[]): void {
  if (isArrayLiteralExpression(current)) {
    queueArrayElements(current.elements, pending);
    return;
  }
  if (!isObjectLiteralExpression(current)) return;
  for (const prop of current.properties) queueObjectPropertyValue(prop, pending);
}

function queueArrayElements(elements: readonly Expression[], pending: Expression[]): void {
  for (const el of elements) {
    if (!isOmittedExpression(el)) pending.push(isSpreadElement(el) ? el.expression : el);
  }
}

function queueObjectPropertyValue(prop: ObjectLiteralElementLike, pending: Expression[]): void {
  if (isPropertyAssignment(prop)) pending.push(prop.initializer);
  else if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) pending.push(prop.name);
  else if (isSpreadAssignment(prop)) pending.push(prop.expression);
}

function collectReceiverHolders(expr: Expression, mutated: TaintKey[]): boolean {
  const pending: Expression[] = [expr];
  const visited = new Set<Expression>();
  let exhaustive = true;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = peeled(next);
    if (visited.has(current)) continue;
    visited.add(current);
    if (!stepReceiverHolder(current, pending, mutated)) exhaustive = false;
  }
  return exhaustive;
}

function stepReceiverHolder(
  current: Expression,
  pending: Expression[],
  mutated: TaintKey[],
): boolean {
  if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    pending.push(current.expression);
    return true;
  }
  if (isPrimitiveExpression(current)) return true;
  if (current.kind === SyntaxKind.ThisKeyword || current.kind === SyntaxKind.SuperKeyword) {
    const key = thisKeyOfNode(current);
    if (key === undefined) return false;
    mutated.push(key);
    return true;
  }
  if (isIdentifier(current)) return recordReceiverIdentifier(current, mutated);
  if (queueBranchExpressions(current, pending)) return true;
  if (isArrayLiteralExpression(current)) {
    queueArrayElements(current.elements, pending);
    return true;
  }
  if (isObjectLiteralExpression(current)) {
    return queueObjectReceiverProperties(current.properties, pending);
  }
  return false;
}

function recordReceiverIdentifier(id: Identifier, mutated: TaintKey[]): boolean {
  const decl = frameDeclarationOf(id);
  if (decl === undefined) return false;
  if (!immutablePrimitiveConst(decl)) mutated.push(decl);
  return true;
}

function queueObjectReceiverProperties(
  properties: readonly ObjectLiteralElementLike[],
  pending: Expression[],
): boolean {
  let plain = true;
  for (const prop of properties) {
    if (isPropertyAssignment(prop)) {
      pending.push(prop.initializer);
    } else if (isShorthandPropertyAssignment(prop)) {
      if (isIdentifier(prop.name)) pending.push(prop.name);
      if (prop.objectAssignmentInitializer !== undefined) {
        pending.push(prop.objectAssignmentInitializer);
      }
    } else if (isSpreadAssignment(prop)) {
      pending.push(prop.expression);
    } else {
      plain = false;
    }
  }
  return plain;
}
