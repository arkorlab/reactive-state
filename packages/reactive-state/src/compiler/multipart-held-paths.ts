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
  readonly isAssertedFormData: (raw: Expression, keys: readonly string[]) => boolean;
  readonly isBindingTypedFormData: (id: Identifier, keys: readonly string[]) => boolean;
  readonly readParameter: (
    name: Identifier,
    parameter: ParameterDeclaration,
  ) => {
    readonly ambiguous?: boolean | undefined;
    readonly dynamicOpaque?: boolean | undefined;
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
  readonly enclosingBindingTyped: boolean;
  readonly held: Held;
}

interface ChildCandidate {
  readonly enclosingBindingTyped?: boolean | undefined;
  readonly held: Held;
}

interface ExpandedStep {
  readonly ambiguous: boolean;
  readonly bindingTypedFormData: boolean;
  readonly children: readonly ChildCandidate[];
  readonly closed: boolean;
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
    {
      activeBindings: new Map(),
      activeExpressions: new Set(),
      enclosingBindingTyped: false,
      held: entry,
    },
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
  if (markVisitedHeldPath(seen, value, at.held.keys, at.enclosingBindingTyped)) {
    return { ambiguous: false, closed: true, next: [], typedFormData: false };
  }
  const assertedFormData = callbacks.isAssertedFormData(at.held.value, at.held.keys);
  const activeBindings = nextActiveBindings(at.activeBindings, value);
  const activeExpressions = new Set([...at.activeExpressions, value]);
  const expanded = expandHeldStep(at, value, point, callbacks);
  const unclosedEnclosingTyped = !expanded.closed && at.enclosingBindingTyped;
  return {
    ambiguous: expanded.ambiguous,
    closed: expanded.closed,
    next: expanded.children.map((child) => {
      return {
        activeBindings,
        activeExpressions,
        enclosingBindingTyped: child.enclosingBindingTyped ?? at.enclosingBindingTyped,
        held: child.held,
      };
    }),
    typedFormData: assertedFormData || expanded.bindingTypedFormData || unclosedEnclosingTyped,
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

/** Records `(value, keys, enclosingTyped)` in `seen`, returning `true` when already expanded. */
function markVisitedHeldPath(
  seen: Map<Expression, Set<string>>,
  value: Expression,
  keys: readonly string[],
  enclosingBindingTyped: boolean,
): boolean {
  const serialized = `${enclosingBindingTyped ? '1' : '0'}:${JSON.stringify(keys)}`;
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

/** Wraps plain `Held` entries into `ChildCandidate` items preserving enclosing type state. */
function plainChildren(entries: readonly Held[]): readonly ChildCandidate[] {
  return entries.map((held) => ({ held }));
}

/** Expands one non-empty `Held` member path step into successor `Held` candidates. */
function expandHeldStep(
  at: HeldWorkItem,
  value: Expression,
  point: Node,
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
    return {
      ambiguous: false,
      bindingTypedFormData: false,
      children:
        memberKey === undefined
          ? []
          : plainChildren([{ keys: [memberKey, ...keys], value: value.expression }]),
      closed: memberKey !== undefined,
    };
  }
  if (isArrayLiteralExpression(value)) {
    const [firstKey, ...restKeys] = keys;
    return firstKey === undefined
      ? { ambiguous: false, bindingTypedFormData: false, children: [], closed: true }
      : arrayPathEntries(value, firstKey, restKeys);
  }
  if (isIdentifier(value)) {
    return expandIdentifierStep(value, keys, point, callbacks);
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
    children: plainChildren(entries),
    closed: entries.length === objectSources.length,
  };
}

/** Expands a variable or parameter identifier along `keys`, guarding replaced binding types. */
function expandIdentifierStep(
  id: Identifier,
  keys: readonly string[],
  point: Node,
  callbacks: ProjectionCallbacks,
): ExpandedStep {
  const selected = frameBindingOf(id);
  if (selected === undefined) {
    return { ambiguous: false, bindingTypedFormData: false, children: [], closed: false };
  }
  const defaults =
    selected.keys.length === 0
      ? []
      : callbacks.bindingDefaults(id, selected.binding.name).map((value) => ({ keys, value }));
  if (isVariableDeclaration(selected.binding)) {
    return expandVariableIdentifier(id, selected.binding, { callbacks, defaults, keys, point });
  }
  if (!isParameterDeclaration(selected.binding)) {
    return { ambiguous: false, bindingTypedFormData: false, children: [], closed: false };
  }
  const resolved = callbacks.readParameter(id, selected.binding);
  const fromSources = resolved.sources.map((each) => {
    return {
      enclosingBindingTyped: false,
      held: { keys: [...each.keys, ...keys], value: each.value },
    };
  });
  if (resolved.replaced && resolved.ambiguous !== true) {
    return {
      ambiguous: Boolean(resolved.dynamicOpaque),
      bindingTypedFormData: false,
      children: fromSources,
      closed: resolved.dynamicOpaque !== true,
    };
  }
  const fullKeys = [...selected.keys, ...keys];
  const paramDefault =
    selected.binding.initializer === undefined
      ? []
      : [
          {
            enclosingBindingTyped: false,
            held: { keys: fullKeys, value: selected.binding.initializer },
          },
        ];
  const defaultChildren = defaults.map((held) => ({ enclosingBindingTyped: false, held }));
  return {
    ambiguous: Boolean(resolved.dynamicOpaque),
    bindingTypedFormData: callbacks.isBindingTypedFormData(id, keys),
    children: [...fromSources, ...paramDefault, ...defaultChildren],
    closed: false,
  };
}

/** Expands a `VariableDeclaration` identifier along `keys`, preserving binding type only while live. */
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
  const declaredTyped = callbacks.isBindingTypedFormData(id, keys);
  const patternChildren = patternScan.extraSources.map((each) => {
    return {
      enclosingBindingTyped: false,
      held: { keys: [...each.keys, ...keys], value: each.value },
    };
  });
  const defaultChildren = defaults.map((entry) => ({ enclosingBindingTyped: false, held: entry }));
  if (held === undefined) {
    return {
      ambiguous: patternScan.dynamicOpaque,
      bindingTypedFormData: declaredTyped,
      children: [...patternChildren, ...defaultChildren],
      closed: false,
    };
  }
  const initialChildren =
    held.initial === undefined
      ? []
      : [{ enclosingBindingTyped: declaredTyped, held: held.initial }];
  const heldChildren = held.held.map((entry) => {
    return {
      enclosingBindingTyped: declaredTyped,
      held: entry,
    };
  });
  const hasSources =
    initialChildren.length > 0 || heldChildren.length > 0 || patternChildren.length > 0;
  const closed = !patternScan.ambiguous && hasSources;
  const initialSurvives =
    held.initial !== undefined ||
    (declaration.initializer === undefined && heldChildren.length === 0);
  return {
    ambiguous: patternScan.dynamicOpaque,
    bindingTypedFormData: !closed && initialSurvives && declaredTyped,
    children: [...initialChildren, ...heldChildren, ...patternChildren, ...defaultChildren],
    closed,
  };
}

/** Selects matching element and spread-offset candidates from an `ArrayLiteralExpression` for `firstKey`. */
function arrayPathEntries(
  array: ArrayLiteralExpression,
  firstKey: string,
  restKeys: readonly string[],
): ExpandedStep {
  if (!/^\d+$/u.test(firstKey)) {
    return { ambiguous: false, bindingTypedFormData: false, children: [], closed: true };
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
      return {
        ambiguous: true,
        bindingTypedFormData: false,
        children: plainChildren(entries),
        closed: false,
      };
    }
    spreadSeen = true;
  }
  return {
    ambiguous: false,
    bindingTypedFormData: false,
    children: plainChildren(entries),
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
