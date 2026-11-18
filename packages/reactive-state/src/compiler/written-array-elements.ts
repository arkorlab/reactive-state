import {
  type ArrayLiteralExpression,
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type ForInOrOfStatement,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isVariableDeclarationList,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { assignmentPatternDefault } from './framed-assignment-patterns.ts';
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
  type ArrayHolder,
  arrayHolderOf,
  canonicalHoldersOf,
  classifyArrayKey,
  directArrayIdentifier,
  ensureHolderWrites,
  type HolderArrayWrites,
  LENGTH_KEY,
  markHoldersShortened,
  type ModuleArrayWrites,
  plainTarget,
  recordOwnersWrite,
} from './written-array-aliases.ts';
import {
  drainGlobalArrayWrites,
  isGlobalArrayWriter,
  type PendingGlobalWrite,
} from './written-array-descriptors.ts';
import {
  collectDirectAliases,
  collectPatternTargets,
  type PatternTarget,
} from './written-pattern-aliases.ts';

/**
 * Per-module index of in-place array element assignments, destructuring/`for..of` reassignments,
 * appended elements, global descriptor/property writers, and reordering/shortening mutator calls.
 */

interface MutatorSite {
  readonly call: CallExpression;
  readonly receiver: Expression;
}

const ARRAY_WRITES = new WeakMap<SourceFile, ModuleArrayWrites>();
const SPLICE_FIRST_INSERT_INDEX = 2;
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

/** Looks up recorded array mutations for `ident`'s canonical lexical/hoisted binding. */
export function holderWritesOf(ident: Identifier): HolderArrayWrites | undefined {
  const holder = arrayHolderOf(ident);
  return holder === undefined ? undefined : moduleArrayWrites(ident.getSourceFile()).get(holder);
}

/** Indexes in-place element writes, mutators and global writers once per `SourceFile`. */
export function moduleArrayWrites(file: SourceFile): ModuleArrayWrites {
  const cached = ARRAY_WRITES.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const aliases = collectDirectAliases(file);
  const byHolder = new Map<ArrayHolder, HolderArrayWrites>();
  const globalCalls: PendingGlobalWrite[] = [];
  const pending: Node[] = [file];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    indexArrayWriteNode(current, aliases, byHolder, globalCalls);
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  for (const entry of byHolder.values()) {
    entry.pushCalls.sort(
      (left, right) => left.call.end - right.call.end || left.call.pos - right.call.pos,
    );
  }
  if (globalCalls.length > 0) {
    drainGlobalArrayWrites(globalCalls, aliases, byHolder);
  }
  ARRAY_WRITES.set(file, byHolder);
  return byHolder;
}

/** Records assignments, iteration targets, length updates, deletions and mutator/global calls. */
function indexArrayWriteNode(
  node: Node,
  aliases: AliasLinks,
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
  globalCalls: PendingGlobalWrite[],
): void {
  if (
    isBinaryExpression(node) &&
    ASSIGNING_OPERATORS.has(node.operatorToken.kind) &&
    !assignmentPatternDefault(node)
  ) {
    indexAssignmentWrite(node, aliases, byHolder);
    return;
  }
  if (isForOfStatement(node) || isForInStatement(node)) {
    indexIterationWrite(node, aliases, byHolder);
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
    indexCallWrite(node, aliases, byHolder, globalCalls);
  }
}

/** Marks `reassigned` or element/length writes on `for (target of ...)` and `for (target in ...)`. */
function indexIterationWrite(
  node: ForInOrOfStatement,
  aliases: AliasLinks,
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): void {
  if (isVariableDeclarationList(node.initializer) || !isExpression(node.initializer)) {
    return;
  }
  for (const target of collectPatternTargets(node.initializer)) {
    recordTargetExpressionWrite(
      target,
      { indexFallbackSpread: isForOfStatement(node), rhs: node.expression },
      aliases,
      byHolder,
    );
  }
}

/** Marks `shortened` when `++`/`--` targets `.length` or a bracket key that may be `'length'`. */
function indexLengthUpdateWrite(
  operand: Expression,
  aliases: AliasLinks,
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
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

/** Records direct or destructuring `holder = ...`, `.length` resets and `holder[index] = ...`. */
function indexAssignmentWrite(
  node: BinaryExpression,
  aliases: AliasLinks,
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): void {
  const left = unwrapped(node.left);
  if (node.operatorToken.kind !== SyntaxKind.EqualsToken || isElementAccessExpression(left)) {
    recordDirectTargetWrite(left, node.right, aliases, byHolder);
    return;
  }
  const patternTargets = collectPatternTargets(left);
  if (
    patternTargets.length === 1 &&
    patternTargets[0] !== undefined &&
    !patternTargets[0].arrayRest &&
    patternTargets[0].expression === left
  ) {
    recordDirectTargetWrite(left, node.right, aliases, byHolder);
    return;
  }
  for (const target of patternTargets) {
    recordTargetExpressionWrite(
      target,
      { indexFallbackSpread: false, rhs: node.right },
      aliases,
      byHolder,
    );
  }
}

/** Records a direct non-destructured LHS target (`id`, `holder.length`, `holder[key]`). */
function recordDirectTargetWrite(
  left: Expression,
  rhs: Expression,
  aliases: AliasLinks,
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): void {
  const direct = directArrayIdentifier(left);
  if (direct !== undefined) {
    const selfHolder = arrayHolderOf(direct);
    if (selfHolder !== undefined) {
      ensureHolderWrites(byHolder, selfHolder).reassigned = true;
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
    recordOwnersWrite(owners, { index: keyInfo.index, spread: false, value: rhs }, byHolder);
  }
}

/** Records a leaf target inside a destructuring assignment or `for..in`/`for..of` header. */
function recordTargetExpressionWrite(
  target: PatternTarget,
  source: { readonly indexFallbackSpread: boolean; readonly rhs: Expression },
  aliases: AliasLinks,
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): void {
  const expr = target.expression;
  const direct = directArrayIdentifier(expr);
  if (direct !== undefined) {
    const selfHolder = arrayHolderOf(direct);
    if (selfHolder !== undefined) {
      ensureHolderWrites(byHolder, selfHolder).reassigned = true;
      if (target.arrayRest) {
        recordOwnersWrite(
          [selfHolder],
          { index: undefined, spread: true, value: source.rhs },
          byHolder,
        );
      }
    }
    return;
  }
  if (isPropertyAccessExpression(expr) && expr.name.text === LENGTH_KEY) {
    markHoldersShortened(canonicalHoldersOf(expr.expression, aliases), byHolder);
    return;
  }
  if (!isElementAccessExpression(expr)) {
    return;
  }
  const owners = canonicalHoldersOf(expr.expression, aliases);
  const keyInfo = classifyArrayKey(expr.argumentExpression);
  if (keyInfo.mayBeLength) {
    markHoldersShortened(owners, byHolder);
  }
  if (keyInfo.mayBeIndex) {
    recordOwnersWrite(
      owners,
      { index: undefined, spread: source.indexFallbackSpread, value: source.rhs },
      byHolder,
    );
  }
}

/** Queues global writers for fixpoint resolution and indexes direct/borrowed array mutator calls. */
function indexCallWrite(
  call: CallExpression,
  aliases: AliasLinks,
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
  globalCalls: PendingGlobalWrite[],
): void {
  const globalCall = globalCallOf(call);
  if (globalCall !== undefined && isGlobalArrayWriter(globalCall.path)) {
    globalCalls.push({ given: globalCall.given, path: globalCall.path });
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
    for (const slot of slotArguments(given, 0)) {
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
    if (
      (shifted || index >= SPLICE_FIRST_INSERT_INDEX) &&
      current.expression.kind !== SyntaxKind.OmittedExpression
    ) {
      entry.indexedWrites.push({ index: undefined, spread: false, value: current.expression });
    }
    index += 1;
  }
}

export {
  type ArrayHolder,
  directArrayIdentifier,
  type HolderArrayWrites,
  type HolderPushCall,
  type IndexedElementWrite,
  type ModuleArrayWrites,
} from './written-array-aliases.ts';
