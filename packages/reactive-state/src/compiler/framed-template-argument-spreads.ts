import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isConditionalExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { isWrapper, outermost, peeled } from './framed-written-targets.ts';
import { isTypeOnly } from './scope.ts';

/**
 * Bounded, position-preserving spread-argument and `.apply` operand unfolding for `arguments`
 * taint analysis across array literals, conditional/logical branches, and closed `const` spreads.
 */

export const LOGICAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.QuestionQuestionToken,
]);

const MAX_SPREAD_UNFOLD_STEPS = 256;
const MAX_SPREAD_SLOTS = 64;
const MAX_SPREAD_ELEMENTS = 64;
const MAX_BMP_CODE_UNIT = 0xff_ff;

const CLOSED_SPREAD_CACHE = new WeakMap<VariableDeclaration, boolean>();
const EMPTY_SEEN: ReadonlySet<FrameDeclaration> = new Set();
const EMPTY_EXPRESSIONS: readonly Expression[] = [];
const EMPTY_SLOTS: ReadonlyMap<number, readonly Expression[]> = new Map();
const EMPTY_LENGTHS: ReadonlySet<number> = new Set([0]);
const SINGLE_LENGTH: ReadonlySet<number> = new Set([1]);
const EMPTY_SLOT_SETS: ReadonlyMap<number, ReadonlySet<Expression>> = new Map();

export interface SpreadUnfold {
  readonly elements: readonly Expression[];
  readonly resolved: boolean;
  readonly slots: ReadonlyMap<number, readonly Expression[]>;
}

const EMPTY_UNFOLD: SpreadUnfold = {
  elements: EMPTY_EXPRESSIONS,
  resolved: true,
  slots: EMPTY_SLOTS,
};

const UNRESOLVED_UNFOLD: SpreadUnfold = {
  elements: EMPTY_EXPRESSIONS,
  resolved: false,
  slots: EMPTY_SLOTS,
};

interface UnfoldBudget {
  steps: number;
}

interface SequenceShape {
  readonly entries: number;
  readonly lengths: ReadonlySet<number>;
  readonly resolved: boolean;
  readonly slots: ReadonlyMap<number, ReadonlySet<Expression>>;
}

interface UnfoldContext {
  readonly allowNullish: boolean;
  readonly budget: UnfoldBudget;
  readonly memo: Map<VariableDeclaration, SequenceShape>;
  readonly owner: Node;
}

interface SlotAccumulator {
  entries: number;
  readonly slots: Map<number, Set<Expression>>;
}

interface LocalSpreadBinding {
  readonly decl: VariableDeclaration;
  readonly expression: Expression;
  readonly nextSeen: ReadonlySet<FrameDeclaration>;
}

const EMPTY_SEQUENCE: SequenceShape = {
  entries: 0,
  lengths: EMPTY_LENGTHS,
  resolved: true,
  slots: EMPTY_SLOT_SETS,
};

const UNRESOLVED_SEQUENCE: SequenceShape = {
  entries: 0,
  lengths: EMPTY_LENGTHS,
  resolved: false,
  slots: EMPTY_SLOT_SETS,
};

/** Whole `const` bindings keep their initializer value throughout their scope. */
export function constantDeclaration(declared: VariableDeclaration): boolean {
  return (
    isIdentifier(declared.name) &&
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/** Whether `kind` is `=` or a compound assignment operator. */
export function isAssignmentOperator(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

/** Queues branch value operands of conditional, comma, assignment, and logical expressions. */
export function queueBranchExpressions(current: Expression, pending: Expression[]): boolean {
  if (isConditionalExpression(current)) {
    pending.push(current.whenTrue, current.whenFalse);
    return true;
  }
  if (!isBinaryExpression(current)) return false;
  const op = current.operatorToken.kind;
  if (op === SyntaxKind.CommaToken || op === SyntaxKind.EqualsToken) {
    pending.push(current.right);
    if (op === SyntaxKind.EqualsToken && isExpression(current.left)) pending.push(current.left);
    return true;
  }
  if (LOGICAL_OPERATORS.has(op)) {
    pending.push(current.left, current.right);
    return true;
  }
  return false;
}

/** Unfolds a call's argument list into per-slot candidates when spreads are statically bounded. */
export function unfoldCallArguments(
  args: readonly Expression[] | undefined,
  owner: Node,
): SpreadUnfold {
  if (args === undefined || args.length === 0) return EMPTY_UNFOLD;
  if (args.every((arg) => !isSpreadElement(arg))) return directCallArguments(args);
  const ctx = createUnfoldContext(owner, false);
  let current: SequenceShape = EMPTY_SEQUENCE;
  for (const arg of args) {
    const next = isSpreadElement(arg)
      ? unfoldSpreadShape(arg.expression, ctx, EMPTY_SEEN)
      : singletonSequence(arg, ctx.budget);
    if (next === undefined) return UNRESOLVED_UNFOLD;
    const combined = concatSequences(current, next);
    if (combined === undefined) return UNRESOLVED_UNFOLD;
    current = combined;
  }
  return finalizeSequence(current);
}

/** Unfolds an `.apply` or `Reflect.construct` argument-list operand (`null`/`undefined` = empty). */
export function unfoldApplyOperand(expr: Expression, owner: Node): SpreadUnfold {
  const ctx = createUnfoldContext(owner, true);
  const shape = unfoldSpreadShape(expr, ctx, EMPTY_SEEN);
  return shape === undefined ? UNRESOLVED_UNFOLD : finalizeSequence(shape);
}

/** Unfolds a single `...spread` operand into per-slot candidates within step and element budgets. */
export function unfoldSpreadExpression(expr: Expression, owner: Node): SpreadUnfold {
  const ctx = createUnfoldContext(owner, false);
  const shape = unfoldSpreadShape(expr, ctx, EMPTY_SEEN);
  return shape === undefined ? UNRESOLVED_UNFOLD : finalizeSequence(shape);
}

function createUnfoldContext(owner: Node, allowNullish: boolean): UnfoldContext {
  return {
    allowNullish,
    budget: { steps: 0 },
    memo: new Map(),
    owner,
  };
}

function directCallArguments(args: readonly Expression[]): SpreadUnfold {
  const slots = new Map<number, readonly Expression[]>();
  for (const [index, arg] of args.entries()) slots.set(index, [arg]);
  return { elements: args, resolved: true, slots };
}

function finalizeSequence(shape: SequenceShape): SpreadUnfold {
  if (shape.slots.size === 0) {
    return shape.resolved ? EMPTY_UNFOLD : UNRESOLVED_UNFOLD;
  }
  const slots = new Map<number, readonly Expression[]>();
  const unique = new Set<Expression>();
  for (const [index, set] of shape.slots) {
    const list = [...set];
    slots.set(index, list);
    for (const expr of list) unique.add(expr);
  }
  return { elements: [...unique], resolved: shape.resolved, slots };
}

function consumeStep(budget: UnfoldBudget): boolean {
  if (budget.steps >= MAX_SPREAD_UNFOLD_STEPS) return false;
  budget.steps += 1;
  return true;
}

function unfoldSpreadShape(
  expr: Expression,
  ctx: UnfoldContext,
  seen: ReadonlySet<FrameDeclaration>,
): SequenceShape | undefined {
  if (!consumeStep(ctx.budget)) return undefined;
  const current = peeled(expr);
  if (ctx.allowNullish && isNullishApplyOperand(current)) return EMPTY_SEQUENCE;
  if (isArrayLiteralExpression(current)) return unfoldArrayElements(current.elements, ctx, seen);
  if (isStringLiteral(current) || isNoSubstitutionTemplateLiteral(current)) {
    return unfoldStringPadding(current.text, ctx.budget);
  }
  if (isIdentifier(current)) return unfoldIdentifierSpread(current, ctx, seen);
  return unfoldBranchSpread(current, ctx, seen);
}

function isNullishApplyOperand(current: Expression): boolean {
  return (
    current.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(current) &&
      current.text === 'undefined' &&
      frameDeclarationOf(current) === undefined)
  );
}

function unfoldStringPadding(text: string, budget: UnfoldBudget): SequenceShape | undefined {
  if (text.length > MAX_SPREAD_SLOTS * 2) return undefined;
  return fixedPaddingSequence(codePointLength(text), budget);
}

function codePointLength(text: string): number {
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0;
    index += code > MAX_BMP_CODE_UNIT ? 2 : 1;
    count += 1;
  }
  return count;
}

function unfoldArrayElements(
  elements: readonly Expression[],
  ctx: UnfoldContext,
  seen: ReadonlySet<FrameDeclaration>,
): SequenceShape | undefined {
  if (elements.length === 0) return EMPTY_SEQUENCE;
  const innerCtx = ctx.allowNullish ? { ...ctx, allowNullish: false } : ctx;
  let result: SequenceShape = EMPTY_SEQUENCE;
  for (const element of elements) {
    const next = unfoldSingleArrayElement(element, innerCtx, seen);
    if (next === undefined) return undefined;
    const combined = concatSequences(result, next);
    if (combined === undefined) return undefined;
    result = combined;
  }
  return result;
}

function unfoldSingleArrayElement(
  element: Expression,
  ctx: UnfoldContext,
  seen: ReadonlySet<FrameDeclaration>,
): SequenceShape | undefined {
  if (isOmittedExpression(element)) return fixedPaddingSequence(1, ctx.budget);
  if (isSpreadElement(element)) return unfoldSpreadShape(element.expression, ctx, seen);
  return singletonSequence(element, ctx.budget);
}

function unfoldIdentifierSpread(
  id: Identifier,
  ctx: UnfoldContext,
  seen: ReadonlySet<FrameDeclaration>,
): SequenceShape | undefined {
  const local = closedLocalSpreadInitializer(id, ctx.owner, seen);
  if (local === undefined) return UNRESOLVED_SEQUENCE;
  const cached = ctx.memo.get(local.decl);
  if (cached !== undefined) return cached;
  const innerCtx = ctx.allowNullish ? { ...ctx, allowNullish: false } : ctx;
  const shape = unfoldSpreadShape(local.expression, innerCtx, local.nextSeen);
  if (shape !== undefined) ctx.memo.set(local.decl, shape);
  return shape;
}

function unfoldBranchSpread(
  current: Expression,
  ctx: UnfoldContext,
  seen: ReadonlySet<FrameDeclaration>,
): SequenceShape | undefined {
  if (isConditionalExpression(current)) {
    return unfoldPairBranches(current.whenTrue, current.whenFalse, ctx, seen);
  }
  if (!isBinaryExpression(current)) return UNRESOLVED_SEQUENCE;
  const op = current.operatorToken.kind;
  if (op === SyntaxKind.CommaToken || op === SyntaxKind.EqualsToken) {
    return unfoldSpreadShape(current.right, ctx, seen);
  }
  if (LOGICAL_OPERATORS.has(op)) {
    return unfoldPairBranches(current.left, current.right, ctx, seen);
  }
  return UNRESOLVED_SEQUENCE;
}

function unfoldPairBranches(
  first: Expression,
  second: Expression,
  ctx: UnfoldContext,
  seen: ReadonlySet<FrameDeclaration>,
): SequenceShape | undefined {
  const left = unfoldSpreadShape(first, ctx, seen);
  if (left === undefined) return undefined;
  const right = unfoldSpreadShape(second, ctx, seen);
  if (right === undefined) return undefined;
  return unionSequences(left, right);
}

function singletonSequence(expr: Expression, budget: UnfoldBudget): SequenceShape | undefined {
  if (!consumeStep(budget)) return undefined;
  return {
    entries: 1,
    lengths: SINGLE_LENGTH,
    resolved: true,
    slots: new Map([[0, new Set([expr])]]),
  };
}

function fixedPaddingSequence(length: number, budget: UnfoldBudget): SequenceShape | undefined {
  if (!consumeStep(budget) || length > MAX_SPREAD_SLOTS) return undefined;
  if (length === 0) return EMPTY_SEQUENCE;
  return { entries: 0, lengths: new Set([length]), resolved: true, slots: EMPTY_SLOT_SETS };
}

function unionSequences(left: SequenceShape, right: SequenceShape): SequenceShape | undefined {
  const lengths = new Set<number>([...left.lengths, ...right.lengths]);
  const acc: SlotAccumulator = { entries: 0, slots: new Map() };
  if (!mergeSlotsAtOffset(acc, left.slots, 0) || !mergeSlotsAtOffset(acc, right.slots, 0)) {
    return undefined;
  }
  return {
    entries: acc.entries,
    lengths,
    resolved: left.resolved && right.resolved,
    slots: acc.slots,
  };
}

function concatSequences(prefix: SequenceShape, suffix: SequenceShape): SequenceShape | undefined {
  const lengths = addLengths(prefix.lengths, suffix.lengths);
  if (lengths === undefined) return undefined;
  const acc: SlotAccumulator = { entries: 0, slots: new Map() };
  if (!mergeSlotsAtOffset(acc, prefix.slots, 0)) return undefined;
  for (const offset of prefix.lengths) {
    if (!mergeSlotsAtOffset(acc, suffix.slots, offset)) return undefined;
  }
  return {
    entries: acc.entries,
    lengths,
    resolved: prefix.resolved && suffix.resolved,
    slots: acc.slots,
  };
}

function addLengths(
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
): Set<number> | undefined {
  const combined = new Set<number>();
  for (const a of left) {
    if (!addRightLengths(a, right, combined)) return undefined;
  }
  return combined;
}

function addRightLengths(base: number, right: ReadonlySet<number>, combined: Set<number>): boolean {
  for (const b of right) {
    const sum = base + b;
    if (sum > MAX_SPREAD_SLOTS) return false;
    combined.add(sum);
  }
  return true;
}

function mergeSlotsAtOffset(
  acc: SlotAccumulator,
  source: ReadonlyMap<number, ReadonlySet<Expression>>,
  offset: number,
): boolean {
  for (const [slot, exprs] of source) {
    const index = offset + slot;
    if (index >= MAX_SPREAD_SLOTS || !addSlotExpressions(acc, index, exprs)) return false;
  }
  return true;
}

function addSlotExpressions(
  acc: SlotAccumulator,
  index: number,
  exprs: ReadonlySet<Expression>,
): boolean {
  let bucket = acc.slots.get(index);
  if (bucket === undefined) {
    bucket = new Set();
    acc.slots.set(index, bucket);
  }
  for (const expr of exprs) {
    if (bucket.has(expr)) continue;
    bucket.add(expr);
    acc.entries += 1;
    if (acc.entries > MAX_SPREAD_ELEMENTS) return false;
  }
  return true;
}

function closedLocalSpreadInitializer(
  id: Identifier,
  owner: Node,
  seen: ReadonlySet<FrameDeclaration>,
): LocalSpreadBinding | undefined {
  const decl = frameDeclarationOf(id);
  if (
    decl === undefined ||
    seen.has(decl) ||
    decl.pos < owner.pos ||
    decl.end > owner.end ||
    !isVariableDeclaration(decl) ||
    !constantDeclaration(decl) ||
    decl.initializer === undefined ||
    !isClosedSpreadOnlyBinding(decl, owner)
  ) {
    return undefined;
  }
  return { decl, expression: decl.initializer, nextSeen: new Set([...seen, decl]) };
}

function isClosedSpreadOnlyBinding(decl: VariableDeclaration, owner: Node): boolean {
  const cached = CLOSED_SPREAD_CACHE.get(decl);
  if (cached !== undefined) return cached;
  const closed = checkClosedSpreadOnlyBinding(decl, owner);
  CLOSED_SPREAD_CACHE.set(decl, closed);
  return closed;
}

function checkClosedSpreadOnlyBinding(decl: VariableDeclaration, owner: Node): boolean {
  if (!isIdentifier(decl.name)) return false;
  const name = decl.name.text;
  const pending: Node[] = [owner];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      node !== decl.name &&
      node.text === name &&
      frameDeclarationOf(node) === decl &&
      !isReadOnlySpreadUse(node)
    ) {
      return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

function isReadOnlySpreadUse(id: Identifier): boolean {
  const parent = outermost(id).parent;
  return isSpreadElement(parent) && !inAssignmentTarget(parent);
}

function inAssignmentTarget(node: Node): boolean {
  let current: Node = node;
  for (;;) {
    const parent = current.parent;
    if (isBinaryExpression(parent) && isAssignmentOperator(parent.operatorToken.kind)) {
      return parent.left === current;
    }
    if (isForOfStatement(parent) || isForInStatement(parent)) {
      return parent.initializer === current;
    }
    if (!isAssignmentPatternContainer(current, parent)) return false;
    current = parent;
  }
}

function isAssignmentPatternContainer(child: Node, parent: Node): boolean {
  return (
    isWrapper(parent) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === child) ||
    (isShorthandPropertyAssignment(parent) && parent.name === child)
  );
}
