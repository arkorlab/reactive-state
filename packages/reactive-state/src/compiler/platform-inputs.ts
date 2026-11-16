import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBigIntLiteral,
  isCallExpression,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isNewExpression,
  isSourceFile,
  isSpreadElement,
  isTemplateExpression,
  isVariableDeclaration,
  isVoidExpression,
  isWhileStatement,
  type NewExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { answersLater, isAnswering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { declarationOf } from './framed.ts';
import { readsOf } from './local-module-reads.ts';
import { constantValue } from './numbers.ts';
import {
  bindsTarget,
  contains,
  isExportedVariable,
  isPassiveUse,
  readPoints,
  runsInOwner,
  safePlatformCall,
  sourceFunction,
  targetNames,
  wrappedBy,
} from './platform-uses.ts';
import { withinFunction } from './scope.ts';
import { writtenBy } from './written.ts';

/** Local initializers that still describe a platform input when the construction reads it. */
interface Binding {
  readonly name: Identifier;
  readonly held: Expression | undefined;
  readonly owner: Node;
  readonly before: Node | undefined;
  readonly preserves: PlatformWrite | undefined;
}

/** A narrow proof that a particular write retains the platform property being checked. */
type PlatformWrite = (write: Node, target: Node, held: Expression | undefined) => boolean;

/** Cache key for a declaration's initializer validity up to `before` under `preserves`. */
interface InitializerQuery {
  readonly before: Node;
  readonly declaration: VariableDeclaration;
  readonly preserves: PlatformWrite | undefined;
}

/** Pre-indexed write site within an owner function or source file. */
interface OwnerWrite {
  readonly names: ReadonlySet<string>;
  readonly node: Node;
  readonly target: Node;
}

/** Per-file memoized initializer and mutability checks with active Tarjan cycle depths. */
interface PlatformState {
  readonly activeInitializers: Map<VariableDeclaration, number>;
  readonly activeMutable: Map<Expression, number>;
  readonly initializers: Map<
    VariableDeclaration,
    Map<Node, Map<PlatformWrite | undefined, Expression | undefined>>
  >;
  readonly lowlinks: number[];
  readonly mutable: Map<Expression, boolean>;
  readonly writes: Map<Node, readonly OwnerWrite[]>;
}

const STATES = new WeakMap<SourceFile, PlatformState>();

/** Returns or creates the shared analysis state for `sourceFile`. */
function stateFor(sourceFile: SourceFile): PlatformState {
  let state = STATES.get(sourceFile);
  if (state === undefined) {
    state = {
      activeInitializers: new Map(),
      activeMutable: new Map(),
      initializers: new Map(),
      lowlinks: [],
      mutable: new Map(),
      writes: new Map(),
    };
    STATES.set(sourceFile, state);
  }
  return state;
}

/** Opens an active recursion frame and returns its 1-based depth. */
function openFrame(state: PlatformState): number {
  const depth = state.lowlinks.length + 1;
  state.lowlinks.push(depth);
  return depth;
}

/** Records a back-edge to an active frame at `targetDepth`. */
function noteCycle(state: PlatformState, targetDepth: number): void {
  const index = state.lowlinks.length - 1;
  const current = state.lowlinks[index];
  if (current !== undefined && targetDepth < current) {
    state.lowlinks[index] = targetDepth;
  }
}

/** Closes the top frame, returning whether its result depended on no unfinished outer frame. */
function closeFrame(state: PlatformState, depth: number): boolean {
  const lowlink = state.lowlinks.pop() ?? depth;
  if (lowlink < depth) {
    noteCycle(state, lowlink);
    return false;
  }
  return true;
}

/** Reads a previously completed initializer result from `state`. */
function readCachedInitializer(
  state: PlatformState,
  query: InitializerQuery,
): { readonly found: true; readonly value: Expression | undefined } | { readonly found: false } {
  const byBefore = state.initializers.get(query.declaration)?.get(query.before);
  if (byBefore === undefined || !byBefore.has(query.preserves)) {
    return { found: false };
  }
  return { found: true, value: byBefore.get(query.preserves) };
}

/** Stores a completed initializer result in `state`. */
function writeCachedInitializer(
  state: PlatformState,
  query: InitializerQuery,
  value: Expression | undefined,
): void {
  let byBefore = state.initializers.get(query.declaration);
  if (byBefore === undefined) {
    byBefore = new Map();
    state.initializers.set(query.declaration, byBefore);
  }
  let byPreserves = byBefore.get(query.before);
  if (byPreserves === undefined) {
    byPreserves = new Map();
    byBefore.set(query.before, byPreserves);
  }
  byPreserves.set(query.preserves, value);
}

/** Indexes all write sites inside `owner` once per source file. */
function writesInOwner(owner: Node, state: PlatformState): readonly OwnerWrite[] {
  const cached = state.writes.get(owner);
  if (cached !== undefined) {
    return cached;
  }
  const found: OwnerWrite[] = [];
  const visit = (node: Node): void => {
    const target = writtenBy(node);
    if (target !== undefined) {
      found.push({ names: targetNames(target), node, target });
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  state.writes.set(owner, found);
  return found;
}

/** A variable's initializer only where binding and mutable-value writes cannot have changed it. */
export function platformInitializer(
  name: Identifier,
  before: Node,
  preserves?: PlatformWrite,
): Expression | undefined {
  return resolveInitializer(name, before, preserves, stateFor(name.getSourceFile()));
}

/** Resolves `name`'s initializer at `before`, sharing memoized results and active cycles. */
function resolveInitializer(
  name: Identifier,
  before: Node,
  preserves: PlatformWrite | undefined,
  state: PlatformState,
): Expression | undefined {
  const declaration = declarationOf(name);
  if (
    declaration === undefined ||
    !isVariableDeclaration(declaration) ||
    !isIdentifier(declaration.name) ||
    declaration.initializer === undefined
  ) {
    return undefined;
  }
  const binding: Binding = {
    ...bindingOf(declaration.name, declaration.initializer, before),
    preserves,
  };
  if (earlyInOwner(declaration, name, binding.owner)) {
    return undefined;
  }
  return cachedInitializer(binding, declaration, before, state);
}

/** Memoizes and cycle-guards `(declaration, before, preserves)` initializer checks. */
function cachedInitializer(
  binding: Binding,
  declaration: VariableDeclaration,
  before: Node,
  state: PlatformState,
): Expression | undefined {
  const query: InitializerQuery = { before, declaration, preserves: binding.preserves };
  const cached = readCachedInitializer(state, query);
  if (cached.found) {
    return cached.value;
  }
  const activeDepth = state.activeInitializers.get(declaration);
  if (activeDepth !== undefined) {
    noteCycle(state, activeDepth);
    return undefined;
  }
  const depth = openFrame(state);
  state.activeInitializers.set(declaration, depth);
  const value = unchangedInitializer(binding, declaration, state);
  state.activeInitializers.delete(declaration);
  if (closeFrame(state, depth)) {
    writeCachedInitializer(state, query, value);
  }
  return value;
}

/** Checks that `declaration` has initialized and neither its binding nor value changed. */
function unchangedInitializer(
  binding: Binding,
  declaration: VariableDeclaration,
  state: PlatformState,
): Expression | undefined {
  if (binding.before !== undefined && uninitializedAt(declaration, binding.before, binding.owner)) {
    return undefined;
  }
  const pending: Binding[] = [binding];
  const seen = new Set<Identifier>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (seen.has(current.name)) {
      continue;
    }
    seen.add(current.name);
    if (changedBinding(current, pending, state)) {
      return undefined;
    }
  }
  return declaration.initializer;
}

/** Whether `node` runs in `owner`'s execution before `declaration` finishes initializing. */
function earlyInOwner(declaration: VariableDeclaration, node: Node, owner: Node): boolean {
  return runsInOwner(node, owner) && (contains(declaration, node) || node.pos < declaration.pos);
}

/** Whether `before` or one of its known synchronous callers precedes `declaration`. */
function uninitializedAt(declaration: VariableDeclaration, before: Node, owner: Node): boolean {
  if (earlyInOwner(declaration, before, owner)) {
    return true;
  }
  const points = readPoints(before, owner);
  return points !== undefined && points.some((point) => earlyInOwner(declaration, point, owner));
}

/** The function or module holding a declaration, with a cutoff only inside that same execution. */
function bindingOf(name: Identifier, held: Expression | undefined, before?: Node): Binding {
  let owner: Node = name.parent;
  while (!isSourceFile(owner) && !isAnswering(owner)) {
    owner = owner.parent;
  }
  return { before, held, name, owner, preserves: undefined };
}

/** Whether `read` may execute before one of `points` inside `binding.owner`. */
function relevantNode(read: Node, binding: Binding, points: readonly Node[] | undefined): boolean {
  return (
    points === undefined ||
    isSourceFile(binding.owner) ||
    points.some((point) => read.pos < point.end || repeatsBefore(read, point, binding)) ||
    withinFunction(read, binding.owner)
  );
}

/** Checks reassignments on an immutable binding using `owner`'s indexed write sites. */
function immutableBindingChanged(binding: Binding, state: PlatformState): boolean {
  const candidates = writesInOwner(binding.owner, state).filter((each) =>
    each.names.has(binding.name.text),
  );
  if (candidates.length === 0) {
    return false;
  }
  const isRead = readsOf(binding.name, binding.owner);
  const points =
    binding.before === undefined ? undefined : readPoints(binding.before, binding.owner);
  return candidates.some((write) => {
    return (
      relevantNode(write.node, binding, points) &&
      bindsTarget(write.target, isRead, false) &&
      binding.preserves?.(write.node, write.target, binding.held) !== true
    );
  });
}

/** Whether a lexical binding or what it holds was written or handed where writes cannot be read. */
function changedBinding(binding: Binding, pending: Binding[], state: PlatformState): boolean {
  const { name, held, owner, before } = binding;
  const mutable = isMutableHolding(held, state);
  if (!mutable) {
    return immutableBindingChanged(binding, state);
  }
  if (isExportedVariable(name)) {
    return true;
  }
  const isRead = readsOf(name, owner);
  const points = before === undefined ? undefined : readPoints(before, owner);
  const visit = (node: Node): boolean => {
    const eligible = relevantNode(node, binding, points);
    const target = eligible ? writtenBy(node) : undefined;
    if (
      target !== undefined &&
      bindsTarget(target, isRead, true) &&
      binding.preserves?.(node, target, held) !== true
    ) {
      return true;
    }
    if (eligible && isRead(node) && handedUnknown(node, binding, pending)) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return owner.forEachChild((child) => (visit(child) ? true : undefined)) === true;
}

/** A later write can precede the next read when an enclosing loop carries that binding around. */
function repeatsBefore(write: Node, read: Node, binding: Binding): boolean {
  for (let each = read; each !== binding.owner; each = each.parent) {
    const parent = each.parent;
    if (
      !(
        isForStatement(parent) ||
        isForOfStatement(parent) ||
        isForInStatement(parent) ||
        isWhileStatement(parent) ||
        isDoStatement(parent)
      ) ||
      !contains(parent, write)
    ) {
      continue;
    }
    const initializer: Node | undefined = isForStatement(parent) ? parent.initializer : undefined;
    const once =
      initializer === each ||
      ((isForOfStatement(parent) || isForInStatement(parent)) && parent.expression === each);
    const reset = contains(parent.statement, binding.name) && binding.name.end < read.pos;
    if (!once && !reset) {
      return true;
    }
  }
  return false;
}

/** Mutable aliases and source parameters retain lexical identity only across non-escaping uses. */
function handedUnknown(name: Identifier, binding: Binding, pending: Binding[]): boolean {
  let node: Expression = name;
  while (wrappedBy(node.parent)) {
    node = node.parent as Expression;
  }
  const parent = node.parent;
  if (isVariableDeclaration(parent) && parent.initializer === node) {
    if (!isIdentifier(parent.name) || isExportedVariable(parent.name)) {
      return true;
    }
    pending.push(bindingOf(parent.name, binding.held, binding.before));
    return false;
  }
  if (isPassiveUse(node, parent, binding.held)) {
    return false;
  }
  if (isCallExpression(parent) || isNewExpression(parent)) {
    return handedCall(node, parent, binding, pending);
  }
  return true;
}

/** Whether passing `node` into `call` can mutate or expose it beyond tracked parameters. */
function handedCall(
  node: Expression,
  call: CallExpression | NewExpression,
  binding: Binding,
  pending: Binding[],
): boolean {
  const args = call.arguments;
  const index = args?.indexOf(node) ?? -1;
  if (index < 0) {
    return true;
  }
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path !== undefined) {
    return !safePlatformCall(call, path, binding.held);
  }
  if (
    isNewExpression(call) ||
    args?.slice(0, index + 1).some((each) => isSpreadElement(each)) === true
  ) {
    return true;
  }
  const fn = sourceFunction(call.expression);
  const parameter = fn === undefined || answersLater(fn) ? undefined : parametersOf(fn)[index];
  if (
    parameter === undefined ||
    parameter.dotDotDotToken !== undefined ||
    !isIdentifier(parameter.name)
  ) {
    return true;
  }
  pending.push(bindingOf(parameter.name, binding.held));
  return false;
}

/** Whether `held` may evaluate to a mutable object rather than a primitive value. */
function isMutableHolding(held: Expression | undefined, state: PlatformState): boolean {
  if (held === undefined) {
    return true;
  }
  const value = unwrapped(held);
  const cached = state.mutable.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const activeDepth = state.activeMutable.get(value);
  if (activeDepth !== undefined) {
    noteCycle(state, activeDepth);
    return true;
  }
  const depth = openFrame(state);
  state.activeMutable.set(value, depth);
  const result = computeMutable(value, state);
  state.activeMutable.delete(value);
  if (closeFrame(state, depth)) {
    state.mutable.set(value, result);
  }
  return result;
}

/** Evaluates whether an unwrapped expression may produce a mutable object. */
function computeMutable(value: Expression, state: PlatformState): boolean {
  const undefinedGlobal = globalPathOf(value)?.join('.') === 'undefined';
  if (isIdentifier(value) && !undefinedGlobal) {
    return identifierMutable(value, state);
  }
  return (
    constantValue(value) === undefined &&
    value.kind !== SyntaxKind.NullKeyword &&
    !isBigIntLiteral(value) &&
    !isVoidExpression(value) &&
    !isTemplateExpression(value) &&
    !undefinedGlobal
  );
}

/** Whether an identifier read may hold a mutable object rather than a copied primitive. */
function identifierMutable(value: Identifier, state: PlatformState): boolean {
  const declaration = declarationOf(value);
  if (
    declaration === undefined ||
    !isVariableDeclaration(declaration) ||
    !isIdentifier(declaration.name) ||
    declaration.initializer === undefined ||
    isMutableHolding(declaration.initializer, state)
  ) {
    return true;
  }
  return resolveInitializer(value, value, undefined, state) === undefined;
}
