import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type SpreadAssignment,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedVariableWritesOf } from './framed-member-writes.ts';
import { isConstantDeclaration } from './framed-source-changes.ts';
import { initializerOf } from './framed.ts';
import { constantValue } from './numbers.ts';
import {
  constFollowedValue,
  constInitializerOf,
  spreadOnlyInitializer,
  unmutatedTuple,
} from './tuple-spreads.ts';
import { asCallArguments, type CallArgument, slotArguments } from './written-arguments.ts';

/**
 * Transfer targets `structuredClone` can detach across positional options, conditional or logical
 * branches, and unexpanded spread or `apply` argument lists.
 */

interface SpreadCandidate {
  readonly expression: Expression;
  readonly held: boolean;
  readonly startIndex: 0 | 1;
}

interface TransferState {
  readonly heldSpreads: readonly [Set<Expression>, Set<Expression>];
  readonly options: Set<Expression>;
  readonly recorded: Set<Node>;
  readonly spreads: readonly [Set<Expression>, Set<Expression>];
  readonly targets: Node[];
}

const CLONE_OPTIONS_SLOT = 1;
const PRIMITIVE_GLOBALS: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);
const NON_OPTIONS_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.ClassExpression,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.OmittedExpression,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TypeOfExpression,
  SyntaxKind.VoidExpression,
]);

/** Transfer targets `structuredClone` can detach across positional options and spread argument lists. */
export function transferredBy(given: readonly CallArgument[]): readonly Node[] {
  const state: TransferState = {
    heldSpreads: [new Set(), new Set()],
    options: new Set(),
    recorded: new Set(),
    spreads: [new Set(), new Set()],
    targets: [],
  };
  const spreads: SpreadCandidate[] = [];
  for (const candidate of slotArguments(given, CLONE_OPTIONS_SLOT)) {
    if (candidate.spread) {
      spreads.push({
        expression: candidate.expression,
        held: false,
        startIndex: candidate.index === 0 ? 0 : 1,
      });
    } else {
      collectOptionsTransfers(candidate.expression, state);
    }
  }
  drainSpreadCandidates(spreads.toReversed(), state);
  return state.targets;
}

/** Drains clean and held spread candidates, recording static transfers before opaque holders. */
function drainSpreadCandidates(pending: SpreadCandidate[], state: TransferState): void {
  const holders: Expression[] = [];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const value = unwrapped(current.expression);
    const visited = current.held
      ? state.heldSpreads[current.startIndex]
      : state.spreads[current.startIndex];
    if (visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (current.held) {
      stepHeldSpread(value, current.startIndex, pending, state);
    } else if (!stepCleanSpread(value, current.startIndex, pending, state)) {
      if (!isNonOptionsValue(value)) {
        holders.push(value);
      }
      pending.push({ expression: value, held: true, startIndex: current.startIndex });
    }
  }
  for (const holder of holders) {
    recordTarget(holder, state);
  }
}

/** Expands clean tuple/branch spreads when proven unchanged; answers false for opaque spreads. */
function stepCleanSpread(
  value: Expression,
  startIndex: 0 | 1,
  pending: SpreadCandidate[],
  state: TransferState,
): boolean {
  const tuple = unmutatedTuple(value);
  if (tuple !== undefined) {
    enqueueTupleSlice(tuple, { held: false, startIndex }, pending, state);
    return true;
  }
  const spreadOnly = spreadOnlyInitializer(value);
  if (spreadOnly !== undefined) {
    pending.push({ expression: spreadOnly, held: false, startIndex });
    return true;
  }
  const branches = branchOperands(value);
  if (branches !== undefined) {
    for (const branch of branches.toReversed()) {
      pending.push({ expression: branch, held: false, startIndex });
    }
    return true;
  }
  return false;
}

/** Walks initializers and branches of a held or mutable spread binding for static transfers. */
function stepHeldSpread(
  value: Expression,
  startIndex: 0 | 1,
  pending: SpreadCandidate[],
  state: TransferState,
): void {
  const branches = branchOperands(value);
  if (branches !== undefined) {
    for (const branch of branches.toReversed()) {
      pending.push({ expression: branch, held: true, startIndex });
    }
    return;
  }
  if (isIdentifier(value)) {
    const initial = initializerOf(value);
    if (initial !== undefined) {
      pending.push({ expression: initial, held: true, startIndex });
    }
    return;
  }
  if (isArrayLiteralExpression(value)) {
    enqueueTupleSlice(value, { held: true, startIndex }, pending, state);
  }
}

/** Routes slot-1 candidates of `tuple` (offset by `startIndex`) to options or nested spreads. */
function enqueueTupleSlice(
  tuple: ArrayLiteralExpression,
  mode: { readonly held: boolean; readonly startIndex: 0 | 1 },
  pending: SpreadCandidate[],
  state: TransferState,
): void {
  const needed = CLONE_OPTIONS_SLOT - mode.startIndex;
  const candidates = slotArguments(asCallArguments(tuple.elements), needed);
  for (const sub of candidates) {
    if (sub.spread) {
      pending.push({
        expression: sub.expression,
        held: mode.held,
        startIndex: mode.startIndex + sub.index === 0 ? 0 : 1,
      });
    } else {
      collectOptionsTransfers(sub.expression, state);
    }
  }
}

/** Collects transfer targets from a positional or slot-aligned `options` expression. */
function collectOptionsTransfers(root: Expression, state: TransferState): void {
  const pending: Expression[] = [root];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const value = unwrapped(current);
    if (state.options.has(value)) {
      continue;
    }
    state.options.add(value);
    const branches = branchOperands(value);
    if (branches !== undefined) {
      pending.push(...branches.toReversed());
    } else if (isIdentifier(value)) {
      enqueueIdentifierOptions(value, pending, state);
    } else if (isObjectLiteralExpression(value)) {
      collectObjectOptionsTransfers(value, state);
    } else if (!isNonOptionsValue(value)) {
      collectTransferTargets(value, state);
    }
  }
}

/** Follows a transparent `const` options alias, or records an opaque options binding. */
function enqueueIdentifierOptions(
  name: Identifier,
  pending: Expression[],
  state: TransferState,
): void {
  if (PRIMITIVE_GLOBALS.has(globalPathOf(name)?.join('.') ?? '')) {
    return;
  }
  const initial = constInitializerOf(name);
  const declared = initial === undefined ? undefined : unwrapped(initial);
  if (declared !== undefined && isTransparentOptionsAlias(declared)) {
    pending.push(declared);
    return;
  }
  collectTransferTargets(name, state);
  pending.push(...mutableAliasValues(name).toReversed());
}

/** Walks an options object literal right-to-left until a definite `transfer` property is met. */
function collectObjectOptionsTransfers(
  options: ObjectLiteralExpression,
  state: TransferState,
): void {
  const pending = [...options.properties];
  const seen = new Set<Expression>([options]);
  for (let property = pending.pop(); property !== undefined; property = pending.pop()) {
    if (isSpreadAssignment(property)) {
      const spread = constFollowedValue(property.expression);
      if (isObjectLiteralExpression(spread)) {
        if (!seen.has(spread)) {
          seen.add(spread);
          pending.push(...spread.properties);
        }
      } else {
        collectOptionsTransfers(property.expression, state);
      }
      continue;
    }
    if (collectPropertyTransfers(property, options, state)) {
      return;
    }
  }
}

/** Records transfer targets for one options property and answers whether it overwrites `transfer`. */
function collectPropertyTransfers(
  property: Exclude<ObjectLiteralElementLike, SpreadAssignment>,
  options: Expression,
  state: TransferState,
): boolean {
  const { name } = property;
  const key = isComputedPropertyName(name)
    ? constantValue(name.expression, constInitializerOf)
    : name.text;
  if (key === undefined) {
    collectTransferTargets(isPropertyAssignment(property) ? property.initializer : options, state);
    return false;
  }
  if (key !== 'transfer') {
    return false;
  }
  if (isPropertyAssignment(property)) {
    collectTransferTargets(property.initializer, state);
  } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    collectTransferTargets(property.name, state);
  } else if (isGetAccessorDeclaration(property)) {
    recordTarget(options, state);
  }
  return true;
}

/** Records buffers a transfer list holds through list, spread, branch and `const` entry aliases. */
function collectTransferTargets(list: Expression, state: TransferState): void {
  const pending: Expression[] = [list];
  const seen = new Set<Expression>();
  for (let expression = pending.pop(); expression !== undefined; expression = pending.pop()) {
    const value = unwrapped(expression);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    enqueueTransferEntry(value, pending, state);
  }
}

/** Expands one transfer list or entry expression onto `pending`, or records its root target. */
function enqueueTransferEntry(
  value: Expression,
  pending: Expression[],
  state: TransferState,
): void {
  if (isArrayLiteralExpression(value)) {
    pending.push(...value.elements.toReversed());
    return;
  }
  if (isSpreadElement(value)) {
    pending.push(value.expression);
    return;
  }
  const branches = branchOperands(value);
  if (branches !== undefined) {
    pending.push(...branches.toReversed());
    return;
  }
  const declared = transferAlias(value);
  if (declared !== undefined) {
    pending.push(declared);
    return;
  }
  if (value.kind !== SyntaxKind.OmittedExpression) {
    recordTarget(value, state);
  }
  if (isIdentifier(value)) {
    pending.push(...mutableAliasValues(value).toReversed());
  }
}

/** Value-producing operands of conditional, logical, assignment or comma expressions. */
function branchOperands(value: Expression): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse];
  }
  if (!isBinaryExpression(value)) {
    return undefined;
  }
  const { kind } = value.operatorToken;
  if (
    kind === SyntaxKind.AmpersandAmpersandToken ||
    kind === SyntaxKind.CommaToken ||
    kind === SyntaxKind.EqualsToken
  ) {
    return [value.right];
  }
  return kind === SyntaxKind.BarBarToken || kind === SyntaxKind.QuestionQuestionToken
    ? [value.left, value.right]
    : undefined;
}

/** Whether stepping from a `const` identifier into `declared` preserves or refines transfer roots. */
function isTransparentOptionsAlias(declared: Expression): boolean {
  return (
    isIdentifier(declared) ||
    isObjectLiteralExpression(declared) ||
    branchOperands(declared) !== undefined ||
    isNonOptionsValue(declared)
  );
}

/** Whether `value` is a primitive, callable or array literal that cannot carry a `.transfer` list. */
function isNonOptionsValue(value: Expression): boolean {
  return (
    NON_OPTIONS_KINDS.has(value.kind) || PRIMITIVE_GLOBALS.has(globalPathOf(value)?.join('.') ?? '')
  );
}

/** Append `node` once to `state.targets`. */
function recordTarget(node: Node, state: TransferState): void {
  if (!state.recorded.has(node)) {
    state.recorded.add(node);
    state.targets.push(node);
  }
}

/**
 * What a `let` or `var` variable of one name may hold: its initializer and every value the module
 * assigns it anew; none of a `const`, a parameter or a pattern. The variable itself stays the opaque
 * holder recorded for it, which a function-local one makes no state kept; the module-owned buffers
 * its values name are what the call detaches, so each value counts, in whatever order.
 */
function mutableAliasValues(name: Identifier): readonly Expression[] {
  const declared = frameDeclarationOf(name);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    isConstantDeclaration(declared)
  ) {
    return [];
  }
  const assigned = framedVariableWritesOf(name.getSourceFile(), declared).map(
    (write) => write.value,
  );
  return declared.initializer === undefined ? assigned : [declared.initializer, ...assigned];
}

/** The `const` alias or literal container a transfer entry is declared of; none of constructions. */
function transferAlias(value: Expression): Expression | undefined {
  const initial = isIdentifier(value) ? constInitializerOf(value) : undefined;
  const declared = initial === undefined ? undefined : unwrapped(initial);
  return declared !== undefined &&
    (isIdentifier(declared) ||
      isArrayLiteralExpression(declared) ||
      isObjectLiteralExpression(declared) ||
      branchOperands(declared) !== undefined)
    ? declared
    : undefined;
}
