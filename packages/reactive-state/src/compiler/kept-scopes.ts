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

export interface HolderEdge {
  readonly holders: readonly Declared[];
  readonly sources: readonly Expression[];
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

/** Declarations of root bindings mutated by `node` across primary and argument write slots. */
export function writtenDeclarations(node: Node, writtenBy: WrittenBy): readonly Declared[] {
  const written = writtenBy(node);
  const changed =
    written === undefined ? writtenArgumentBy(node) : [written, ...writtenArgumentBy(node)];
  const found: Declared[] = [];
  for (const target of changed.flatMap((each) => targetsOf(each))) {
    const root = rootOf(target);
    const owner = root === undefined ? undefined : declarationOf(root);
    if (owner !== undefined) {
      found.push(owner);
    }
  }
  return found;
}

/** Local container and alias declarations in `edges` that transitively carry `initial`. */
export function watchedDeclarations(
  initial: Declared,
  edges: readonly HolderEdge[],
): ReadonlySet<Declared> {
  const watched = new Set<Declared>([initial]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (extendWatchedHolders(edge, watched)) {
        changed = true;
      }
    }
  }
  return watched;
}

/** Collects local variable initializers and write sites that store values into local holders. */
export function holderEdgesIn(fn: Node, writtenBy: WrittenBy): readonly HolderEdge[] {
  const aliases = directAliasesIn(fn);
  const edges: HolderEdge[] = [];
  const visit = (node: Node): void => {
    const edge = holderEdgeOf(node, fn, writtenBy, aliases);
    if (edge !== undefined) {
      edges.push(edge);
    }
    node.forEachChild(visit);
  };
  visit(fn);
  return edges;
}

/** Direct local identifier-to-identifier alias links (`const alias = args`, `alias = args`). */
function directAliasesIn(fn: Node): ReadonlyMap<Declared, ReadonlySet<Declared>> {
  const links = new Map<Declared, Set<Declared>>();
  const link = (holder: Declared, source: Expression): void => {
    const origin = localIdentifierOwner(unwrapped(source), fn);
    if (origin === undefined) {
      return;
    }
    const set = links.get(holder) ?? new Set<Declared>();
    set.add(origin);
    links.set(holder, set);
  };
  const visit = (node: Node): void => {
    if (isVariableDeclaration(node) && isWithin(node, fn) && node.initializer !== undefined) {
      link(node, node.initializer);
    } else if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
      const holder = localIdentifierOwner(node.left, fn);
      if (holder !== undefined) {
        link(holder, node.right);
      }
    }
    node.forEachChild(visit);
  };
  visit(fn);
  return links;
}

/** Resolves a direct identifier node (past type wrappers) to a declaration within `fn`. */
function localIdentifierOwner(node: Node, fn: Node): Declared | undefined {
  let plain = node;
  while (isTypeWrapper(plain)) plain = plain.expression;
  const owner = isIdentifier(plain) && readsBinding(plain) ? declarationOf(plain) : undefined;
  return owner !== undefined && isWithin(owner, fn) ? owner : undefined;
}

/** The local holder declaration(s) and source expressions written by `node`, if any. */
function holderEdgeOf(
  node: Node,
  fn: Node,
  writtenBy: WrittenBy,
  aliases: ReadonlyMap<Declared, ReadonlySet<Declared>>,
): HolderEdge | undefined {
  if (isVariableDeclaration(node) && isWithin(node, fn) && node.initializer !== undefined) {
    return { holders: [node], sources: [node.initializer] };
  }
  if (!isBinaryExpression(node) && !isCallExpression(node)) {
    return undefined;
  }
  const direct = writtenDeclarations(node, writtenBy).filter((owner) => isWithin(owner, fn));
  if (direct.length === 0) {
    return undefined;
  }
  const rebindsOnly = isBinaryExpression(node) && localIdentifierOwner(node.left, fn) !== undefined;
  const holders = rebindsOnly ? direct : expandAliasedHolders(direct, aliases);
  const sources = isBinaryExpression(node) ? [node.right] : writtenCallValues(node);
  return { holders, sources };
}

/** Expands member-mutated holders through direct local identifier alias chains. */
function expandAliasedHolders(
  initial: readonly Declared[],
  aliases: ReadonlyMap<Declared, ReadonlySet<Declared>>,
): readonly Declared[] {
  const seen = new Set<Declared>(initial);
  const stack = [...initial];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    for (const target of aliases.get(current) ?? []) {
      if (!seen.has(target)) {
        seen.add(target);
        stack.push(target);
      }
    }
  }
  return [...seen];
}

/** Adds `edge.holders` to `watched` when any of `edge.sources` carries a watched declaration. */
function extendWatchedHolders(edge: HolderEdge, watched: Set<Declared>): boolean {
  const carries = edge.sources.some((source) =>
    valueCarrierIdentifiers(source).some((id) => {
      const owner = declarationOf(id);
      return owner !== undefined && watched.has(owner);
    }),
  );
  if (!carries) {
    return false;
  }
  const before = watched.size;
  for (const holder of edge.holders) {
    watched.add(holder);
  }
  return watched.size > before;
}

/** Binding identifiers carried directly or inside literal/branch containers of `expression`. */
function valueCarrierIdentifiers(expression: Expression): readonly Identifier[] {
  const found: Identifier[] = [];
  const stack: Expression[] = [expression];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    const value = unwrapped(current);
    if (isIdentifier(value)) {
      if (readsBinding(value)) {
        found.push(value);
      }
      continue;
    }
    pushCarrierChildren(value, stack);
  }
  return found;
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
