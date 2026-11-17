import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isExpression,
  isIdentifier,
  isNonNullExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { constantValue } from './numbers.ts';
import { readsBinding } from './scope.ts';
import { constInitializerOf } from './tuple-spreads.ts';
import {
  asCallArguments,
  branchOperands,
  type CallArgument,
  followedValue,
  type SlotArgument,
  slotArguments,
} from './written-arguments.ts';

/**
 * Branch-aware array-holder alias resolution and property-key classification (`length` vs integer
 * slot indices) shared with `written-array-elements.ts`.
 */

export type AliasLinks = ReadonlyMap<FrameDeclaration, ReadonlySet<FrameDeclaration>>;

export interface ArrayKeyInfo {
  readonly index: number | undefined;
  readonly mayBeIndex: boolean;
  readonly mayBeLength: boolean;
}

export const LENGTH_KEY = 'length';
export const ALIAS_ASSIGNMENT_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Direct binding identifier after peeling type casts, parentheses and non-null wrappers. */
export function directArrayIdentifier(node: Node): Identifier | undefined {
  const plain = plainTarget(node);
  return isIdentifier(plain) && readsBinding(plain) ? plain : undefined;
}

/** Peels parentheses, `as`, `satisfies` and `!` wrappers off `node`. */
export function plainTarget(node: Node): Node {
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

/** Maps variable initializers and reassignments (`alias = args || []`) to target declarations. */
export function collectDirectAliases(file: SourceFile): AliasLinks {
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

/** Resolves `node` across branches to its `FrameDeclaration`s plus transitive alias targets. */
export function canonicalHoldersOf(node: Node, aliases: AliasLinks): readonly FrameDeclaration[] {
  const roots = rootDeclarationsOf(node);
  if (roots.length === 0) {
    return [];
  }
  const seen = new Set<FrameDeclaration>(roots);
  const queue: FrameDeclaration[] = [...roots];
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

/** Resolves deduplicated canonical array holders occupying any of `slots` in `given`. */
export function collectSlotHolders(
  given: readonly CallArgument[],
  slots: readonly number[],
  aliases: AliasLinks,
): readonly FrameDeclaration[] {
  const owners = new Set<FrameDeclaration>();
  for (const slot of slots) {
    const candidates = slotArguments(given, slot);
    for (const candidate of candidates) {
      for (const expr of candidateSlotExpressions(candidate, slot)) {
        for (const owner of canonicalHoldersOf(expr, aliases)) {
          owners.add(owner);
        }
      }
    }
  }
  return [...owners];
}

/** Classifies property-key slot arguments into slot index vs `'length'` possibilities. */
export function classifyKeySlots(keySlots: readonly SlotArgument[]): ArrayKeyInfo {
  if (keySlots.length === 0) {
    return { index: undefined, mayBeIndex: false, mayBeLength: false };
  }
  if (keySlots.some((slot) => slot.spread)) {
    return { index: undefined, mayBeIndex: true, mayBeLength: true };
  }
  let mayBeIndex = false;
  let mayBeLength = false;
  let singleIndex: number | undefined;
  for (const [idx, slot] of keySlots.entries()) {
    const info = classifyArrayKey(slot.expression);
    mayBeIndex ||= info.mayBeIndex;
    mayBeLength ||= info.mayBeLength;
    singleIndex = idx === 0 ? info.index : undefined;
  }
  return { index: singleIndex, mayBeIndex, mayBeLength };
}

/** Classifies `root` across branches into integer slot index, `'length'` or unknown dynamic key. */
export function classifyArrayKey(root: Expression): ArrayKeyInfo {
  const pending: Expression[] = [root];
  const seen = new Set<Expression>();
  let sawLeaf = false;
  let multipleLeaves = false;
  let singleIndex: number | undefined;
  let mayBeIndex = false;
  let mayBeLength = false;
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const plain = unwrapped(current);
    if (seen.has(plain)) {
      continue;
    }
    seen.add(plain);
    const branches = branchOperands(plain);
    if (branches !== undefined) {
      pending.push(...branches);
      continue;
    }
    const leaf = classifyLeafArrayKey(plain);
    mayBeIndex ||= leaf.mayBeIndex;
    mayBeLength ||= leaf.mayBeLength;
    if (sawLeaf) {
      multipleLeaves = true;
    } else {
      sawLeaf = true;
      singleIndex = leaf.index;
    }
  }
  return { index: multipleLeaves ? undefined : singleIndex, mayBeIndex, mayBeLength };
}

/** Links a direct identifier initializer or value-forwarding assignment onto `aliases`. */
function recordAliasNode(node: Node, aliases: Map<FrameDeclaration, Set<FrameDeclaration>>): void {
  if (isVariableDeclaration(node) && node.initializer !== undefined) {
    linkAliasSource(node, node.initializer, aliases);
    return;
  }
  if (isBinaryExpression(node) && ALIAS_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
    const left = directArrayIdentifier(node.left);
    const holder = left === undefined ? undefined : frameDeclarationOf(left);
    if (holder !== undefined) {
      linkAliasSource(holder, node.right, aliases);
    }
  }
}

/** Adds `rhs` declaration targets across logical and conditional branches to `holder`'s aliases. */
function linkAliasSource(
  holder: FrameDeclaration,
  rhs: Expression,
  aliases: Map<FrameDeclaration, Set<FrameDeclaration>>,
): void {
  for (const target of rootDeclarationsOf(rhs)) {
    if (target === holder) {
      continue;
    }
    let linked = aliases.get(holder);
    if (linked === undefined) {
      linked = new Set();
      aliases.set(holder, linked);
    }
    linked.add(target);
  }
}

/** Collects direct binding declarations reachable through logical and conditional value branches. */
function rootDeclarationsOf(node: Node): readonly FrameDeclaration[] {
  if (!isExpression(node)) {
    const ident = directArrayIdentifier(node);
    const declared = ident === undefined ? undefined : frameDeclarationOf(ident);
    return declared === undefined ? [] : [declared];
  }
  const roots: FrameDeclaration[] = [];
  const pending: Expression[] = [node];
  const seen = new Set<Expression>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const plain = unwrapped(current);
    if (seen.has(plain)) {
      continue;
    }
    seen.add(plain);
    const branches = branchOperands(plain);
    if (branches !== undefined) {
      pending.push(...branches);
      continue;
    }
    const ident = directArrayIdentifier(plain);
    const declared = ident === undefined ? undefined : frameDeclarationOf(ident);
    if (declared !== undefined) {
      roots.push(declared);
    }
  }
  return roots;
}

/** Positional expression at `slot`, peeking into local array literals behind `.apply` spreads. */
function candidateSlotExpressions(candidate: SlotArgument, slot: number): readonly Expression[] {
  if (!candidate.spread) {
    return [candidate.expression];
  }
  const tuple = followedValue(candidate.expression);
  if (!isArrayLiteralExpression(tuple)) {
    return [];
  }
  return slotArguments(asCallArguments(tuple.elements), slot - candidate.index)
    .filter((sub) => !sub.spread)
    .map((sub) => sub.expression);
}

/** Classifies a single non-branch property key expression on an array holder. */
function classifyLeafArrayKey(plain: Expression): ArrayKeyInfo {
  const evaluated = constantValue(plain, constInitializerOf);
  if (typeof evaluated === 'number') {
    const validIndex = Number.isSafeInteger(evaluated) && evaluated >= 0;
    return {
      index: validIndex ? evaluated : undefined,
      mayBeIndex: validIndex,
      mayBeLength: false,
    };
  }
  if (typeof evaluated === 'string') {
    if (evaluated === LENGTH_KEY) {
      return { index: undefined, mayBeIndex: false, mayBeLength: true };
    }
    const parsed = Number(evaluated);
    const validIndex = /^(?:0|[1-9]\d*)$/u.test(evaluated) && Number.isSafeInteger(parsed);
    return { index: validIndex ? parsed : undefined, mayBeIndex: validIndex, mayBeLength: false };
  }
  const path = globalPathOf(plain);
  const nonKeyLiteral =
    plain.kind === SyntaxKind.TrueKeyword ||
    plain.kind === SyntaxKind.FalseKeyword ||
    plain.kind === SyntaxKind.NullKeyword ||
    path?.[0] === 'Symbol' ||
    path?.join('.') === 'undefined';
  return nonKeyLiteral
    ? { index: undefined, mayBeIndex: false, mayBeLength: false }
    : { index: undefined, mayBeIndex: true, mayBeLength: true };
}
