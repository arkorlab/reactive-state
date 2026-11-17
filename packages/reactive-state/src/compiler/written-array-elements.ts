import {
  type ArrayLiteralExpression,
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isIdentifier,
  isNonNullExpression,
  isNumericLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
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
import { constInitializerOf, unmutatedTuple } from './tuple-spreads.ts';
import {
  asCallArguments,
  type CallArgument,
  globalCallOf,
  lentMethodOf,
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

export interface HolderPushCall {
  readonly args: readonly CallArgument[];
  readonly call: CallExpression;
  readonly receiver: Expression;
}

export interface HolderArrayWrites {
  readonly indexedWrites: IndexedElementWrite[];
  readonly pushCalls: HolderPushCall[];
  reassigned: boolean;
  reordered: boolean;
  shortened: boolean;
}

export type ModuleArrayWrites = ReadonlyMap<FrameDeclaration, HolderArrayWrites>;

interface MutatorSite {
  readonly call: CallExpression;
  readonly receiver: Expression;
}

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
  for (const entry of byHolder.values()) {
    entry.pushCalls.sort((left, right) => left.call.pos - right.call.pos);
  }
  ARRAY_WRITES.set(file, byHolder);
  return byHolder;
}

/** Direct binding identifier after peeling type casts, parentheses and non-null wrappers. */
export function directArrayIdentifier(node: Node): Identifier | undefined {
  const plain = plainTarget(node);
  return isIdentifier(plain) && readsBinding(plain) ? plain : undefined;
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
    const left = directArrayIdentifier(node.left);
    const holder = left === undefined ? undefined : frameDeclarationOf(left);
    if (holder !== undefined) {
      linkAliasSource(holder, node.right, aliases);
    }
  }
}

/** Adds `rhs` declaration targets (including conditional branches) to `holder`'s alias set. */
function linkAliasSource(
  holder: FrameDeclaration,
  rhs: Expression,
  aliases: Map<FrameDeclaration, Set<FrameDeclaration>>,
): void {
  const plain = unwrapped(rhs);
  if (isConditionalExpression(plain)) {
    linkAliasSource(holder, plain.whenTrue, aliases);
    linkAliasSource(holder, plain.whenFalse, aliases);
    return;
  }
  const sourceIdent = directArrayIdentifier(plain);
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
  const direct = directArrayIdentifier(left);
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

/** Records `Reflect.set`, borrowed/bound mutators and direct mutating array calls on `holder`. */
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
  const lent = lentMethodOf(call);
  if (lent !== undefined) {
    for (const owner of canonicalHoldersOf(lent.receiver, aliases)) {
      indexMethodMutator(lent.method, lent.given, ensureHolderWrites(byHolder, owner), {
        call,
        receiver: lent.receiver,
      });
    }
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
    indexMethodMutator(
      method,
      asCallArguments(call.arguments),
      ensureHolderWrites(byHolder, owner),
      { call, receiver: callee.expression },
    );
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
  const valueSlots = slotArguments(given, 2);
  for (const valueSlot of valueSlots) {
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
  given: readonly CallArgument[],
  entry: HolderArrayWrites,
  site: MutatorSite,
): void {
  if (REORDERING_METHODS.has(method)) {
    entry.reordered = true;
  }
  if (SHORTENING_METHODS.has(method)) {
    entry.shortened = true;
  }
  if (method === 'push') {
    entry.pushCalls.push({ args: given, call: site.call, receiver: site.receiver });
    return;
  }
  if (method === 'unshift') {
    for (const arg of given) {
      entry.indexedWrites.push({ index: undefined, spread: arg.spread, value: arg.expression });
    }
    return;
  }
  if (method === 'splice') {
    recordSpliceInsertions(given, entry);
    return;
  }
  if (method === 'fill') {
    const fillSlots = slotArguments(given, 0);
    for (const slot of fillSlots) {
      entry.indexedWrites.push({ index: undefined, spread: slot.spread, value: slot.expression });
    }
  }
}

/** Records `splice` inserted items from argument index 2 onward, preserving covering spreads. */
function recordSpliceInsertions(given: readonly CallArgument[], entry: HolderArrayWrites): void {
  const stack = given.toReversed();
  const seen = new Set<ArrayLiteralExpression>();
  let index = 0;
  let shifted = false;
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current.spread) {
      const tuple = unmutatedTuple(current.expression);
      if (tuple !== undefined && !seen.has(tuple)) {
        seen.add(tuple);
        stack.push(...asCallArguments(tuple.elements).toReversed());
        continue;
      }
      entry.indexedWrites.push({ index: undefined, spread: true, value: current.expression });
      shifted = true;
      continue;
    }
    if ((shifted || index >= 2) && current.expression.kind !== SyntaxKind.OmittedExpression) {
      entry.indexedWrites.push({ index: undefined, spread: false, value: current.expression });
    }
    index += 1;
  }
}

/** Resolves `node` to its own `FrameDeclaration` plus any transitive alias targets. */
function canonicalHoldersOf(node: Node, aliases: AliasLinks): readonly FrameDeclaration[] {
  const ident = directArrayIdentifier(node);
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
      pushCalls: [],
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
