import {
  type CallExpression,
  type Expression,
  type Identifier,
  isAsExpression,
  isCallExpression,
  isComputedPropertyName,
  isExpression,
  isIdentifier,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isStringLiteral,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { constantValue } from './numbers.ts';
import { readsBinding } from './scope.ts';
import { constFollowedValue, constInitializerOf } from './tuple-spreads.ts';
import { branchOperands, type CallArgument } from './written-arguments.ts';

/**
 * Per-binding array-holder identity, transitive alias lookup, property-key classification (`length`
 * vs integer slot indices), and shared write buckets for array-mutation analyses.
 */

export interface ArrayHolder {
  readonly declared: FrameDeclaration;
  readonly name: string;
}

export type AliasLinks = ReadonlyMap<ArrayHolder, ReadonlySet<ArrayHolder>>;

export interface ArrayKeyInfo {
  readonly index: number | undefined;
  readonly mayBeIndex: boolean;
  readonly mayBeLength: boolean;
}

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

export type ModuleArrayWrites = ReadonlyMap<ArrayHolder, HolderArrayWrites>;

export const LENGTH_KEY = 'length';
export const ALIAS_ASSIGNMENT_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

const HOLDER_INTERN = new WeakMap<FrameDeclaration, Map<string, ArrayHolder>>();
const WELL_KNOWN_SYMBOLS: ReadonlySet<string> = new Set([
  'Symbol.asyncDispose',
  'Symbol.asyncIterator',
  'Symbol.dispose',
  'Symbol.hasInstance',
  'Symbol.isConcatSpreadable',
  'Symbol.iterator',
  'Symbol.match',
  'Symbol.matchAll',
  'Symbol.replace',
  'Symbol.search',
  'Symbol.species',
  'Symbol.split',
  'Symbol.toPrimitive',
  'Symbol.toStringTag',
  'Symbol.unscopables',
]);

/** Returns the canonical interned `ArrayHolder` for `(declared, name)`. */
export function internArrayHolder(declared: FrameDeclaration, name: string): ArrayHolder {
  let byName = HOLDER_INTERN.get(declared);
  if (byName === undefined) {
    byName = new Map();
    HOLDER_INTERN.set(declared, byName);
  }
  let holder = byName.get(name);
  if (holder === undefined) {
    holder = { declared, name };
    byName.set(name, holder);
  }
  return holder;
}

/** Resolves `ident` to its canonical `ArrayHolder` when `ident` names a lexical/hoisted binding. */
export function arrayHolderOf(ident: Identifier): ArrayHolder | undefined {
  const declared = frameDeclarationOf(ident);
  return declared === undefined ? undefined : internArrayHolder(declared, ident.text);
}

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

/** Returns or creates the mutable `HolderArrayWrites` bucket for `owner`. */
export function ensureHolderWrites(
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
  owner: ArrayHolder,
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

/** Marks every holder in `owners` as shortened, answering whether any holder newly changed. */
export function markHoldersShortened(
  owners: readonly ArrayHolder[],
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): boolean {
  let changed = false;
  for (const owner of owners) {
    const entry = ensureHolderWrites(byHolder, owner);
    if (!entry.shortened) {
      entry.shortened = true;
      changed = true;
    }
  }
  return changed;
}

/** Appends `write` to every holder in `owners` when not already recorded, answering if changed. */
export function recordOwnersWrite(
  owners: readonly ArrayHolder[],
  write: IndexedElementWrite,
  byHolder: Map<ArrayHolder, HolderArrayWrites>,
): boolean {
  let changed = false;
  for (const owner of owners) {
    const list = ensureHolderWrites(byHolder, owner).indexedWrites;
    const exists = list.some(
      (prev) =>
        prev.index === write.index && prev.spread === write.spread && prev.value === write.value,
    );
    if (!exists) {
      list.push(write);
      changed = true;
    }
  }
  return changed;
}

/** Resolves `node` across branches to its `ArrayHolder`s plus transitive alias targets. */
export function canonicalHoldersOf(node: Node, aliases: AliasLinks): readonly ArrayHolder[] {
  const roots = rootHoldersOf(node);
  if (roots.length === 0) {
    return [];
  }
  const seen = new Set<ArrayHolder>(roots);
  const queue: ArrayHolder[] = [...roots];
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

/** Collects direct `ArrayHolder`s reachable through logical and conditional value branches. */
export function rootHoldersOf(node: Node): readonly ArrayHolder[] {
  if (!isExpression(node)) {
    const ident = directArrayIdentifier(node);
    const holder = ident === undefined ? undefined : arrayHolderOf(ident);
    return holder === undefined ? [] : [holder];
  }
  const roots: ArrayHolder[] = [];
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
    const holder = ident === undefined ? undefined : arrayHolderOf(ident);
    if (holder !== undefined) {
      roots.push(holder);
    }
  }
  return roots;
}

/** Whether `property` is a non-computed `__proto__: proto` literal prototype setter. */
export function isPrototypeSetterProperty(property: ObjectLiteralElementLike): boolean {
  return (
    isPropertyAssignment(property) &&
    (isIdentifier(property.name) || isStringLiteral(property.name)) &&
    property.name.text === '__proto__'
  );
}

/** Classifies an object-literal `PropertyName` into integer slot index, `'length'` or dynamic key. */
export function classifyPropertyName(name: PropertyName): ArrayKeyInfo {
  if (isComputedPropertyName(name)) {
    return classifyArrayKey(name.expression);
  }
  if (isNumericLiteral(name)) {
    return classifyNumericKey(Number(name.text));
  }
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return classifyStringKey(name.text);
  }
  return { index: undefined, mayBeIndex: false, mayBeLength: false };
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
    const next = keyStepOperands(plain);
    if (next !== undefined) {
      pending.push(...next);
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
  if (!sawLeaf) {
    return { index: undefined, mayBeIndex: true, mayBeLength: true };
  }
  return { index: multipleLeaves ? undefined : singleIndex, mayBeIndex, mayBeLength };
}

/** Next expressions to inspect when `plain` is a branch expression or whole `const` binding read. */
function keyStepOperands(plain: Expression): readonly Expression[] | undefined {
  const branches = branchOperands(plain);
  if (branches !== undefined) {
    return branches;
  }
  const init = isIdentifier(plain) && readsBinding(plain) ? constInitializerOf(plain) : undefined;
  return init === undefined ? undefined : [init];
}

/** Classifies a single non-branch property key expression on an array holder. */
function classifyLeafArrayKey(plain: Expression): ArrayKeyInfo {
  const evaluated = constantValue(plain, constInitializerOf);
  if (typeof evaluated === 'number') {
    return classifyNumericKey(evaluated);
  }
  if (typeof evaluated === 'string') {
    return classifyStringKey(evaluated);
  }
  return isNonArrayPropertyKey(plain)
    ? { index: undefined, mayBeIndex: false, mayBeLength: false }
    : { index: undefined, mayBeIndex: true, mayBeLength: true };
}

/** Classifies a numeric property key into a non-negative integer slot index or non-index number. */
function classifyNumericKey(evaluated: number): ArrayKeyInfo {
  const validIndex = Number.isSafeInteger(evaluated) && evaluated >= 0;
  const normalized = evaluated === 0 ? 0 : evaluated;
  return {
    index: validIndex ? normalized : undefined,
    mayBeIndex: validIndex,
    mayBeLength: false,
  };
}

/** Classifies a static string property key into `'length'`, canonical integer index or other key. */
function classifyStringKey(evaluated: string): ArrayKeyInfo {
  if (evaluated === LENGTH_KEY) {
    return { index: undefined, mayBeIndex: false, mayBeLength: true };
  }
  const parsed = Number(evaluated);
  const validIndex = /^(?:0|[1-9]\d*)$/u.test(evaluated) && Number.isSafeInteger(parsed);
  return { index: validIndex ? parsed : undefined, mayBeIndex: validIndex, mayBeLength: false };
}

/** Guaranteed non-index, non-`'length'` property keys (`boolean`, `null`, `undefined` or `symbol`). */
function isNonArrayPropertyKey(plain: Expression): boolean {
  if (
    plain.kind === SyntaxKind.TrueKeyword ||
    plain.kind === SyntaxKind.FalseKeyword ||
    plain.kind === SyntaxKind.NullKeyword
  ) {
    return true;
  }
  const path = globalPathOf(plain)?.join('.');
  if (path === 'undefined' || (path !== undefined && WELL_KNOWN_SYMBOLS.has(path))) {
    return true;
  }
  if (!isCallExpression(plain)) {
    return false;
  }
  const calleePath = globalPathOf(constFollowedValue(plain.expression))?.join('.');
  return calleePath === 'Symbol' || calleePath === 'Symbol.for';
}
