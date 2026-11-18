import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedObjectSources } from './framed-object-members.ts';
import {
  type ChildCandidate,
  type ExpandedStep,
  expandIdentifierStep,
  type HeldResolution,
  type HeldWorkItem,
  initialActiveBindings,
  type ProjectionCallbacks,
} from './multipart-held-bindings.ts';

/** Bounded member-path unfolding across aliases, arrays, literals, and parameter sources. */

const OBJECT_ASSIGN = 'Object.assign';
const PROJECTION_LIMITS = {
  maxDepth: 16,
} as const;

/** Unfolds a `Held` member path while cutting self-referential expansion cycles conservatively. */
export function inspectHeldPath(
  entry: Held,
  point: Node,
  callbacks: ProjectionCallbacks,
  activeSource?: Identifier,
): HeldResolution {
  const expressions: Expression[] = [];
  let ambiguous = false;
  let closed = true;
  let typedFormData = false;
  const seen = new Map<Expression, Set<string>>();
  const pending: HeldWorkItem[] = [
    {
      activeBindings: initialActiveBindings(activeSource, point),
      activeExpressions: new Set(),
      enclosingBindingTyped: false,
      evalAt: undefined,
      held: entry,
      trailingOuter: entry.keys.length,
    },
  ];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (at.held.keys.length === 0) {
      expressions.push(at.held.value);
      const leafPoint = at.evalAt ?? point;
      if (
        callbacks.isAssertedFormData(at.held.value, []) ||
        (at.enclosingBindingTyped && callbacks.isOpaqueLeaf(at.held.value, leafPoint))
      ) {
        typedFormData = true;
      }
      continue;
    }
    const step = evaluateWorkItem(at, point, seen, callbacks);
    if (step.ambiguous) {
      ambiguous = true;
    }
    if (!step.closed) {
      closed = false;
    }
    if (step.typedFormData) {
      typedFormData = true;
    }
    pending.push(...step.next);
  }
  return { ambiguous, closed, expressions, typedFormData };
}

/** Evaluates one non-empty `HeldWorkItem` against depth, cycle, and visited-path guards. */
function evaluateWorkItem(
  at: HeldWorkItem,
  point: Node,
  seen: Map<Expression, Set<string>>,
  callbacks: ProjectionCallbacks,
): {
  readonly ambiguous: boolean;
  readonly closed: boolean;
  readonly next: readonly HeldWorkItem[];
  readonly typedFormData: boolean;
} {
  if (at.held.keys.length > PROJECTION_LIMITS.maxDepth) {
    return { ambiguous: true, closed: false, next: [], typedFormData: false };
  }
  const value = unwrapped(at.held.value);
  const evalPoint = at.evalAt ?? point;
  if (repeatsOnActiveChain(at, value, evalPoint)) {
    return { ambiguous: true, closed: false, next: [], typedFormData: false };
  }
  if (markVisitedHeldPath(seen, value, at, evalPoint)) {
    return { ambiguous: false, closed: true, next: [], typedFormData: false };
  }
  const assertedFormData = callbacks.isAssertedFormData(at.held.value, at.held.keys);
  const activeBindings = nextActiveBindings(at.activeBindings, value, evalPoint);
  const activeExpressions = new Set([...at.activeExpressions, value]);
  const expanded = expandHeldStep(at, value, point, callbacks);
  const unclosedEnclosingTyped =
    !expanded.closed && expanded.overridesEnclosingType !== true && at.enclosingBindingTyped;
  return {
    ambiguous: expanded.ambiguous,
    closed: expanded.closed,
    next: expanded.children.map((child) => {
      return {
        activeBindings,
        activeExpressions,
        enclosingBindingTyped: child.enclosingBindingTyped ?? at.enclosingBindingTyped,
        evalAt: child.evalAt ?? at.evalAt,
        held: child.held,
        trailingOuter: child.trailingOuter ?? at.trailingOuter,
      };
    }),
    typedFormData: assertedFormData || expanded.bindingTypedFormData || unclosedEnclosingTyped,
  };
}

/** Whether `value` or its bound declaration+identifier+site repeats along the active expansion chain. */
function repeatsOnActiveChain(at: HeldWorkItem, value: Expression, evalPoint: Node): boolean {
  if (at.activeExpressions.has(value)) {
    return true;
  }
  if (!isIdentifier(value)) {
    return false;
  }
  const selected = frameBindingOf(value);
  const token = `${value.text}@${String(evalPoint.pos)}`;
  return selected !== undefined && at.activeBindings.get(selected.binding)?.has(token) === true;
}

/** Records `(value, keys, enclosingTyped, site)` in `seen`, returning `true` when already expanded. */
function markVisitedHeldPath(
  seen: Map<Expression, Set<string>>,
  value: Expression,
  at: HeldWorkItem,
  evalPoint: Node,
): boolean {
  const siteKey =
    isObjectLiteralExpression(value) || isArrayLiteralExpression(value)
      ? 'lit'
      : String(evalPoint.pos);
  const serialized = `${at.enclosingBindingTyped ? '1' : '0'}:${siteKey}:${String(at.trailingOuter)}:${JSON.stringify(at.held.keys)}`;
  const visited = seen.get(value) ?? new Set<string>();
  if (visited.has(serialized)) {
    return true;
  }
  visited.add(serialized);
  seen.set(value, visited);
  return false;
}

/** Extends `activeBindings` with `(binding, text@pos)` when `value` is a bound identifier. */
function nextActiveBindings(
  activeBindings: ReadonlyMap<Node, ReadonlySet<string>>,
  value: Expression,
  evalPoint: Node,
): ReadonlyMap<Node, ReadonlySet<string>> {
  if (!isIdentifier(value)) {
    return activeBindings;
  }
  const selected = frameBindingOf(value);
  if (selected === undefined) {
    return activeBindings;
  }
  const token = `${value.text}@${String(evalPoint.pos)}`;
  const names = new Set([...(activeBindings.get(selected.binding) ?? []), token]);
  return new Map([...activeBindings, [selected.binding, names]]);
}

/** Wraps plain `Held` entries into `ChildCandidate` items preserving enclosing type and site state. */
function plainChildren(entries: readonly Held[]): readonly ChildCandidate[] {
  return entries.map((held) => ({ held }));
}

/** Expands one non-empty `Held` member path step into successor `Held` candidates. */
function expandHeldStep(
  at: HeldWorkItem,
  value: Expression,
  outerPoint: Node,
  callbacks: ProjectionCallbacks,
): ExpandedStep {
  const keys = at.held.keys;
  const alternatives = callbacks.selectValues(value);
  if (alternatives !== undefined) {
    return {
      ambiguous: false,
      bindingTypedFormData: false,
      children: plainChildren(alternatives.map((each) => ({ keys, value: each }))),
      closed: true,
    };
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const memberKey = frameMemberName(value);
    const nextTrailing = at.evalAt === undefined ? at.trailingOuter + 1 : at.trailingOuter;
    return {
      ambiguous: false,
      bindingTypedFormData: false,
      children:
        memberKey === undefined
          ? []
          : [
              {
                held: { keys: [memberKey, ...keys], value: value.expression },
                trailingOuter: nextTrailing,
              },
            ],
      closed: memberKey !== undefined,
    };
  }
  if (isArrayLiteralExpression(value)) {
    const [firstKey, ...restKeys] = keys;
    return firstKey === undefined
      ? { ambiguous: false, bindingTypedFormData: false, children: [], closed: true }
      : arrayPathEntries(value, firstKey, restKeys, at.trailingOuter);
  }
  if (isIdentifier(value)) {
    return expandIdentifierStep(value, at, outerPoint, callbacks);
  }
  const objectSources = framedObjectSources(value, keys);
  if (objectSources === undefined) {
    return { ambiguous: false, bindingTypedFormData: false, children: [], closed: false };
  }
  const entries = objectSources.filter(
    (each) => unwrapped(each.value) !== value || each.keys.length !== keys.length,
  );
  return {
    ambiguous: false,
    bindingTypedFormData: false,
    children: entries.map((each) => literalSourceCandidate(each, at.trailingOuter)),
    closed: entries.length === objectSources.length,
  };
}

/** Builds a `ChildCandidate` for an object-literal or `Object.assign` member source. */
function literalSourceCandidate(each: Held, currentTrailing: number): ChildCandidate {
  const rawRemaining = isShallowCopySource(each.value)
    ? Math.max(0, each.keys.length - 1)
    : each.keys.length;
  return {
    evalAt: each.value,
    held: each,
    trailingOuter: Math.min(currentTrailing, rawRemaining),
  };
}

/** Whether `source` is a shallow-copied spread or `Object.assign` source expression. */
function isShallowCopySource(source: Expression): boolean {
  const parent = source.parent;
  if (isSpreadAssignment(parent)) {
    return true;
  }
  return (
    isCallExpression(parent) &&
    globalPathOf(unwrapped(parent.expression))?.join('.') === OBJECT_ASSIGN &&
    parent.arguments[0] !== source
  );
}

/** Selects matching element and spread-offset candidates from an `ArrayLiteralExpression` for `firstKey`. */
function arrayPathEntries(
  array: ArrayLiteralExpression,
  firstKey: string,
  restKeys: readonly string[],
  currentTrailing: number,
): ExpandedStep {
  if (!/^\d+$/u.test(firstKey)) {
    return { ambiguous: false, bindingTypedFormData: false, children: [], closed: true };
  }
  const requestedIndex = Number(firstKey);
  const candidates: ChildCandidate[] = [];
  let fixedBefore = 0;
  let spreadSeen = false;
  for (const element of array.elements) {
    if (isOmittedExpression(element)) {
      fixedBefore += 1;
      continue;
    }
    if (!isSpreadElement(element)) {
      if (
        (!spreadSeen && fixedBefore === requestedIndex) ||
        (spreadSeen && requestedIndex >= fixedBefore)
      ) {
        candidates.push({
          evalAt: element,
          held: { keys: restKeys, value: element },
          trailingOuter: Math.min(currentTrailing, restKeys.length),
        });
      }
      fixedBefore += 1;
      continue;
    }
    if (requestedIndex < fixedBefore) {
      spreadSeen = true;
      continue;
    }
    const spreadSlice = spreadOffsetEntries(
      element.expression,
      requestedIndex - fixedBefore,
      spreadSeen,
      restKeys,
    );
    candidates.push(
      ...spreadSlice.entries.map((held) => {
        return {
          evalAt: element.expression,
          held,
          trailingOuter: Math.min(currentTrailing, restKeys.length),
        };
      }),
    );
    if (spreadSlice.ambiguous) {
      return {
        ambiguous: true,
        bindingTypedFormData: false,
        children: candidates,
        closed: false,
      };
    }
    spreadSeen = true;
  }
  return {
    ambiguous: false,
    bindingTypedFormData: false,
    children: candidates,
    closed: true,
  };
}

/** Computes exact or bounded-range element offsets into a spread array expression. */
function spreadOffsetEntries(
  expression: Expression,
  maxOffset: number,
  priorSpreadSeen: boolean,
  restKeys: readonly string[],
): { readonly ambiguous: boolean; readonly entries: readonly Held[] } {
  if (!priorSpreadSeen) {
    return {
      ambiguous: false,
      entries: [{ keys: [String(maxOffset), ...restKeys], value: expression }],
    };
  }
  if (maxOffset > PROJECTION_LIMITS.maxDepth) {
    return { ambiguous: true, entries: [] };
  }
  const entries: Held[] = [];
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    entries.push({ keys: [String(offset), ...restKeys], value: expression });
  }
  return { ambiguous: false, entries };
}

/** Peels a static property or element access chain on `node` into a `Held` holder path. */
export function peeledMemberHolder(node: Expression): Held | undefined {
  let current = unwrapped(node);
  const keys: string[] = [];
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    const key = frameMemberName(current);
    if (key === undefined) {
      return undefined;
    }
    keys.unshift(key);
    current = unwrapped(current.expression);
  }
  return keys.length === 0 ? undefined : { keys, value: current };
}

/** Deduplicates candidate body expressions by AST node identity. */
export function uniqueExpressions(items: readonly Expression[]): readonly Expression[] {
  return items.length <= 1 ? items : [...new Set(items)];
}

/** The alternatives an expression can select as its value, without interpreting its condition. */
export function selectedValues(value: Expression): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse];
  }
  if (!isBinaryExpression(value)) {
    return undefined;
  }
  if (value.operatorToken.kind === SyntaxKind.CommaToken) {
    return [value.right];
  }
  return [
    SyntaxKind.AmpersandAmpersandToken,
    SyntaxKind.BarBarToken,
    SyntaxKind.QuestionQuestionToken,
  ].includes(value.operatorToken.kind)
    ? [value.left, value.right]
    : undefined;
}

const NESTED_DESCRIPTOR_PROJECTIONS = new WeakMap<SourceFile, Map<string, readonly Expression[]>>();

function descriptorProjectionCache(file: SourceFile): Map<string, readonly Expression[]> {
  const cached = NESTED_DESCRIPTOR_PROJECTIONS.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Map<string, readonly Expression[]>();
  NESTED_DESCRIPTOR_PROJECTIONS.set(file, created);
  return created;
}

/** Follows identifiers, branches, and literal member paths to extract nested descriptor values. */
export function nestedDescriptorValues(
  node: Expression,
  keys: readonly string[],
  seen: ReadonlySet<Expression>,
): readonly Expression[] {
  return resolveNestedDescriptorValues(
    node,
    keys,
    seen,
    descriptorProjectionCache(node.getSourceFile()),
  ).values;
}

function resolveNestedDescriptorValues(
  node: Expression,
  keys: readonly string[],
  seen: ReadonlySet<Expression>,
  memo: Map<string, readonly Expression[]>,
): { readonly cycled: boolean; readonly values: readonly Expression[] } {
  const value = unwrapped(node);
  if (keys.length === 0) {
    return { cycled: false, values: [value] };
  }
  if (seen.has(value)) {
    return { cycled: true, values: [] };
  }
  const cacheKey = `${String(value.pos)}:${String(value.end)}:${String(keys.length)}:${keys.join('\0')}`;
  const cached = memo.get(cacheKey);
  if (cached !== undefined) {
    return { cycled: false, values: cached };
  }
  const nextSeen = new Set([...seen, value]);
  let cycled = false;
  const collected: Expression[] = [];
  for (const entry of nestedProjectionEntries(value, keys)) {
    const sub = resolveNestedDescriptorValues(entry.value, entry.keys, nextSeen, memo);
    if (sub.cycled) {
      cycled = true;
    }
    collected.push(...sub.values);
  }
  const values = uniqueExpressions(collected);
  if (!cycled) {
    memo.set(cacheKey, values);
  }
  return { cycled, values };
}

function nestedProjectionEntries(
  value: Expression,
  keys: readonly string[],
): readonly { readonly keys: readonly string[]; readonly value: Expression }[] {
  const alternatives = selectedValues(value);
  if (alternatives !== undefined) {
    return alternatives.map((each) => ({ keys, value: each }));
  }
  if (isIdentifier(value)) {
    const held = framedHeldValues(value, keys, value);
    if (held === undefined) {
      return [];
    }
    return held.initial === undefined ? held.held : [held.initial, ...held.held];
  }
  const sources = framedObjectSources(value, keys);
  if (sources === undefined) {
    return [];
  }
  return sources.filter((each) => each.value !== value || each.keys.length !== keys.length);
}
