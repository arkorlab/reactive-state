import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isElementAccessExpression,
  isIdentifier,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ParameterDeclaration,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedObjectSources } from './framed-object-members.ts';

/** Bounded member-path unfolding across aliases, arrays, literals, and parameter sources. */

export interface HeldResolution {
  readonly ambiguous: boolean;
  readonly closed: boolean;
  readonly expressions: readonly Expression[];
  readonly typedFormData: boolean;
}

export interface ProjectionCallbacks {
  readonly bindingDefaults: (
    name: Identifier,
    root: ParameterDeclaration['name'],
  ) => readonly Expression[];
  readonly isTypedFormData: (
    raw: Expression,
    value: Expression,
    keys: readonly string[],
  ) => boolean;
  readonly readParameter: (
    name: Identifier,
    parameter: ParameterDeclaration,
  ) => {
    readonly ambiguous?: boolean;
    readonly dynamicOpaque?: boolean;
    readonly replaced: boolean;
    readonly sources: readonly Held[];
  };
  readonly readVariablePattern: (
    name: Identifier,
    declaration: VariableDeclaration,
    point: Node,
  ) => {
    readonly ambiguous: boolean;
    readonly dynamicOpaque: boolean;
    readonly extraSources: readonly Held[];
  };
  readonly selectValues: (value: Expression) => readonly Expression[] | undefined;
}

interface HeldWorkItem {
  readonly activeBindings: ReadonlyMap<Node, ReadonlySet<string>>;
  readonly activeExpressions: ReadonlySet<Expression>;
  readonly held: Held;
}

interface ExpandedStep {
  readonly ambiguous: boolean;
  readonly closed: boolean;
  readonly entries: readonly Held[];
}

const PROJECTION_LIMITS = {
  maxDepth: 16,
} as const;

/** Unfolds a `Held` member path while cutting self-referential expansion cycles conservatively. */
export function inspectHeldPath(
  entry: Held,
  point: Node,
  callbacks: ProjectionCallbacks,
): HeldResolution {
  const expressions: Expression[] = [];
  let ambiguous = false;
  let closed = true;
  let typedFormData = false;
  const seen = new Map<Expression, Set<string>>();
  const pending: HeldWorkItem[] = [
    { activeBindings: new Map(), activeExpressions: new Set(), held: entry },
  ];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (at.held.keys.length === 0) {
      expressions.push(at.held.value);
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
  if (repeatsOnActiveChain(at, value)) {
    return { ambiguous: true, closed: false, next: [], typedFormData: false };
  }
  if (markVisitedHeldPath(seen, value, at.held.keys)) {
    return { ambiguous: false, closed: true, next: [], typedFormData: false };
  }
  const typedFormData = callbacks.isTypedFormData(at.held.value, value, at.held.keys);
  const activeBindings = nextActiveBindings(at.activeBindings, value);
  const activeExpressions = new Set([...at.activeExpressions, value]);
  const expanded = expandHeldStep(at.held, value, point, callbacks);
  return {
    ambiguous: expanded.ambiguous,
    closed: expanded.closed,
    next: expanded.entries.map((held) => ({ activeBindings, activeExpressions, held })),
    typedFormData,
  };
}

/** Whether `value` or its bound declaration+identifier repeats along the active expansion chain. */
function repeatsOnActiveChain(at: HeldWorkItem, value: Expression): boolean {
  if (at.activeExpressions.has(value)) {
    return true;
  }
  if (!isIdentifier(value)) {
    return false;
  }
  const selected = frameBindingOf(value);
  return (
    selected !== undefined && at.activeBindings.get(selected.binding)?.has(value.text) === true
  );
}

/** Records `(value, keys)` in `seen`, returning `true` when this exact pair was already expanded. */
function markVisitedHeldPath(
  seen: Map<Expression, Set<string>>,
  value: Expression,
  keys: readonly string[],
): boolean {
  const serialized = JSON.stringify(keys);
  const visited = seen.get(value) ?? new Set<string>();
  if (visited.has(serialized)) {
    return true;
  }
  visited.add(serialized);
  seen.set(value, visited);
  return false;
}

/** Extends `activeBindings` with `(binding, value.text)` when `value` is a bound identifier. */
function nextActiveBindings(
  activeBindings: ReadonlyMap<Node, ReadonlySet<string>>,
  value: Expression,
): ReadonlyMap<Node, ReadonlySet<string>> {
  if (!isIdentifier(value)) {
    return activeBindings;
  }
  const selected = frameBindingOf(value);
  if (selected === undefined) {
    return activeBindings;
  }
  const names = new Set([...(activeBindings.get(selected.binding) ?? []), value.text]);
  return new Map([...activeBindings, [selected.binding, names]]);
}

/** Expands one non-empty `Held` member path step into successor `Held` candidates. */
function expandHeldStep(
  at: Held,
  value: Expression,
  point: Node,
  callbacks: ProjectionCallbacks,
): ExpandedStep {
  const alternatives = callbacks.selectValues(value);
  if (alternatives !== undefined) {
    return {
      ambiguous: false,
      closed: true,
      entries: alternatives.map((each) => ({ keys: at.keys, value: each })),
    };
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const memberKey = frameMemberName(value);
    return {
      ambiguous: false,
      closed: memberKey !== undefined,
      entries:
        memberKey === undefined ? [] : [{ keys: [memberKey, ...at.keys], value: value.expression }],
    };
  }
  if (isArrayLiteralExpression(value)) {
    const [firstKey, ...restKeys] = at.keys;
    return firstKey === undefined
      ? { ambiguous: false, closed: true, entries: [] }
      : arrayPathEntries(value, firstKey, restKeys);
  }
  if (isIdentifier(value)) {
    return expandIdentifierStep(value, at.keys, point, callbacks);
  }
  const objectSources = framedObjectSources(value, at.keys);
  if (objectSources === undefined) {
    return { ambiguous: false, closed: false, entries: [] };
  }
  const entries = objectSources.filter(
    (each) => unwrapped(each.value) !== value || each.keys.length !== at.keys.length,
  );
  return {
    ambiguous: false,
    closed: entries.length === objectSources.length,
    entries,
  };
}

/** Expands a variable or parameter identifier along `keys`. */
function expandIdentifierStep(
  id: Identifier,
  keys: readonly string[],
  point: Node,
  callbacks: ProjectionCallbacks,
): ExpandedStep {
  const selected = frameBindingOf(id);
  if (selected === undefined) {
    return { ambiguous: false, closed: false, entries: [] };
  }
  const defaults =
    selected.keys.length === 0
      ? []
      : callbacks.bindingDefaults(id, selected.binding.name).map((value) => ({ keys, value }));
  if (isVariableDeclaration(selected.binding)) {
    return expandVariableIdentifier(id, selected.binding, { callbacks, defaults, keys, point });
  }
  if (!isParameterDeclaration(selected.binding)) {
    return { ambiguous: false, closed: false, entries: [] };
  }
  const resolved = callbacks.readParameter(id, selected.binding);
  const fromSources = resolved.sources.map((each) => {
    return {
      keys: [...each.keys, ...keys],
      value: each.value,
    };
  });
  if (resolved.replaced && resolved.ambiguous !== true) {
    return {
      ambiguous: Boolean(resolved.dynamicOpaque),
      closed: resolved.dynamicOpaque !== true,
      entries: fromSources,
    };
  }
  const fullKeys = [...selected.keys, ...keys];
  const paramDefault =
    selected.binding.initializer === undefined
      ? []
      : [{ keys: fullKeys, value: selected.binding.initializer }];
  return {
    ambiguous: Boolean(resolved.dynamicOpaque),
    closed: false,
    entries: [...fromSources, ...paramDefault, ...defaults],
  };
}

/** Expands a `VariableDeclaration` identifier along `keys`, including pattern reassignments. */
function expandVariableIdentifier(
  id: Identifier,
  declaration: VariableDeclaration,
  context: {
    readonly callbacks: ProjectionCallbacks;
    readonly defaults: readonly Held[];
    readonly keys: readonly string[];
    readonly point: Node;
  },
): ExpandedStep {
  const { callbacks, defaults, keys, point } = context;
  const held = framedHeldValues(id, keys, point);
  const patternScan = callbacks.readVariablePattern(id, declaration, point);
  const patternEntries = patternScan.extraSources.map((each) => {
    return {
      keys: [...each.keys, ...keys],
      value: each.value,
    };
  });
  if (held === undefined) {
    return {
      ambiguous: patternScan.dynamicOpaque,
      closed: false,
      entries: [...patternEntries, ...defaults],
    };
  }
  const baseEntries = [...(held.initial === undefined ? [] : [held.initial]), ...held.held];
  return {
    ambiguous: patternScan.dynamicOpaque,
    closed: !patternScan.ambiguous && (baseEntries.length > 0 || patternEntries.length > 0),
    entries: [...baseEntries, ...patternEntries, ...defaults],
  };
}

/** Selects matching element and spread-offset candidates from an `ArrayLiteralExpression` for `firstKey`. */
function arrayPathEntries(
  array: ArrayLiteralExpression,
  firstKey: string,
  restKeys: readonly string[],
): ExpandedStep {
  if (!/^\d+$/u.test(firstKey)) {
    return { ambiguous: false, closed: true, entries: [] };
  }
  const requestedIndex = Number(firstKey);
  const entries: Held[] = [];
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
        entries.push({ keys: restKeys, value: element });
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
    entries.push(...spreadSlice.entries);
    if (spreadSlice.ambiguous) {
      return { ambiguous: true, closed: false, entries };
    }
    spreadSeen = true;
  }
  return { ambiguous: false, closed: true, entries };
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
