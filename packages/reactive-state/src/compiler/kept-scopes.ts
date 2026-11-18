import {
  type BindingName,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { declarationOf, type Declared } from './framed.ts';
import { startupField } from './kept-fields.ts';
import { bindingIdentifiers, freeReads, hoistedIn, readsBinding } from './scope.ts';
import { writtenArgumentBy, writtenCallValues } from './written.ts';

/** Lexical scope, startup-call and wrapper helpers for module-kept state analysis. */

export type WrittenBy = (node: Node) => Node | undefined;

type ReverseHolders = ReadonlyMap<Declared, ReadonlySet<Declared>>;

export interface HolderGraph {
  readonly aliases: ReverseHolders;
  readonly memberHolders: ReverseHolders;
  readonly reverseHolders: ReverseHolders;
  readonly writes: ReadonlyMap<Declared, readonly Expression[]>;
}

export interface WatchState {
  readonly aliasWalked: Set<Declared>;
  readonly watched: Set<Declared>;
}

interface MutableHolderGraph {
  readonly aliases: Map<Declared, Set<Declared>>;
  readonly fn: Node;
  readonly memberHolders: Map<Declared, Set<Declared>>;
  readonly reverseHolders: Map<Declared, Set<Declared>>;
  readonly writes: Map<Declared, Expression[]>;
  readonly writtenBy: WrittenBy;
}

interface WorklistQueues {
  readonly aliasStack: Declared[];
  readonly queueAlias: (declared: Declared) => void;
  readonly queueWatched: (declared: Declared) => void;
  readonly worklist: Declared[];
}

const FREE_READS = new WeakMap<Node, ReadonlySet<Identifier>>();
const CARRIER_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Whether `node` runs anew for a call or instance: a function or an instance field's initializer. */
export function isFunctionCode(node: Node): boolean {
  return (
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isInstanceField(node)
  );
}

/** Whether `child` belongs to deferred code rather than the field's class-definition expressions. */
export function isCodeAt(node: Node, child: Node): boolean {
  return (
    isFunctionCode(node) &&
    (!isPropertyDeclaration(node) || (Object.is(node.initializer, child) && !startupField(node)))
  );
}

/** Parentheses, type assertions and `!` preserve the runtime expression they wrap. */
export function isTypeWrapper(node: Node): node is Node & { readonly expression: Expression } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node)
  );
}

/** Whether `fn`, a function, is called where it is written, once: `(() => { … })()`. */
export function isCalledInPlace(fn: Node): boolean {
  let at = fn;
  while (isTypeWrapper(at.parent)) at = at.parent;
  const call = at.parent;
  return isCallExpression(call) && call.expression === at;
}

/** Whether `node` stands within `fn`. */
export function isWithin(node: Node, fn: Node): boolean {
  for (let at: Node = node.parent; !isSourceFile(at); at = at.parent) {
    if (at === fn) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the module calls `fn` by its name as it loads, `const next = makeCounter()` — of the name
 * it is declared by, or a variable's it is the value of, where nothing between declares it again.
 */
export function isCalledAsLoads(fn: Node): boolean {
  const name = nameOf(fn);
  if (name === undefined) {
    return false;
  }
  const holder = holderOf(name);
  let found = false;
  const visit = (node: Node): void => {
    // A function's code, but one called in place, runs as it is called, not as the module loads.
    if (found) {
      return;
    }
    if (isInstanceField(node)) {
      if (isComputedPropertyName(node.name)) {
        visit(node.name.expression);
      }
      if (startupField(node) && node.initializer !== undefined) {
        visit(node.initializer);
      }
      return;
    }
    if (isFunctionCode(node) && !isCalledInPlace(node)) {
      return;
    }
    const callee = isCallExpression(node) ? unwrapped(node.expression) : undefined;
    found =
      callee !== undefined &&
      isIdentifier(callee) &&
      callee.text === name.text &&
      holderOf(callee) === holder;
    if (!found) {
      node.forEachChild(visit);
    }
  };
  let file: Node = fn;
  while (!isSourceFile(file)) {
    file = file.parent;
  }
  file.forEachChild(visit);
  return found;
}

/** Whether this identifier resolves within `fn`, using its actual block, loop and catch scopes. */
export function declares(fn: Node, name: Identifier): boolean {
  if ((isFunctionDeclaration(fn) && fn.name === name) || readsFunctionObject(fn, name)) {
    return false;
  }
  return !freeWithin(fn).has(name);
}

/** An instance field's initializer runs at construction; its computed key runs at class definition. */
function isInstanceField(node: Node): node is PropertyDeclaration {
  return (
    isPropertyDeclaration(node) &&
    node.initializer !== undefined &&
    node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) !== true
  );
}

/** The name `fn` is called by: the one it is declared by, or a variable's it is the value of. */
function nameOf(fn: Node): Identifier | undefined {
  if (isFunctionDeclaration(fn)) {
    return fn.name;
  }
  let at = fn.parent;
  while (isTypeWrapper(at)) at = at.parent;
  return isVariableDeclaration(at) && isIdentifier(at.name) ? at.name : undefined;
}

/** What declares `name` where it stands, of its own (`declares`): a function around it, or the module. */
function holderOf(name: Identifier): Node {
  let child: Node = name;
  let at: Node = name.parent;
  while (!isSourceFile(at) && !(isCodeAt(at, child) && declares(at, name))) {
    child = at;
    at = at.parent;
  }
  return at;
}

/** The free identifier nodes of one immutable syntax tree, preserving block binding identities. */
function freeWithin(fn: Node): ReadonlySet<Identifier> {
  let free = FREE_READS.get(fn);
  if (free === undefined) {
    free = new Set(freeReads(fn));
    FREE_READS.set(fn, free);
  }
  return free;
}

/** A named expression's self reference reaches the function object allocated by its outer frame. */
function readsFunctionObject(fn: Node, name: Identifier): boolean {
  if (!isFunctionExpression(fn) || fn.name?.text !== name.text) {
    return false;
  }
  const bound = (declaration: { readonly name: BindingName }): boolean =>
    bindingIdentifiers(declaration.name).some((each) => each.text === name.text);
  if (fn.parameters.some((parameter) => bound(parameter))) {
    return false;
  }
  if (!isWithin(name, fn.body)) {
    return true;
  }
  return (
    hoistedIn([fn.body]).every((declaration) => !bound(declaration)) &&
    freeWithin(fn.body).has(name)
  );
}

/**
 * What `node`, what an assignment or a loop writes into, writes into each: of a pattern, each of its
 * targets, in turn — `[n] = [n + 1]`, `({ a: kept.x } = value)`, a default's, `[n = 0] = …`, a
 * rest's — of anything else, itself.
 */
export function targetsOf(node: Node): readonly Node[] {
  let target = node;
  while (isTypeWrapper(target)) target = target.expression;
  if (isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) =>
      targetsOf(isSpreadElement(element) ? element.expression : element),
    );
  }
  if (isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property): readonly Node[] => {
      if (isPropertyAssignment(property)) {
        return targetsOf(property.initializer);
      }
      if (isShorthandPropertyAssignment(property)) {
        return [property.name];
      }
      return isSpreadAssignment(property) ? targetsOf(property.expression) : [];
    });
  }
  return isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken
    ? targetsOf(target.left)
    : [target];
}

/** The name `node` is of, past the members it reads and what wraps it: `cache` of `cache[key].x`. */
export function rootOf(node: Node): Identifier | undefined {
  let each = node;
  while (
    isPropertyAccessExpression(each) ||
    isElementAccessExpression(each) ||
    isTypeWrapper(each)
  ) {
    each = each.expression;
  }
  return isIdentifier(each) && readsBinding(each) ? each : undefined;
}

/**
 * Propagates `initial` across `graph` with a worklist, adding newly reached holder declarations to
 * `state.watched` and returning them.
 */
export function extendWatchedDeclarations(
  initial: Declared,
  graph: HolderGraph,
  state: WatchState,
): readonly Declared[] {
  if (state.watched.has(initial)) {
    return [];
  }
  const added: Declared[] = [];
  const worklist: Declared[] = [];
  const aliasStack: Declared[] = [];
  const queueWatched = (declared: Declared): void => {
    if (!state.watched.has(declared)) {
      state.watched.add(declared);
      added.push(declared);
      worklist.push(declared);
    }
  };
  const queueAlias = (declared: Declared): void => {
    queueWatched(declared);
    if (!state.aliasWalked.has(declared)) {
      state.aliasWalked.add(declared);
      aliasStack.push(declared);
    }
  };
  queueWatched(initial);
  drainHolderWorklists(graph, { aliasStack, queueAlias, queueWatched, worklist });
  return added;
}

/** Drains watched-holder and member-mutated alias worklists until no new declarations are reached. */
function drainHolderWorklists(graph: HolderGraph, queues: WorklistQueues): void {
  const { aliasStack, queueAlias, queueWatched, worklist } = queues;
  while (worklist.length > 0 || aliasStack.length > 0) {
    for (let alias = aliasStack.pop(); alias !== undefined; alias = aliasStack.pop()) {
      queueEdges(graph.aliases, alias, queueAlias);
    }
    const current = worklist.pop();
    if (current === undefined) {
      continue;
    }
    queueEdges(graph.reverseHolders, current, queueWatched);
    queueEdges(graph.memberHolders, current, queueAlias);
  }
}

/** Enqueues every adjacent declaration recorded under `key` in `edges`, if any. */
function queueEdges(
  edges: ReverseHolders,
  key: Declared,
  enqueue: (declared: Declared) => void,
): void {
  const targets = edges.get(key);
  if (targets === undefined) {
    return;
  }
  for (const target of targets) {
    enqueue(target);
  }
}

/** Builds reverse holder dependencies and direct write expressions across `fn` in a single pass. */
export function holderGraphIn(fn: Node, writtenBy: WrittenBy): HolderGraph {
  const graph: MutableHolderGraph = {
    aliases: new Map(),
    fn,
    memberHolders: new Map(),
    reverseHolders: new Map(),
    writes: new Map(),
    writtenBy,
  };
  const visit = (node: Node): void => {
    recordNodeHolders(node, graph);
    node.forEachChild(visit);
  };
  visit(fn);
  return graph;
}

/** Records alias, reverse-holder, and write-value edges contributed by `node` within `graph.fn`. */
function recordNodeHolders(node: Node, graph: MutableHolderGraph): void {
  if (isVariableDeclaration(node) && isWithin(node, graph.fn) && node.initializer !== undefined) {
    linkDirectAlias(node, node.initializer, graph);
    linkReverseEdges([node], [node.initializer], graph.reverseHolders);
    return;
  }
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
    const holder = localIdentifierOwner(node.left, graph.fn);
    if (holder !== undefined) {
      linkDirectAlias(holder, node.right, graph);
    }
  }
  if (!isBinaryExpression(node) && !isCallExpression(node)) {
    return;
  }
  const direct = localWrittenDeclarations(node, graph.fn, graph.writtenBy);
  if (direct.length === 0) {
    return;
  }
  const sources = isBinaryExpression(node) ? [node.right] : writtenCallValues(node);
  recordDirectWrites(direct, sources, graph.writes);
  const rebindsOnly =
    isBinaryExpression(node) &&
    targetsOf(node.left).every((target) => localIdentifierOwner(target, graph.fn) !== undefined);
  linkReverseEdges(direct, sources, rebindsOnly ? graph.reverseHolders : graph.memberHolders);
}

/** Records a direct local identifier-to-identifier alias edge (`const alias = args`, `alias = args`). */
function linkDirectAlias(holder: Declared, source: Expression, graph: MutableHolderGraph): void {
  const origin = localIdentifierOwner(unwrapped(source), graph.fn);
  if (origin === undefined || origin === holder) {
    return;
  }
  addReverseEdge(graph.aliases, holder, origin);
}

/** Resolves a direct identifier node (past type wrappers) to a declaration within `fn`. */
function localIdentifierOwner(node: Node, fn: Node): Declared | undefined {
  let plain = node;
  while (isTypeWrapper(plain)) plain = plain.expression;
  const owner = isIdentifier(plain) && readsBinding(plain) ? declarationOf(plain) : undefined;
  return owner !== undefined && isWithin(owner, fn) ? owner : undefined;
}

/** Deduplicated declarations within `fn` mutated by `node` across primary and argument slots. */
function localWrittenDeclarations(node: Node, fn: Node, writtenBy: WrittenBy): readonly Declared[] {
  const written = writtenBy(node);
  const changed =
    written === undefined ? writtenArgumentBy(node) : [written, ...writtenArgumentBy(node)];
  const seen = new Set<Declared>();
  const targets = changed.flatMap((each) => targetsOf(each));
  for (const target of targets) {
    const root = rootOf(target);
    const owner = root === undefined ? undefined : declarationOf(root);
    if (owner !== undefined && isWithin(owner, fn)) {
      seen.add(owner);
    }
  }
  return [...seen];
}

/** Appends `sources` to each mutated declaration's write-expression list. */
function recordDirectWrites(
  owners: readonly Declared[],
  sources: readonly Expression[],
  writes: Map<Declared, Expression[]>,
): void {
  if (sources.length === 0) {
    return;
  }
  for (const owner of owners) {
    const existing = writes.get(owner);
    if (existing === undefined) {
      writes.set(owner, [...sources]);
    } else {
      existing.push(...sources);
    }
  }
}

/** Resolves carrier declarations in `sources` once and links each carried declaration to `holders`. */
function linkReverseEdges(
  holders: readonly Declared[],
  sources: readonly Expression[],
  edges: Map<Declared, Set<Declared>>,
): void {
  if (holders.length === 0 || sources.length === 0) {
    return;
  }
  const carriedOwners = carriedDeclarations(sources);
  for (const carried of carriedOwners) {
    for (const holder of holders) {
      if (holder !== carried) {
        addReverseEdge(edges, carried, holder);
      }
    }
  }
}

/** Inserts `target` into the adjacency set for `key` in `edges`. */
function addReverseEdge(
  edges: Map<Declared, Set<Declared>>,
  key: Declared,
  target: Declared,
): void {
  const existing = edges.get(key);
  if (existing === undefined) {
    edges.set(key, new Set([target]));
  } else {
    existing.add(target);
  }
}

/** Declarations of bindings carried directly or inside literal/branch containers of `sources`. */
function carriedDeclarations(sources: readonly Expression[]): ReadonlySet<Declared> {
  const owners = new Set<Declared>();
  const stack: Expression[] = [...sources];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    const value = unwrapped(current);
    if (isIdentifier(value)) {
      const owner = readsBinding(value) ? declarationOf(value) : undefined;
      if (owner !== undefined) {
        owners.add(owner);
      }
      continue;
    }
    pushCarrierChildren(value, stack);
  }
  return owners;
}

/** Pushes direct container or branch child expressions onto `stack` without entering code bodies. */
function pushCarrierChildren(value: Expression, stack: Expression[]): void {
  if (isArrayLiteralExpression(value)) {
    for (const element of value.elements) {
      stack.push(isSpreadElement(element) ? element.expression : element);
    }
    return;
  }
  if (isObjectLiteralExpression(value)) {
    for (const property of value.properties) {
      pushPropertyCarrier(property, stack);
    }
    return;
  }
  if (isConditionalExpression(value)) {
    stack.push(value.whenTrue, value.whenFalse);
    return;
  }
  if (isBinaryExpression(value) && CARRIER_OPERATORS.has(value.operatorToken.kind)) {
    stack.push(value.left, value.right);
  }
}

/** Pushes the value expression of an object-literal property or spread onto `stack`. */
function pushPropertyCarrier(property: ObjectLiteralElementLike, stack: Expression[]): void {
  if (isPropertyAssignment(property)) {
    stack.push(property.initializer);
    return;
  }
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    stack.push(property.name);
    return;
  }
  if (isSpreadAssignment(property)) {
    stack.push(property.expression);
  }
}
