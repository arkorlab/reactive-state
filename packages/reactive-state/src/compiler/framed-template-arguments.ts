import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isElementAccessExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, isAnswering, overloadsOf, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/**
 * Own and inherited `arguments` reachability for source-written template tags, including outer
 * bindings tainted by indexed, destructured, spread, iterated, reassigned, or container-mutated
 * `arguments` reads in enclosing non-arrow callables.
 */

const PRIMITIVE_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.TrueKeyword,
]);

const EMPTY_TAINT: ReadonlySet<FrameDeclaration> = new Set();
const OWNER_ARGUMENTS_TAINT = new WeakMap<Node, ReadonlySet<FrameDeclaration>>();

interface TaintGraph {
  readonly dependents: Map<FrameDeclaration, Set<FrameDeclaration>>;
  readonly holders: Map<FrameDeclaration, Set<FrameDeclaration>>;
  readonly mutatedDependents: Map<FrameDeclaration, Set<FrameDeclaration>>;
  readonly mutatedSeed: Set<FrameDeclaration>;
  readonly owner: Node;
  readonly valueSeed: Set<FrameDeclaration>;
}

interface NodeSinks {
  readonly mutated: readonly FrameDeclaration[];
  readonly value: readonly FrameDeclaration[];
}

interface ActiveSinks {
  readonly mutated: Map<FrameDeclaration, number>;
  readonly value: Map<FrameDeclaration, number>;
}

interface TaintStep {
  readonly exit?: NodeSinks;
  readonly node?: Node;
}

interface PropagationState {
  readonly mutated: Set<FrameDeclaration>;
  readonly mutatedQueue: FrameDeclaration[];
  readonly tainted: Set<FrameDeclaration>;
  readonly taintedQueue: FrameDeclaration[];
}

const NO_SINKS: NodeSinks = { mutated: [], value: [] };

/** Whole `const` bindings keep their initializer value throughout their scope. */
export function constantDeclaration(declared: VariableDeclaration): boolean {
  return (
    isIdentifier(declared.name) &&
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/** Own or inherited `arguments` reads (including tainted outer bindings) can expose error values. */
export function mentionsAccessibleArguments(fn: Answering): boolean {
  if (fn.body === undefined) return false;
  const owners = accessibleArgumentsOwners(fn);
  const tainted = collectOwnersTaint(owners);
  const ownParams = new Set<Node>(parametersOf(fn));
  const pending: Node[] = [...parametersOf(fn), fn.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      readsBinding(node) &&
      readsOwnerOrTainted(node, owners, tainted, ownParams)
    ) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

function accessibleArgumentsOwners(fn: Answering): ReadonlySet<Node> {
  const owners = new Set<Node>();
  if (bindsOwnArguments(fn)) owners.add(fn);
  for (
    let owner = enclosingArgumentsCallable(fn);
    owner !== undefined;
    owner = enclosingArgumentsCallable(owner)
  ) {
    owners.add(owner);
  }
  return owners;
}

function collectOwnersTaint(owners: ReadonlySet<Node>): ReadonlySet<FrameDeclaration> {
  if (owners.size === 0) return EMPTY_TAINT;
  const combined = new Set<FrameDeclaration>();
  for (const owner of owners) {
    for (const decl of taintedBindingsOfOwner(owner)) combined.add(decl);
  }
  return combined;
}

function readsOwnerOrTainted(
  node: Identifier,
  owners: ReadonlySet<Node>,
  tainted: ReadonlySet<FrameDeclaration>,
  ownParams: ReadonlySet<Node>,
): boolean {
  if (isAccessibleImplicitArguments(node, owners)) return true;
  if (tainted.size === 0) return false;
  const declared = frameDeclarationOf(node);
  return declared !== undefined && !ownParams.has(declared) && tainted.has(declared);
}

function isAccessibleImplicitArguments(node: Identifier, owners: ReadonlySet<Node>): boolean {
  if (node.text !== 'arguments') return false;
  const declared = frameDeclarationOf(node);
  const owner = enclosingArgumentsCallable(node);
  if (owner === undefined) return declared === undefined;
  if (!owners.has(owner)) return false;
  return declared === undefined || declared.pos < owner.pos || declared.end > owner.end;
}

function taintedBindingsOfOwner(owner: Node): ReadonlySet<FrameDeclaration> {
  const cached = OWNER_ARGUMENTS_TAINT.get(owner);
  if (cached !== undefined) return cached;
  const result = ownerMentionsOwnArguments(owner) ? computeOwnerArgumentsTaint(owner) : EMPTY_TAINT;
  OWNER_ARGUMENTS_TAINT.set(owner, result);
  return result;
}

function ownerMentionsOwnArguments(owner: Node): boolean {
  const pending: Node[] = [owner];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && readsSingleOwnerArguments(node, owner)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

function readsSingleOwnerArguments(node: Identifier, owner: Node): boolean {
  if (node.text !== 'arguments' || !readsBinding(node)) return false;
  if (enclosingArgumentsCallable(node) !== owner) return false;
  const declared = frameDeclarationOf(node);
  return declared === undefined || declared.pos < owner.pos || declared.end > owner.end;
}

function computeOwnerArgumentsTaint(owner: Node): ReadonlySet<FrameDeclaration> {
  const graph: TaintGraph = {
    dependents: new Map(),
    holders: new Map(),
    mutatedDependents: new Map(),
    mutatedSeed: new Set(),
    owner,
    valueSeed: new Set(),
  };
  const active: ActiveSinks = { mutated: new Map(), value: new Map() };
  const stack: TaintStep[] = [{ node: owner }];
  for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
    if (step.exit !== undefined) {
      popNodeSinks(active, step.exit);
      continue;
    }
    const current = step.node;
    if (current === undefined || isTypeOnly(current)) continue;
    linkCallableParameters(current, graph);
    const sinks = sinksForNode(current, owner);
    if (sinks.mutated.length > 0 || sinks.value.length > 0) {
      pushNodeSinks(active, sinks);
      stack.push({ exit: sinks });
    }
    if (isIdentifier(current) && readsBinding(current)) {
      recordIdentifierTaint(current, active, graph);
    }
    current.forEachChild((child) => {
      stack.push({ node: child });
    });
  }
  return propagateTaint(graph);
}

function pushNodeSinks(active: ActiveSinks, sinks: NodeSinks): void {
  for (const decl of sinks.mutated) active.mutated.set(decl, (active.mutated.get(decl) ?? 0) + 1);
  for (const decl of sinks.value) active.value.set(decl, (active.value.get(decl) ?? 0) + 1);
}

function popNodeSinks(active: ActiveSinks, sinks: NodeSinks): void {
  decrementSinks(active.mutated, sinks.mutated);
  decrementSinks(active.value, sinks.value);
}

function decrementSinks(
  counts: Map<FrameDeclaration, number>,
  list: readonly FrameDeclaration[],
): void {
  for (const decl of list) {
    const next = (counts.get(decl) ?? 1) - 1;
    if (next <= 0) counts.delete(decl);
    else counts.set(decl, next);
  }
}

function linkCallableParameters(node: Node, graph: TaintGraph): void {
  if (isFunctionDeclaration(node) && node.body !== undefined) {
    for (const param of parametersOf(node)) addEdge(graph.dependents, node, param);
    return;
  }
  if (!isVariableDeclaration(node) || node.initializer === undefined) return;
  const init = unwrapped(node.initializer);
  if (!isAnswering(init)) return;
  for (const param of parametersOf(init)) addEdge(graph.dependents, node, param);
}

function addEdge(
  table: Map<FrameDeclaration, Set<FrameDeclaration>>,
  from: FrameDeclaration,
  to: FrameDeclaration,
): void {
  let edges = table.get(from);
  if (edges === undefined) {
    edges = new Set();
    table.set(from, edges);
  }
  edges.add(to);
}

function recordIdentifierTaint(node: Identifier, active: ActiveSinks, graph: TaintGraph): void {
  if (active.mutated.size === 0 && active.value.size === 0) return;
  if (readsSingleOwnerArguments(node, graph.owner)) {
    for (const sink of active.mutated.keys()) graph.mutatedSeed.add(sink);
    for (const sink of active.value.keys()) graph.valueSeed.add(sink);
    return;
  }
  const declared = frameDeclarationOf(node);
  if (declared === undefined) return;
  const holdable = !immutablePrimitiveConst(declared);
  for (const sink of active.value.keys()) {
    addEdge(graph.dependents, declared, sink);
    if (holdable && sink !== declared) addEdge(graph.holders, sink, declared);
  }
  for (const sink of active.mutated.keys()) {
    addEdge(graph.mutatedDependents, declared, sink);
  }
}

function propagateTaint(graph: TaintGraph): ReadonlySet<FrameDeclaration> {
  const tainted = new Set<FrameDeclaration>([...graph.valueSeed, ...graph.mutatedSeed]);
  const state: PropagationState = {
    mutated: new Set<FrameDeclaration>(graph.mutatedSeed),
    mutatedQueue: [...graph.mutatedSeed],
    tainted,
    taintedQueue: [...tainted],
  };
  while (state.mutatedQueue.length > 0 || state.taintedQueue.length > 0) {
    drainMutatedQueue(state, graph.holders);
    drainTaintedQueue(state, graph);
  }
  return state.tainted;
}

function drainMutatedQueue(
  state: PropagationState,
  holders: ReadonlyMap<FrameDeclaration, ReadonlySet<FrameDeclaration>>,
): void {
  for (
    let current = state.mutatedQueue.pop();
    current !== undefined;
    current = state.mutatedQueue.pop()
  ) {
    const heldSet = holders.get(current);
    if (heldSet === undefined) continue;
    for (const held of heldSet) markMutatedAndTainted(state, held);
  }
}

function drainTaintedQueue(state: PropagationState, graph: TaintGraph): void {
  for (
    let current = state.taintedQueue.pop();
    current !== undefined;
    current = state.taintedQueue.pop()
  ) {
    const dependents = graph.dependents.get(current);
    if (dependents !== undefined) {
      for (const next of dependents) markTainted(state, next);
    }
    const mutatedTargets = graph.mutatedDependents.get(current);
    if (mutatedTargets !== undefined) {
      for (const target of mutatedTargets) markMutatedAndTainted(state, target);
    }
  }
}

function markTainted(state: PropagationState, decl: FrameDeclaration): void {
  if (state.tainted.has(decl)) return;
  state.tainted.add(decl);
  state.taintedQueue.push(decl);
}

function markMutatedAndTainted(state: PropagationState, decl: FrameDeclaration): void {
  if (!state.mutated.has(decl)) {
    state.mutated.add(decl);
    state.mutatedQueue.push(decl);
  }
  markTainted(state, decl);
}

function sinksForNode(node: Node, owner: Node): NodeSinks {
  if (isVariableDeclaration(node) || isParameterDeclaration(node)) {
    return { mutated: [], value: [node] };
  }
  if (node !== owner && (isFunctionDeclaration(node) || isClassDeclaration(node))) {
    return { mutated: [], value: [node] };
  }
  if (isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return assignmentTargetSinks(node.left);
  }
  if (isForOfStatement(node) || isForInStatement(node)) {
    return loopTargetSinks(node.initializer);
  }
  if (isCallExpression(node) || isNewExpression(node)) {
    return callTargetSinks(node);
  }
  return NO_SINKS;
}

function isAssignmentOperator(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

function loopTargetSinks(initializer: Node): NodeSinks {
  if (isVariableDeclarationList(initializer)) {
    return { mutated: [], value: initializer.declarations };
  }
  return assignmentTargetSinks(initializer);
}

function assignmentTargetSinks(lhs: Node): NodeSinks {
  const mutated: FrameDeclaration[] = [];
  const value: FrameDeclaration[] = [];
  const pending: Node[] = [lhs];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const target = isExpression(current) ? unwrapped(current) : current;
    if (isIdentifier(target)) {
      const decl = frameDeclarationOf(target);
      if (decl !== undefined) value.push(decl);
      continue;
    }
    if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      pushMutableRoot(target, mutated);
      continue;
    }
    queueAssignmentPatternChildren(target, pending);
  }
  return { mutated, value };
}

function queueAssignmentPatternChildren(target: Node, pending: Node[]): void {
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
    pending.push(target.left);
    return;
  }
  if (isSpreadElement(target) || isSpreadAssignment(target)) {
    pending.push(target.expression);
    return;
  }
  if (isPropertyAssignment(target)) {
    pending.push(target.initializer);
    return;
  }
  if (isShorthandPropertyAssignment(target)) {
    pending.push(target.name);
    return;
  }
  if (isArrayLiteralExpression(target)) {
    for (const element of target.elements) pending.push(element);
    return;
  }
  if (isObjectLiteralExpression(target)) {
    for (const prop of target.properties) pending.push(prop);
  }
}

function callTargetSinks(call: CallExpression | NewExpression): NodeSinks {
  const mutated: FrameDeclaration[] = [];
  const value: FrameDeclaration[] = [];
  const callee = unwrapped(call.expression);
  if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) {
    pushMutableRoot(callee.expression, mutated);
  }
  const args = call.arguments;
  if (args !== undefined) {
    for (const arg of args) {
      if (isSpreadElement(arg)) continue;
      const inner = unwrapped(arg);
      if (isAnswering(inner)) value.push(...parametersOf(inner));
      else pushMutableRoot(arg, mutated);
    }
  }
  if (isIdentifier(callee)) pushLocalCallableParameters(callee, value);
  return { mutated, value };
}

function pushMutableRoot(expr: Expression, found: FrameDeclaration[]): void {
  const root = rootIdentifier(expr);
  if (root === undefined) return;
  const decl = frameDeclarationOf(root);
  if (decl !== undefined && !immutablePrimitiveConst(decl)) found.push(decl);
}

function pushLocalCallableParameters(callee: Identifier, found: FrameDeclaration[]): void {
  const decl = frameDeclarationOf(callee);
  if (decl === undefined) return;
  if (isFunctionDeclaration(decl)) {
    for (const each of overloadsOf(decl)) {
      if (each.body !== undefined) found.push(...parametersOf(each));
    }
    return;
  }
  if (
    !isVariableDeclaration(decl) ||
    !constantDeclaration(decl) ||
    decl.initializer === undefined
  ) {
    return;
  }
  const init = unwrapped(decl.initializer);
  if (isAnswering(init)) found.push(...parametersOf(init));
}

function rootIdentifier(expr: Expression): Identifier | undefined {
  let current = unwrapped(expr);
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    current = unwrapped(current.expression);
  }
  return isIdentifier(current) ? current : undefined;
}

function immutablePrimitiveConst(decl: FrameDeclaration): boolean {
  if (
    !isVariableDeclaration(decl) ||
    !constantDeclaration(decl) ||
    decl.initializer === undefined
  ) {
    return false;
  }
  const init = unwrapped(decl.initializer);
  return (
    isStringLiteral(init) ||
    isNumericLiteral(init) ||
    isBigIntLiteral(init) ||
    isNoSubstitutionTemplateLiteral(init) ||
    PRIMITIVE_KEYWORDS.has(init.kind) ||
    (isIdentifier(init) && init.text === 'undefined' && frameDeclarationOf(init) === undefined)
  );
}

/** Finds the nearest enclosing non-arrow callable whose body or parameter list owns `node`. */
function enclosingArgumentsCallable(node: Node): Node | undefined {
  let within: Node = node;
  let fromParamDecorator = false;
  for (let at: Node = node.parent; !isSourceFile(at); within = at, at = at.parent) {
    const inHeader =
      isDecorator(within) ||
      (isParameterDeclaration(within) && fromParamDecorator) ||
      isComputedPropertyName(within);
    fromParamDecorator = isDecorator(within) && isParameterDeclaration(at);
    if (inHeader || !bindsOwnArguments(at)) continue;
    return isClassStaticBlockDeclaration(at) || isPropertyDeclaration(at) ? undefined : at;
  }
  return undefined;
}

/** Nested non-arrow functions and class initializers do not inherit `fn`'s `arguments`. */
function bindsOwnArguments(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isClassStaticBlockDeclaration(node)
  );
}
