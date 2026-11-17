import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isIdentifier,
  isNonNullExpression,
  isNumericLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { constantValue } from './numbers.ts';
import { readsBinding } from './scope.ts';
import { constInitializerOf } from './tuple-spreads.ts';
import {
  type CallArgument,
  globalCallOf,
  memberNameOf,
  slotArguments,
} from './written-arguments.ts';

/**
 * Per-module index of in-place array element assignments, appended elements, and reordering or
 * shortening mutator calls on local array holders and their direct aliases.
 */

export interface IndexedElementWrite {
  readonly index: number | undefined;
  readonly spread: boolean;
  readonly value: Expression;
}

export interface HolderArrayWrites {
  readonly indexedWrites: IndexedElementWrite[];
  readonly pushedWrites: IndexedElementWrite[];
  reassigned: boolean;
  reordered: boolean;
  shortened: boolean;
}

export type ModuleArrayWrites = ReadonlyMap<FrameDeclaration, HolderArrayWrites>;

const ARRAY_WRITES = new WeakMap<SourceFile, ModuleArrayWrites>();
const REORDERING_METHODS: ReadonlySet<string> = new Set([
  'copyWithin',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);
const SHORTENING_METHODS: ReadonlySet<string> = new Set(['pop', 'shift', 'splice']);

/** Indexes in-place element writes and array-order mutators once per `SourceFile`. */
export function moduleArrayWrites(file: SourceFile): ModuleArrayWrites {
  const cached = ARRAY_WRITES.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const aliases = collectDirectAliases(file);
  const byHolder = new Map<FrameDeclaration, HolderArrayWrites>();
  const pending: Node[] = [file];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    indexArrayWriteNode(current, aliases, byHolder);
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  ARRAY_WRITES.set(file, byHolder);
  return byHolder;
}

/** Minimum length before any `push` when `holder` starts from a fixed array literal and never shrinks. */
export function floorInitialLength(
  holder: FrameDeclaration | undefined,
  writes: HolderArrayWrites,
): number {
  if (
    holder === undefined ||
    writes.reassigned ||
    writes.reordered ||
    writes.shortened ||
    !isVariableDeclaration(holder) ||
    holder.initializer === undefined
  ) {
    return 0;
  }
  const initial = unwrapped(holder.initializer);
  if (!isArrayLiteralExpression(initial)) {
    return 0;
  }
  let count = 0;
  for (const element of initial.elements) {
    if (!isSpreadElement(element)) {
      count += 1;
    }
  }
  return count;
}

type AliasLinks = ReadonlyMap<FrameDeclaration, ReadonlySet<FrameDeclaration>>;

/** Maps direct variable initializers and reassignments (`alias = args`) to target declarations. */
function collectDirectAliases(file: SourceFile): AliasLinks {
  const aliases = new Map<FrameDeclaration, Set<FrameDeclaration>>();
  const pending: Node[] = [file];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    recordAliasNode(current, aliases);
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  return aliases;
}

/** Links a direct identifier initializer or `=` assignment onto `aliases`. */
function recordAliasNode(node: Node, aliases: Map<FrameDeclaration, Set<FrameDeclaration>>): void {
  if (isVariableDeclaration(node) && node.initializer !== undefined) {
    linkAliasSource(node, node.initializer, aliases);
    return;
  }
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
    const left = directIdentifier(node.left);
    const holder = left === undefined ? undefined : frameDeclarationOf(left);
    if (holder !== undefined) {
      linkAliasSource(holder, node.right, aliases);
    }
  }
}

/** Adds `rhs`'s declaration to `holder`'s alias set when `rhs` is a distinct binding read. */
function linkAliasSource(
  holder: FrameDeclaration,
  rhs: Expression,
  aliases: Map<FrameDeclaration, Set<FrameDeclaration>>,
): void {
  const sourceIdent = directIdentifier(rhs);
  const target = sourceIdent === undefined ? undefined : frameDeclarationOf(sourceIdent);
  if (target === undefined || target === holder) {
    return;
  }
  let linked = aliases.get(holder);
  if (linked === undefined) {
    linked = new Set();
    aliases.set(holder, linked);
  }
  linked.add(target);
}

/** Records direct element assignments, deletions, `Reflect.set` writes and array mutator calls. */
function indexArrayWriteNode(
  node: Node,
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
    indexAssignmentWrite(node, aliases, byHolder);
    return;
  }
  if (isDeleteExpression(node)) {
    const target = plainTarget(node.expression);
    if (isElementAccessExpression(target)) {
      for (const owner of canonicalHoldersOf(target.expression, aliases)) {
        ensureHolderWrites(byHolder, owner).shortened = true;
      }
    }
    return;
  }
  if (isCallExpression(node)) {
    indexCallWrite(node, aliases, byHolder);
  }
}

/** Records `holder = ...`, `holder.length = ...` and `holder[index] = value`. */
function indexAssignmentWrite(
  node: BinaryExpression,
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  const left = plainTarget(node.left);
  const direct = directIdentifier(left);
  if (direct !== undefined) {
    const selfOwner = frameDeclarationOf(direct);
    if (selfOwner !== undefined) {
      ensureHolderWrites(byHolder, selfOwner).reassigned = true;
    }
    return;
  }
  if (isPropertyAccessExpression(left) && left.name.text === 'length') {
    for (const owner of canonicalHoldersOf(left.expression, aliases)) {
      ensureHolderWrites(byHolder, owner).shortened = true;
    }
    return;
  }
  if (isElementAccessExpression(left)) {
    const index = literalSlotIndex(left.argumentExpression);
    for (const owner of canonicalHoldersOf(left.expression, aliases)) {
      ensureHolderWrites(byHolder, owner).indexedWrites.push({
        index,
        spread: false,
        value: node.right,
      });
    }
  }
}

/** Records `Reflect.set(holder, index, value)` and mutating array method calls on `holder`. */
function indexCallWrite(
  call: CallExpression,
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  const globalCall = globalCallOf(call);
  if (globalCall?.path === 'Reflect.set') {
    indexReflectSetWrite(globalCall.given, aliases, byHolder);
    return;
  }
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return;
  }
  const method = memberNameOf(callee);
  if (method === undefined) {
    return;
  }
  for (const owner of canonicalHoldersOf(callee.expression, aliases)) {
    indexMethodMutator(method, call.arguments, ensureHolderWrites(byHolder, owner));
  }
}

/** Records positional `Reflect.set(holder, index, value)` element writes without confusing spreads. */
function indexReflectSetWrite(
  given: readonly CallArgument[],
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  const targetSlot = slotArguments(given, 0)[0];
  if (targetSlot === undefined || targetSlot.spread) {
    return;
  }
  const owners = canonicalHoldersOf(targetSlot.expression, aliases);
  if (owners.length === 0) {
    return;
  }
  const keySlot = slotArguments(given, 1)[0];
  const index =
    keySlot === undefined || keySlot.spread ? undefined : literalSlotIndex(keySlot.expression);
  for (const valueSlot of slotArguments(given, 2)) {
    if (!valueSlot.spread) {
      for (const owner of owners) {
        ensureHolderWrites(byHolder, owner).indexedWrites.push({
          index,
          spread: false,
          value: valueSlot.expression,
        });
      }
    }
  }
}

/** Records `push`, `unshift`, `splice`, `fill` and reordering/shortening method effects on `entry`. */
function indexMethodMutator(
  method: string,
  args: readonly Expression[],
  entry: HolderArrayWrites,
): void {
  if (REORDERING_METHODS.has(method)) {
    entry.reordered = true;
  }
  if (SHORTENING_METHODS.has(method)) {
    entry.shortened = true;
  }
  if (method === 'push') {
    for (const arg of args) {
      entry.pushedWrites.push(asIndexedWrite(arg));
    }
    return;
  }
  if (method === 'unshift') {
    for (const arg of args) {
      entry.indexedWrites.push(asIndexedWrite(arg));
    }
    return;
  }
  if (method === 'splice') {
    for (const arg of args.slice(2)) {
      entry.indexedWrites.push(asIndexedWrite(arg));
    }
    return;
  }
  if (method === 'fill' && args[0] !== undefined) {
    entry.indexedWrites.push(asIndexedWrite(args[0]));
  }
}

/** Converts a mutator call argument into an `IndexedElementWrite` descriptor. */
function asIndexedWrite(arg: Expression): IndexedElementWrite {
  return isSpreadElement(arg)
    ? { index: undefined, spread: true, value: arg.expression }
    : { index: undefined, spread: false, value: arg };
}

/** Resolves `node` to its own `FrameDeclaration` plus any transitive alias targets. */
function canonicalHoldersOf(node: Node, aliases: AliasLinks): readonly FrameDeclaration[] {
  const ident = directIdentifier(node);
  const root = ident === undefined ? undefined : frameDeclarationOf(ident);
  if (root === undefined) {
    return [];
  }
  const seen = new Set<FrameDeclaration>([root]);
  const queue: FrameDeclaration[] = [root];
  for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
    const linked = aliases.get(current);
    if (linked === undefined) {
      continue;
    }
    for (const next of linked) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

/** Returns or creates the mutable `HolderArrayWrites` bucket for `owner`. */
function ensureHolderWrites(
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
  owner: FrameDeclaration,
): HolderArrayWrites {
  let entry = byHolder.get(owner);
  if (entry === undefined) {
    entry = {
      indexedWrites: [],
      pushedWrites: [],
      reassigned: false,
      reordered: false,
      shortened: false,
    };
    byHolder.set(owner, entry);
  }
  return entry;
}

/** Non-negative safe integer index denoted by `node`, or `undefined` when dynamic or non-index. */
function literalSlotIndex(node: Expression): number | undefined {
  const plain = unwrapped(node);
  if (isNumericLiteral(plain) || isStringLiteral(plain)) {
    const parsed = Number(plain.text);
    return /^(?:0|[1-9]\d*)$/u.test(plain.text) && Number.isSafeInteger(parsed)
      ? parsed
      : undefined;
  }
  const evaluated = constantValue(plain, constInitializerOf);
  return typeof evaluated === 'number' && Number.isSafeInteger(evaluated) && evaluated >= 0
    ? evaluated
    : undefined;
}

/** Direct binding identifier after peeling type casts, parentheses and non-null wrappers. */
function directIdentifier(node: Node): Identifier | undefined {
  const plain = plainTarget(node);
  return isIdentifier(plain) && readsBinding(plain) ? plain : undefined;
}

/** Peels parentheses, `as`, `satisfies` and `!` wrappers off `node`. */
function plainTarget(node: Node): Node {
  let current = node;
  while (
    isParenthesizedExpression(current) ||
    isAsExpression(current) ||
    isSatisfiesExpression(current) ||
    isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}
