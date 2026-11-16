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
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedObjectSources } from './framed-object-members.ts';

/** Bounded member-path unfolding across aliases, arrays, literals, and parameter sources. */

export interface HeldResolution {
  readonly ambiguous: boolean;
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
    readonly replaced: boolean;
    readonly sources: readonly Held[];
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
    if (step.typedFormData) {
      typedFormData = true;
    }
    pending.push(...step.next);
  }
  return { ambiguous, expressions, typedFormData };
}

/** Evaluates one non-empty `HeldWorkItem` against depth, cycle, and visited-path guards. */
function evaluateWorkItem(
  at: HeldWorkItem,
  point: Node,
  seen: Map<Expression, Set<string>>,
  callbacks: ProjectionCallbacks,
): {
  readonly ambiguous: boolean;
  readonly next: readonly HeldWorkItem[];
  readonly typedFormData: boolean;
} {
  if (at.held.keys.length > PROJECTION_LIMITS.maxDepth) {
    return { ambiguous: true, next: [], typedFormData: false };
  }
  const value = unwrapped(at.held.value);
  if (repeatsOnActiveChain(at, value)) {
    return { ambiguous: true, next: [], typedFormData: false };
  }
  if (markVisitedHeldPath(seen, value, at.held.keys)) {
    return { ambiguous: false, next: [], typedFormData: false };
  }
  const typedFormData = callbacks.isTypedFormData(at.held.value, value, at.held.keys);
  const activeBindings = nextActiveBindings(at.activeBindings, value);
  const activeExpressions = new Set([...at.activeExpressions, value]);
  const expanded = expandHeldStep(at.held, value, point, callbacks);
  return {
    ambiguous: expanded.ambiguous,
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
      entries: alternatives.map((each) => ({ keys: at.keys, value: each })),
    };
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const memberKey = frameMemberName(value);
    return {
      ambiguous: false,
      entries:
        memberKey === undefined ? [] : [{ keys: [memberKey, ...at.keys], value: value.expression }],
    };
  }
  if (isArrayLiteralExpression(value)) {
    const [firstKey, ...restKeys] = at.keys;
    return firstKey === undefined
      ? { ambiguous: false, entries: [] }
      : { ambiguous: false, entries: arrayPathEntries(value, firstKey, restKeys) };
  }
  if (isIdentifier(value)) {
    return { ambiguous: false, entries: expandIdentifierStep(value, at.keys, point, callbacks) };
  }
  const objectSources = framedObjectSources(value, at.keys);
  if (objectSources === undefined) {
    return { ambiguous: false, entries: [] };
  }
  return {
    ambiguous: false,
    entries: objectSources.filter(
      (each) => unwrapped(each.value) !== value || each.keys.length !== at.keys.length,
    ),
  };
}

/** Expands a variable or parameter identifier along `keys`. */
function expandIdentifierStep(
  id: Identifier,
  keys: readonly string[],
  point: Node,
  callbacks: ProjectionCallbacks,
): readonly Held[] {
  const selected = frameBindingOf(id);
  if (selected === undefined) {
    return [];
  }
  const defaults =
    selected.keys.length === 0
      ? []
      : callbacks.bindingDefaults(id, selected.binding.name).map((value) => ({ keys, value }));
  if (isVariableDeclaration(selected.binding)) {
    const held = framedHeldValues(id, keys, point);
    if (held === undefined) {
      return defaults;
    }
    return [...(held.initial === undefined ? [] : [held.initial]), ...held.held, ...defaults];
  }
  if (!isParameterDeclaration(selected.binding)) {
    return [];
  }
  const resolved = callbacks.readParameter(id, selected.binding);
  const fromSources = resolved.sources.map((each) => {
    return {
      keys: [...each.keys, ...keys],
      value: each.value,
    };
  });
  if (resolved.replaced && resolved.ambiguous !== true) {
    return fromSources;
  }
  const fullKeys = [...selected.keys, ...keys];
  const paramDefault =
    selected.binding.initializer === undefined
      ? []
      : [{ keys: fullKeys, value: selected.binding.initializer }];
  return [...fromSources, ...paramDefault, ...defaults];
}

/** Selects matching element candidates from an `ArrayLiteralExpression` for `firstKey`. */
function arrayPathEntries(
  array: ArrayLiteralExpression,
  firstKey: string,
  restKeys: readonly string[],
): readonly Held[] {
  const entries: Held[] = [];
  let spreadSeen = false;
  for (const [index, element] of array.elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (isSpreadElement(element)) {
      spreadSeen = true;
      entries.push({ keys: ['0', ...restKeys], value: element.expression });
    } else if (spreadSeen || String(index) === firstKey) {
      entries.push({ keys: restKeys, value: element });
    }
  }
  return entries;
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
