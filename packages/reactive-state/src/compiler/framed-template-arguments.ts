import {
  type Identifier,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isParameterDeclaration,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isSourceFile,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';

import { type Answering, parametersOf } from './answers.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import {
  callableParametersInInitializer,
  immutablePrimitiveConst,
  type NodeSinks,
  sinksForNode,
} from './framed-template-argument-sinks.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

export { constantDeclaration } from './framed-template-argument-sinks.ts';

/**
 * Own and inherited `arguments` reachability for source-written template tags, including outer
 * bindings tainted by indexed, destructured, spread, iterated, reassigned, or container-mutated
 * `arguments` reads in enclosing non-arrow callables.
 */

interface OwnerArgumentsTaint {
  readonly tainted: ReadonlySet<FrameDeclaration>;
  readonly unsafe: boolean;
}

const EMPTY_TAINT: ReadonlySet<FrameDeclaration> = new Set();
const EMPTY_OWNER_TAINT: OwnerArgumentsTaint = { tainted: EMPTY_TAINT, unsafe: false };
const OWNER_ARGUMENTS_TAINT = new WeakMap<Node, OwnerArgumentsTaint>();

interface TaintGraph {
  readonly dependents: Map<FrameDeclaration, Set<FrameDeclaration>>;
  readonly holders: Map<FrameDeclaration, Set<FrameDeclaration>>;
  readonly mutatedDependents: Map<FrameDeclaration, Set<FrameDeclaration>>;
  readonly mutatedSeed: Set<FrameDeclaration>;
  readonly owner: Node;
  readonly valueSeed: Set<FrameDeclaration>;
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

function collectOwnersTaint(owners: ReadonlySet<Node>): OwnerArgumentsTaint {
  if (owners.size === 0) return EMPTY_OWNER_TAINT;
  const combined = new Set<FrameDeclaration>();
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
  const graph: TaintGraph = {
    dependents: new Map(),
    holders: new Map(),
    mutatedDependents: new Map(),
    mutatedSeed: new Set(),
    owner,
    valueSeed: new Set(),
  };
  const unsafeCandidates: Node[] = [];
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
    if (sinks.unresolvable) unsafeCandidates.push(current);
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
  const tainted = propagateTaint(graph);
  const unsafe = unsafeCandidates.some((candidate) =>
    nodeCarriesOwnerTaint(candidate, owner, tainted),
  );
  return { tainted, unsafe };
}

function nodeCarriesOwnerTaint(
  candidate: Node,
  owner: Node,
  tainted: ReadonlySet<FrameDeclaration>,
): boolean {
  const pending: Node[] =
    isForOfStatement(candidate) || isForInStatement(candidate)
      ? [candidate.initializer, candidate.expression]
      : [candidate];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      readsBinding(node) &&
      identifierCarriesOwnerTaint(node, owner, tainted)
    ) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

function identifierCarriesOwnerTaint(
  node: Identifier,
  owner: Node,
  tainted: ReadonlySet<FrameDeclaration>,
): boolean {
  if (readsSingleOwnerArguments(node, owner)) return true;
  if (tainted.size === 0) return false;
  const declared = frameDeclarationOf(node);
  return declared !== undefined && tainted.has(declared);
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
  for (const param of callableParametersInInitializer(node.initializer)) {
    addEdge(graph.dependents, node, param);
  }
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
