import {
  type ArrayLiteralExpression,
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { unmutatedTuple } from './tuple-spreads.ts';
import {
  asCallArguments,
  type CallArgument,
  globalCallOf,
  lentMethodOf,
  memberNameOf,
  slotArguments,
} from './written-arguments.ts';
import {
  ALIAS_ASSIGNMENT_OPERATORS,
  type AliasLinks,
  canonicalHoldersOf,
  classifyArrayKey,
  classifyKeySlots,
  collectDirectAliases,
  collectSlotHolders,
  directArrayIdentifier,
  LENGTH_KEY,
  plainTarget,
} from './written-array-aliases.ts';

/**
 * Per-module index of in-place array element assignments, appended elements, and reordering or
 * shortening mutator calls on local array holders and their direct or branched aliases.
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
const REFLECT_SLOTS = { key: 1, receiver: 3, target: 0, value: 2 } as const;
const ASSIGNING_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  ...ALIAS_ASSIGNMENT_OPERATORS,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.SlashEqualsToken,
]);
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
    entry.pushCalls.sort(
      (left, right) => left.call.end - right.call.end || left.call.pos - right.call.pos,
    );
  }
  ARRAY_WRITES.set(file, byHolder);
  return byHolder;
}

/** Records direct assignments, length updates, deletions, reflected writes and mutator calls. */
function indexArrayWriteNode(
  node: Node,
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  if (isBinaryExpression(node) && ASSIGNING_OPERATORS.has(node.operatorToken.kind)) {
    indexAssignmentWrite(node, aliases, byHolder);
    return;
  }
  if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken)
  ) {
    indexLengthUpdateWrite(node.operand, aliases, byHolder);
    return;
  }
  if (isDeleteExpression(node)) {
    const target = plainTarget(node.expression);
    if (isElementAccessExpression(target)) {
      markHoldersShortened(canonicalHoldersOf(target.expression, aliases), byHolder);
    }
    return;
  }
  if (isCallExpression(node)) {
    indexCallWrite(node, aliases, byHolder);
  }
}

/** Marks `shortened` when `++`/`--` targets `.length` or a bracket key that may be `'length'`. */
function indexLengthUpdateWrite(
  operand: Expression,
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  const target = plainTarget(operand);
  if (isPropertyAccessExpression(target) && target.name.text === LENGTH_KEY) {
    markHoldersShortened(canonicalHoldersOf(target.expression, aliases), byHolder);
    return;
  }
  if (
    isElementAccessExpression(target) &&
    classifyArrayKey(target.argumentExpression).mayBeLength
  ) {
    markHoldersShortened(canonicalHoldersOf(target.expression, aliases), byHolder);
  }
}

/** Records `holder = ...`, `holder.length = ...`, `holder['length'] = ...` and `holder[index] = ...`. */
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
  if (isPropertyAccessExpression(left) && left.name.text === LENGTH_KEY) {
    markHoldersShortened(canonicalHoldersOf(left.expression, aliases), byHolder);
    return;
  }
  if (!isElementAccessExpression(left)) {
    return;
  }
  const owners = canonicalHoldersOf(left.expression, aliases);
  const keyInfo = classifyArrayKey(left.argumentExpression);
  if (keyInfo.mayBeLength) {
    markHoldersShortened(owners, byHolder);
  }
  if (keyInfo.mayBeIndex) {
    for (const owner of owners) {
      ensureHolderWrites(byHolder, owner).indexedWrites.push({
        index: keyInfo.index,
        spread: false,
        value: node.right,
      });
    }
  }
}

/** Records global property/element writers, borrowed/bound mutators and direct array mutator calls. */
function indexCallWrite(
  call: CallExpression,
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  const globalCall = globalCallOf(call);
  if (
    globalCall !== undefined &&
    indexGlobalArrayWrite(globalCall.path, globalCall.given, aliases, byHolder)
  ) {
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

/** Handles `Reflect.set`, `Object.defineProperty`, `Reflect.defineProperty` and related global writers. */
function indexGlobalArrayWrite(
  path: string,
  given: readonly CallArgument[],
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): boolean {
  if (path === 'Reflect.set') {
    indexReflectSetWrite(given, aliases, byHolder);
    return true;
  }
  if (path === 'Object.defineProperty' || path === 'Reflect.defineProperty') {
    indexDefinePropertyWrite(given, aliases, byHolder);
    return true;
  }
  if (path === 'Reflect.deleteProperty' || path === 'Object.defineProperties') {
    markHoldersShortened(collectSlotHolders(given, [REFLECT_SLOTS.target], aliases), byHolder);
    return true;
  }
  if (path === 'Object.assign') {
    indexObjectAssignWrite(given, aliases, byHolder);
    return true;
  }
  return false;
}

/** Records `Reflect.set` element writes and `'length'` resets on both `target` and 4th-slot `receiver`. */
function indexReflectSetWrite(
  given: readonly CallArgument[],
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  const owners = collectSlotHolders(given, [REFLECT_SLOTS.target, REFLECT_SLOTS.receiver], aliases);
  if (owners.length === 0) {
    return;
  }
  const keyInfo = classifyKeySlots(slotArguments(given, REFLECT_SLOTS.key));
  if (keyInfo.mayBeLength) {
    markHoldersShortened(owners, byHolder);
  }
  if (!keyInfo.mayBeIndex) {
    return;
  }
  const valueSlots = slotArguments(given, REFLECT_SLOTS.value);
  for (const valueSlot of valueSlots) {
    for (const owner of owners) {
      ensureHolderWrites(byHolder, owner).indexedWrites.push({
        index: valueSlot.spread ? undefined : keyInfo.index,
        spread: valueSlot.spread,
        value: valueSlot.expression,
      });
    }
  }
}

/** Records `Object.defineProperty` / `Reflect.defineProperty` `'length'` resets and data values. */
function indexDefinePropertyWrite(
  given: readonly CallArgument[],
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  const owners = collectSlotHolders(given, [REFLECT_SLOTS.target], aliases);
  if (owners.length === 0) {
    return;
  }
  const keyInfo = classifyKeySlots(slotArguments(given, REFLECT_SLOTS.key));
  if (keyInfo.mayBeLength) {
    markHoldersShortened(owners, byHolder);
  }
  if (!keyInfo.mayBeIndex) {
    return;
  }
  const descriptorSlots = slotArguments(given, REFLECT_SLOTS.value);
  for (const descSlot of descriptorSlots) {
    if (descSlot.spread) {
      continue;
    }
    const values = framedObjectSources(descSlot.expression, ['value']) ?? [];
    for (const entry of values) {
      if (entry.keys.length === 0) {
        for (const owner of owners) {
          ensureHolderWrites(byHolder, owner).indexedWrites.push({
            index: keyInfo.index,
            spread: false,
            value: entry.value,
          });
        }
      }
    }
  }
}

/** Records `Object.assign(holder, ...sources)` length invalidations and copied source spreads. */
function indexObjectAssignWrite(
  given: readonly CallArgument[],
  aliases: AliasLinks,
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  const owners = collectSlotHolders(given, [REFLECT_SLOTS.target], aliases);
  if (owners.length === 0) {
    return;
  }
  markHoldersShortened(owners, byHolder);
  if (given[0]?.spread === false) {
    for (const sourceArg of given.slice(1)) {
      for (const owner of owners) {
        ensureHolderWrites(byHolder, owner).indexedWrites.push({
          index: undefined,
          spread: true,
          value: sourceArg.expression,
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

/** Marks every holder in `owners` as potentially shortened or length-invalidated. */
function markHoldersShortened(
  owners: readonly FrameDeclaration[],
  byHolder: Map<FrameDeclaration, HolderArrayWrites>,
): void {
  for (const owner of owners) {
    ensureHolderWrites(byHolder, owner).shortened = true;
  }
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

export { directArrayIdentifier } from './written-array-aliases.ts';
