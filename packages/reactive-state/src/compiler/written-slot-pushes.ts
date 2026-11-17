import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBlock,
  isDoStatement,
  isElementAccessExpression,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isPropertyAccessExpression,
  isSourceFile,
  isVariableDeclaration,
  isVariableDeclarationList,
  isWhileStatement,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { executionOwner } from './framed-array-mutations.ts';
import {
  type FrameDeclaration,
  type FrameSelection,
  frameDeclarationOf,
} from './framed-bindings.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { framedPatternDefaults } from './framed-pattern-defaults.ts';
import { isBlockScoped, readsBinding } from './scope.ts';
import { constInitializerOf, unmutatedTuple } from './tuple-spreads.ts';
import {
  asCallArguments,
  branchOperands,
  type CallArgument,
  slotArguments,
} from './written-arguments.ts';
import {
  directArrayIdentifier,
  type HolderArrayWrites,
  type HolderPushCall,
  type IndexedElementWrite,
} from './written-array-elements.ts';

/**
 * Destructured array-holder initializers, positional `[min, max]` slot-interval push tracking, and
 * branch operand helpers for `written-slot-targets.ts`.
 */

export interface SpreadWork {
  readonly expression: Expression;
  readonly held: boolean;
  readonly maxOffset: number;
  readonly minOffset: number;
  readonly reordered: boolean;
}

export interface HolderWriteSink {
  readonly onPositional: (expression: Expression) => void;
  readonly pending: SpreadWork[];
}

export interface HolderBindingContext {
  readonly ident: Identifier;
  readonly initialValues: readonly Expression[];
  readonly owner: FrameDeclaration | undefined;
  readonly selected: FrameSelection | undefined;
}

interface LengthBounds {
  readonly max: number;
  readonly min: number;
}

/** Resolves a lexical or hoisted binding's initializer and pattern defaults along `selected.keys`. */
export function selectedInitialExpressions(
  ident: Identifier,
  selected: FrameSelection,
): readonly Expression[] {
  const results: Expression[] = [];
  const defaults = framedPatternDefaults(ident, selected.binding);
  if (defaults !== undefined) {
    results.push(...defaults);
  }
  if (selected.binding.initializer !== undefined) {
    results.push(...projectMemberKeys(selected.binding.initializer, selected.keys));
  }
  return results;
}

/** Projects `root` along a destructured object or tuple key path when statically structured. */
export function projectMemberKeys(
  root: Expression,
  keys: readonly string[],
): readonly Expression[] {
  let current: readonly Expression[] = [root];
  for (const key of keys) {
    const next: Expression[] = [];
    for (const candidate of current) {
      next.push(...projectSingleKey(candidate, key, new Set()));
    }
    current = next;
  }
  return current;
}

/** Projects one member or tuple index `key` through branches, `const` aliases and literals. */
function projectSingleKey(
  expression: Expression,
  key: string,
  seen: Set<Expression>,
): readonly Expression[] {
  const plain = unwrapped(expression);
  if (seen.has(plain)) {
    return [];
  }
  seen.add(plain);
  const branches = branchOperands(plain);
  if (branches !== undefined) {
    return branches.flatMap((branch) => projectSingleKey(branch, key, seen));
  }
  if (isIdentifier(plain) && readsBinding(plain)) {
    const initial = constInitializerOf(plain);
    return initial === undefined ? [] : projectSingleKey(initial, key, seen);
  }
  if (isArrayLiteralExpression(plain) && /^(?:0|[1-9]\d*)$/u.test(key)) {
    return slotArguments(asCallArguments(plain.elements), Number(key))
      .filter((slot) => !slot.spread)
      .map((slot) => slot.expression);
  }
  const objectSources = framedObjectSources(plain, [key]);
  if (objectSources === undefined) {
    return [];
  }
  return objectSources.filter((entry) => entry.keys.length === 0).map((entry) => entry.value);
}

/** Collects in-place slot assignments and slot-aligned appended elements recorded against `owner`. */
export function applyHolderWrites(
  writes: HolderArrayWrites,
  binding: HolderBindingContext,
  work: SpreadWork,
  sink: HolderWriteSink,
): void {
  const unordered = work.reordered || writes.reassigned || writes.shortened;
  for (const entry of writes.indexedWrites) {
    const matches =
      unordered ||
      entry.index === undefined ||
      (entry.index >= work.minOffset && entry.index <= work.maxOffset);
    if (matches) {
      collectElementOrSpread(entry, sink);
    }
  }
  if (unordered) {
    for (const pushCall of writes.pushCalls) {
      for (const arg of pushCall.args) {
        collectElementOrSpread(
          { index: undefined, spread: arg.spread, value: arg.expression },
          sink,
        );
      }
    }
    return;
  }
  collectAlignedPushes(writes, binding, work, sink);
}

/** Collects a written element expression or queues a spread argument from `push`/`unshift`/`splice`. */
function collectElementOrSpread(entry: IndexedElementWrite, sink: HolderWriteSink): void {
  if (entry.spread) {
    sink.pending.push({
      expression: entry.value,
      held: true,
      maxOffset: Number.MAX_SAFE_INTEGER,
      minOffset: 0,
      reordered: true,
    });
  } else {
    sink.onPositional(entry.value);
  }
}

/** Walks post-ordered `writes.pushCalls` tracking `[min, max]` slot offsets across pushes. */
function collectAlignedPushes(
  writes: HolderArrayWrites,
  binding: HolderBindingContext,
  work: SpreadWork,
  sink: HolderWriteSink,
): void {
  const start = initialPushBounds(writes, binding);
  const holderOwner = binding.owner === undefined ? undefined : executionOwner(binding.owner);
  let curMin = start.min;
  let curMax = writes.pushCalls.some((pushCall) => isRepeatablePush(pushCall.call, binding.owner))
    ? Number.MAX_SAFE_INTEGER
    : start.max;
  for (const pushCall of writes.pushCalls) {
    const sameOwner = holderOwner !== undefined && executionOwner(pushCall.call) === holderOwner;
    const callBase: LengthBounds = sameOwner
      ? { max: curMax, min: curMin }
      : { max: Number.MAX_SAFE_INTEGER, min: start.min };
    const delta = collectSinglePushCall(pushCall.args, callBase, work, sink);
    curMax = satAdd(curMax, delta.max);
    if (sameOwner && isDefinitePushBefore(pushCall, binding.owner, binding.ident)) {
      curMin = satAdd(curMin, delta.min);
    }
  }
}

/** Collects matching positional/spread arguments of a single `push(...)` call at `base` bounds. */
function collectSinglePushCall(
  args: readonly CallArgument[],
  base: LengthBounds,
  work: SpreadWork,
  sink: HolderWriteSink,
): LengthBounds {
  const stack = args.toReversed();
  const seen = new Set<ArrayLiteralExpression>();
  let callMin = 0;
  let callMax = 0;
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current.spread) {
      callMax = stepSinglePushSpread(current.expression, { base, callMax, callMin, work }, seen, {
        sink,
        stack,
      });
      continue;
    }
    const slotMin = satAdd(base.min, callMin);
    const slotMax = satAdd(base.max, callMax);
    if (
      slotMin <= work.maxOffset &&
      slotMax >= work.minOffset &&
      current.expression.kind !== SyntaxKind.OmittedExpression
    ) {
      sink.onPositional(current.expression);
    }
    callMin += 1;
    callMax = satAdd(callMax, 1);
  }
  return { max: callMax, min: callMin };
}

/** Expands a clean tuple spread in `push` or queues a bounded-offset spread candidate. */
function stepSinglePushSpread(
  expression: Expression,
  cursor: {
    readonly base: LengthBounds;
    readonly callMax: number;
    readonly callMin: number;
    readonly work: SpreadWork;
  },
  seen: Set<ArrayLiteralExpression>,
  queues: { readonly sink: HolderWriteSink; readonly stack: CallArgument[] },
): number {
  const tuple = unmutatedTuple(expression);
  if (tuple !== undefined && !seen.has(tuple)) {
    seen.add(tuple);
    queues.stack.push(...asCallArguments(tuple.elements).toReversed());
    return cursor.callMax;
  }
  const startMin = satAdd(cursor.base.min, cursor.callMin);
  const startMax = satAdd(cursor.base.max, cursor.callMax);
  if (startMin <= cursor.work.maxOffset) {
    const subMin =
      startMax >= Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, cursor.work.minOffset - startMax);
    queues.sink.pending.push({
      expression,
      held: true,
      maxOffset: cursor.work.maxOffset - startMin,
      minOffset: subMin,
      reordered: false,
    });
  }
  return Number.MAX_SAFE_INTEGER;
}

/** Length `[min, max]` of `binding` prior to `push` calls, accounting for `indexedWrites`. */
function initialPushBounds(
  writes: HolderArrayWrites,
  binding: {
    readonly ident: Identifier;
    readonly initialValues: readonly Expression[];
    readonly selected: FrameSelection | undefined;
  },
): LengthBounds {
  const decl = binding.selected?.binding;
  const guaranteed =
    decl !== undefined &&
    isVariableDeclaration(decl) &&
    binding.initialValues.length === 1 &&
    unconditionalInitializerBefore(decl, binding.ident);
  const initialArray =
    guaranteed && binding.initialValues[0] !== undefined
      ? unwrapped(binding.initialValues[0])
      : undefined;
  const base =
    initialArray !== undefined && isArrayLiteralExpression(initialArray)
      ? arrayLiteralLengthBounds(initialArray)
      : { max: Number.MAX_SAFE_INTEGER, min: 0 };
  let max = base.max;
  for (const entry of writes.indexedWrites) {
    if (entry.index === undefined) {
      max = Number.MAX_SAFE_INTEGER;
    } else if (max < Number.MAX_SAFE_INTEGER) {
      max = Math.max(max, entry.index + 1);
    }
  }
  return { max, min: base.min };
}

/** Exact `[min, max]` element count of `arrayNode`, expanding nested unchanged tuple spreads. */
function arrayLiteralLengthBounds(arrayNode: ArrayLiteralExpression): LengthBounds {
  const stack = asCallArguments(arrayNode.elements).toReversed();
  const seen = new Set<ArrayLiteralExpression>([arrayNode]);
  let min = 0;
  let max = 0;
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current.spread) {
      const tuple = unmutatedTuple(current.expression);
      if (tuple === undefined || seen.has(tuple)) {
        max = Number.MAX_SAFE_INTEGER;
      } else {
        seen.add(tuple);
        stack.push(...asCallArguments(tuple.elements).toReversed());
      }
    } else {
      min += 1;
      max = satAdd(max, 1);
    }
  }
  return { max, min };
}

/** Whether `decl`'s initializer unconditionally runs before `readSite` in the same owner. */
function unconditionalInitializerBefore(decl: VariableDeclaration, readSite: Identifier): boolean {
  if (!isVariableDeclarationList(decl.parent)) {
    return false;
  }
  if (isBlockScoped(decl.parent)) {
    return true;
  }
  const owner = executionOwner(decl);
  if (owner !== executionOwner(readSite) || decl.end > readSite.pos) {
    return false;
  }
  return hasOnlyPlainBlockAncestors(decl.parent.parent, owner);
}

/** Whether `pushCall` can execute more than once relative to `owner` (loop or inner closure). */
function isRepeatablePush(call: Node, owner: FrameDeclaration | undefined): boolean {
  if (owner === undefined) {
    return true;
  }
  const holderOwner = executionOwner(owner);
  if (executionOwner(call) !== holderOwner) {
    return true;
  }
  for (let at: Node = call.parent; at !== holderOwner && !isSourceFile(at); at = at.parent) {
    if (
      isForStatement(at) ||
      isForOfStatement(at) ||
      isForInStatement(at) ||
      isWhileStatement(at) ||
      isDoStatement(at)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether `pushCall` is an unconditional statement directly targeting `owner` before `readSite`. */
function isDefinitePushBefore(
  pushCall: HolderPushCall,
  owner: FrameDeclaration | undefined,
  readSite: Identifier,
): boolean {
  if (
    owner === undefined ||
    !isVariableDeclaration(owner) ||
    !isIdentifier(owner.name) ||
    pushCall.call.end > readSite.pos ||
    hasOptionalPushChain(pushCall.call) ||
    !isExpressionStatement(pushCall.call.parent)
  ) {
    return false;
  }
  const receiverIdent = directArrayIdentifier(pushCall.receiver);
  if (receiverIdent === undefined || frameDeclarationOf(receiverIdent) !== owner) {
    return false;
  }
  const holderOwner = executionOwner(owner);
  return (
    holderOwner === executionOwner(readSite) &&
    executionOwner(pushCall.call) === holderOwner &&
    hasOnlyPlainBlockAncestors(pushCall.call.parent, holderOwner)
  );
}

/** Whether `call` or its member callee may short-circuit through `?.`. */
function hasOptionalPushChain(call: HolderPushCall['call']): boolean {
  if (call.questionDotToken !== undefined) {
    return true;
  }
  const callee = unwrapped(call.expression);
  return (
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
    callee.questionDotToken !== undefined
  );
}

/** True when every ancestor strictly between `statement` and `owner` is a plain `Block`. */
function hasOnlyPlainBlockAncestors(statement: Node, owner: Node): boolean {
  for (let at: Node = statement.parent; at !== owner; at = at.parent) {
    if (isSourceFile(at)) {
      return at === owner;
    }
    if (!isBlock(at)) {
      return false;
    }
  }
  return true;
}

/** Saturating non-negative integer addition capped at `Number.MAX_SAFE_INTEGER`. */
function satAdd(left: number, right: number): number {
  return left >= Number.MAX_SAFE_INTEGER || right >= Number.MAX_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
