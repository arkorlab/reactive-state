import {
  type Identifier,
  isBindingElement,
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, parametersOf } from './answers.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  bindsOwnArguments,
  enclosingArgumentsCallable,
  hasClassDecorators,
  thisKeyOfNode,
} from './framed-template-argument-classes.ts';
import {
  callableParametersInInitializer,
  hasParameterProperty,
  immutablePrimitiveConst,
  resolveDirectBaseClass,
  type TaintKey,
} from './framed-template-argument-receivers.ts';
import { type NodeSinks, sinksForNode } from './framed-template-argument-sinks.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

export { constantDeclaration } from './framed-template-argument-sinks.ts';

/**
 * Own and inherited `arguments` reachability for source-written template tags, including outer
 * bindings and receivers tainted by indexed, destructured, spread, iterated, reassigned, helper,
 * constructor, or container-mutated `arguments` reads in enclosing non-arrow callables.
 */

interface OwnerArgumentsTaint {
  readonly tainted: ReadonlySet<TaintKey>;
  readonly unsafe: boolean;
}

const EMPTY_TAINT: ReadonlySet<TaintKey> = new Set();
const EMPTY_OWNER_TAINT: OwnerArgumentsTaint = { tainted: EMPTY_TAINT, unsafe: false };
const OWNER_ARGUMENTS_TAINT = new WeakMap<Node, OwnerArgumentsTaint>();

interface TaintGraph {
  readonly dependents: Map<TaintKey, Set<TaintKey>>;
  readonly holders: Map<TaintKey, Set<TaintKey>>;
  readonly mutatedDependents: Map<TaintKey, Set<TaintKey>>;
  readonly mutatedSeed: Set<TaintKey>;
  readonly owner: Node;
  readonly valueSeed: Set<TaintKey>;
}

interface ActiveSinks {
  readonly mutated: Map<TaintKey, number>;
  readonly value: Map<TaintKey, number>;
}

interface TaintStep {
  readonly enterValue?: readonly TaintKey[];
  readonly exitMutated?: readonly TaintKey[];
  readonly exitValue?: readonly TaintKey[];
  readonly node?: Node;
}

interface WalkState {
  readonly active: ActiveSinks;
  readonly externalQueue: Node[];
  readonly graph: TaintGraph;
  readonly owner: Node;
  readonly scopedByNode: Map<Node, TaintKey[]>;
  readonly stack: TaintStep[];
  readonly unsafeCandidates: Node[];
  readonly visitedExternal: Set<Node>;
}

interface PropagationState {
  readonly mutated: Set<TaintKey>;
  readonly mutatedQueue: TaintKey[];
  readonly tainted: Set<TaintKey>;
  readonly taintedQueue: TaintKey[];
}

/** Own or inherited `arguments` reads (including tainted outer bindings) can expose error values. */
export function mentionsAccessibleArguments(fn: Answering): boolean {
  if (fn.body === undefined) return false;
  const owners = accessibleArgumentsOwners(fn);
  const { tainted, unsafe } = collectOwnersTaint(owners);
  if (unsafe) return true;
  const ownParams = new Set<Node>(parametersOf(fn));
  const pending: Node[] = [...parametersOf(fn), fn.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (readsTagNodeTaint(node, owners, tainted, ownParams)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

function readsTagNodeTaint(
  node: Node,
  owners: ReadonlySet<Node>,
  tainted: ReadonlySet<TaintKey>,
  ownParams: ReadonlySet<Node>,
): boolean {
  if (node.kind === SyntaxKind.ThisKeyword || node.kind === SyntaxKind.SuperKeyword) {
    const key = thisKeyOfNode(node);
    return key !== undefined && tainted.has(key);
  }
  return (
    isIdentifier(node) &&
    readsBinding(node) &&
    readsOwnerOrTainted(node, owners, tainted, ownParams)
  );
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

function collectOwnersTaint(owners: ReadonlySet<Node>): OwnerArgumentsTaint {
  if (owners.size === 0) return EMPTY_OWNER_TAINT;
  const combined = new Set<TaintKey>();
  for (const owner of owners) {
    const result = taintedBindingsOfOwner(owner);
    if (result.unsafe) return { tainted: EMPTY_TAINT, unsafe: true };
    for (const decl of result.tainted) combined.add(decl);
  }
  return { tainted: combined, unsafe: false };
}

function readsOwnerOrTainted(
  node: Identifier,
  owners: ReadonlySet<Node>,
  tainted: ReadonlySet<TaintKey>,
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

function taintedBindingsOfOwner(owner: Node): OwnerArgumentsTaint {
  const cached = OWNER_ARGUMENTS_TAINT.get(owner);
  if (cached !== undefined) return cached;
  const result = ownerMentionsOwnArguments(owner)
    ? computeOwnerArgumentsTaint(owner)
    : EMPTY_OWNER_TAINT;
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

function computeOwnerArgumentsTaint(owner: Node): OwnerArgumentsTaint {
  const state: WalkState = {
    active: { mutated: new Map(), value: new Map() },
    externalQueue: [],
    graph: {
      dependents: new Map(),
      holders: new Map(),
      mutatedDependents: new Map(),
      mutatedSeed: new Set(),
      owner,
      valueSeed: new Set(),
    },
    owner,
    scopedByNode: new Map(),
    stack: [{ node: owner }],
    unsafeCandidates: [],
    visitedExternal: new Set(),
  };
  drainWalkState(state);
  const tainted = propagateTaint(state.graph);
  const unsafe = state.unsafeCandidates.some((candidate) =>
    nodeCarriesOwnerTaint(candidate, owner, tainted),
  );
  return { tainted, unsafe };
}

function drainWalkState(state: WalkState): void {
  for (;;) {
    for (let step = state.stack.pop(); step !== undefined; step = state.stack.pop()) {
      processWalkStep(step, state);
    }
    const nextExt = state.externalQueue.pop();
    if (nextExt === undefined) return;
    state.stack.push({ node: nextExt });
  }
}

function processWalkStep(step: TaintStep, state: WalkState): void {
  if (step.enterValue !== undefined) {
    incrementSinks(state.active.value, step.enterValue);
    return;
  }
  if (step.exitMutated !== undefined || step.exitValue !== undefined) {
    if (step.exitMutated !== undefined) decrementSinks(state.active.mutated, step.exitMutated);
    if (step.exitValue !== undefined) decrementSinks(state.active.value, step.exitValue);
    return;
  }
  const current = step.node;
  if (current === undefined || isTypeOnly(current)) return;
  visitWalkNode(current, state);
}

function visitWalkNode(current: Node, state: WalkState): void {
  linkDeclarationEdges(current, state.graph);
  const scoped = state.scopedByNode.get(current);
  const sinks = sinksForNode(current, state.owner);
  if (sinks.unresolvable) state.unsafeCandidates.push(current);
  applyNodeMetaEdges(sinks, state);
  const combinedValue = mergeValueLists(scoped, sinks.value);
  if (sinks.mutated.length > 0 || combinedValue.length > 0) {
    incrementSinks(state.active.mutated, sinks.mutated);
    incrementSinks(state.active.value, combinedValue);
    state.stack.push({ exitMutated: sinks.mutated, exitValue: combinedValue });
  }
  recordNodeValueTaint(current, state.active, state.graph);
  pushUnfoldedTasks(sinks, state.stack);
  current.forEachChild((child) => {
    state.stack.push({ node: child });
  });
}

function mergeValueLists(
  first: readonly TaintKey[] | undefined,
  second: readonly TaintKey[],
): readonly TaintKey[] {
  if (first === undefined || first.length === 0) return second;
  if (second.length === 0) return first;
  return [...first, ...second];
}

function applyNodeMetaEdges(sinks: NodeSinks, state: WalkState): void {
  for (const [node, keys] of sinks.scopedValue) {
    const existing = state.scopedByNode.get(node);
    if (existing === undefined) state.scopedByNode.set(node, [...keys]);
    else existing.push(...keys);
  }
  for (const [fromKey, toKey] of sinks.receiverLinks) {
    addEdge(state.graph.dependents, fromKey, toKey);
  }
  for (const retKey of sinks.returnedFrom) {
    applyReturnedKeyEdges(retKey, state.active, state.graph);
  }
  for (const ext of sinks.externalBodies) {
    if (!state.visitedExternal.has(ext)) {
      state.visitedExternal.add(ext);
      state.externalQueue.push(ext);
    }
  }
}

function applyReturnedKeyEdges(retKey: TaintKey, active: ActiveSinks, graph: TaintGraph): void {
  for (const sink of active.value.keys()) {
    if (sink !== retKey) addEdge(graph.dependents, retKey, sink);
  }
  for (const sink of active.mutated.keys()) {
    if (sink !== retKey) addEdge(graph.mutatedDependents, retKey, sink);
  }
}

function pushUnfoldedTasks(sinks: NodeSinks, stack: TaintStep[]): void {
  for (const task of sinks.unfoldedTasks) {
    stack.push({ exitValue: task.value }, { node: task.node }, { enterValue: task.value });
  }
}

function recordNodeValueTaint(current: Node, active: ActiveSinks, graph: TaintGraph): void {
  if (isIdentifier(current) && readsBinding(current)) {
    recordIdentifierTaint(current, active, graph);
    return;
  }
  if (current.kind === SyntaxKind.ThisKeyword || current.kind === SyntaxKind.SuperKeyword) {
    recordThisKeywordTaint(current, active, graph);
    return;
  }
  if (isObjectLiteralExpression(current)) {
    for (const sink of active.value.keys()) {
      if (sink !== current) {
        addEdge(graph.dependents, current, sink);
        addEdge(graph.holders, sink, current);
      }
    }
  }
}

function recordThisKeywordTaint(node: Node, active: ActiveSinks, graph: TaintGraph): void {
  if (active.mutated.size === 0 && active.value.size === 0) return;
  const thisKey = thisKeyOfNode(node);
  if (thisKey === undefined) return;
  for (const sink of active.value.keys()) {
    if (sink !== thisKey) addEdge(graph.dependents, thisKey, sink);
  }
  for (const sink of active.mutated.keys()) {
    if (sink !== thisKey) addEdge(graph.mutatedDependents, thisKey, sink);
  }
}

function nodeCarriesOwnerTaint(
  candidate: Node,
  owner: Node,
  tainted: ReadonlySet<TaintKey>,
): boolean {
  const pending: Node[] =
    isForOfStatement(candidate) || isForInStatement(candidate)
      ? [candidate.initializer, candidate.expression]
      : [candidate];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (singleNodeCarriesOwnerTaint(node, owner, tainted)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

function singleNodeCarriesOwnerTaint(
  node: Node,
  owner: Node,
  tainted: ReadonlySet<TaintKey>,
): boolean {
  if (node.kind === SyntaxKind.ThisKeyword || node.kind === SyntaxKind.SuperKeyword) {
    const key = thisKeyOfNode(node);
    return key !== undefined && tainted.has(key);
  }
  return (
    isIdentifier(node) && readsBinding(node) && identifierCarriesOwnerTaint(node, owner, tainted)
  );
}

function identifierCarriesOwnerTaint(
  node: Identifier,
  owner: Node,
  tainted: ReadonlySet<TaintKey>,
): boolean {
  if (readsSingleOwnerArguments(node, owner)) return true;
  if (tainted.size === 0) return false;
  const declared = frameDeclarationOf(node);
  return declared !== undefined && tainted.has(declared);
}

function incrementSinks(counts: Map<TaintKey, number>, list: readonly TaintKey[]): void {
  for (const decl of list) counts.set(decl, (counts.get(decl) ?? 0) + 1);
}

function decrementSinks(counts: Map<TaintKey, number>, list: readonly TaintKey[]): void {
  for (const decl of list) {
    const next = (counts.get(decl) ?? 1) - 1;
    if (next <= 0) counts.delete(decl);
    else counts.set(decl, next);
  }
}

function linkDeclarationEdges(node: Node, graph: TaintGraph): void {
  if (isFunctionDeclaration(node) && node.body !== undefined) {
    for (const param of parametersOf(node)) addEdge(graph.dependents, node, param);
    return;
  }
  if (isClassDeclaration(node) || isClassExpression(node)) {
    const base = resolveDirectBaseClass(node);
    if (base !== undefined) {
      addEdge(graph.dependents, base, node);
      addEdge(graph.dependents, node, base);
    }
    return;
  }
  if (isConstructorDeclaration(node)) {
    linkConstructorParameterProperties(node, graph);
    return;
  }
  if (!isVariableDeclaration(node) || node.initializer === undefined) return;
  for (const param of callableParametersInInitializer(node.initializer)) {
    addEdge(graph.dependents, node, param);
  }
}

function linkConstructorParameterProperties(node: Node, graph: TaintGraph): void {
  if (!isConstructorDeclaration(node)) return;
  const { parent } = node;
  if ((!isClassDeclaration(parent) && !isClassExpression(parent)) || hasClassDecorators(parent)) {
    return;
  }
  for (const param of node.parameters) {
    if (hasParameterProperty(param)) addEdge(graph.mutatedDependents, param, parent);
  }
}

function addEdge(table: Map<TaintKey, Set<TaintKey>>, from: TaintKey, to: TaintKey): void {
  let edges = table.get(from);
  if (edges === undefined) {
    edges = new Set();
    table.set(from, edges);
  }
  edges.add(to);
}

function isDeclarationBindingIdentifier(node: Identifier): boolean {
  const { parent } = node;
  return (
    (isVariableDeclaration(parent) ||
      isParameterDeclaration(parent) ||
      isBindingElement(parent) ||
      isFunctionDeclaration(parent) ||
      isFunctionExpression(parent) ||
      isClassDeclaration(parent) ||
      isClassExpression(parent)) &&
    parent.name === node
  );
}

function recordIdentifierTaint(node: Identifier, active: ActiveSinks, graph: TaintGraph): void {
  if (active.mutated.size === 0 && active.value.size === 0) return;
  if (isDeclarationBindingIdentifier(node)) return;
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

function propagateTaint(graph: TaintGraph): ReadonlySet<TaintKey> {
  const tainted = new Set<TaintKey>([...graph.valueSeed, ...graph.mutatedSeed]);
  const state: PropagationState = {
    mutated: new Set<TaintKey>(graph.mutatedSeed),
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
  holders: ReadonlyMap<TaintKey, ReadonlySet<TaintKey>>,
): void {
  for (
    let current = state.mutatedQueue.pop();
    current !== undefined;
    current = state.mutatedQueue.pop()
  ) {
    const heldSet = holders.get(current);
    if (heldSet === undefined) continue;
    for (const holder of heldSet) {
      markMutated(state, holder);
      markTainted(state, holder);
    }
  }
}

function drainTaintedQueue(state: PropagationState, graph: TaintGraph): void {
  for (
    let current = state.taintedQueue.pop();
    current !== undefined;
    current = state.taintedQueue.pop()
  ) {
    const direct = graph.dependents.get(current);
    if (direct !== undefined) {
      for (const dep of direct) markTainted(state, dep);
    }
    const mutDeps = graph.mutatedDependents.get(current);
    if (mutDeps !== undefined) {
      for (const sink of mutDeps) {
        markMutated(state, sink);
        markTainted(state, sink);
      }
    }
  }
}

function markTainted(state: PropagationState, decl: TaintKey): void {
  if (state.tainted.has(decl)) return;
  state.tainted.add(decl);
  state.taintedQueue.push(decl);
}

function markMutated(state: PropagationState, decl: TaintKey): void {
  if (state.mutated.has(decl)) return;
  state.mutated.add(decl);
  state.mutatedQueue.push(decl);
}
