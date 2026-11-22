export interface ExportLookup<T> {
  readonly kind: 'cycle' | 'exported' | 'none';
  readonly value?: T | undefined;
}

export interface ExportTarget {
  readonly file: string;
  readonly key: string;
  readonly name: string;
}

export type ExportRule<T> =
  | { readonly kind: 'const'; readonly lookup: ExportLookup<T> }
  | { readonly dep: ExportTarget; readonly kind: 'reexport' }
  | { readonly dep: ExportTarget; readonly kind: 'settledImport' }
  | { readonly deps: readonly ExportTarget[]; readonly kind: 'star' };

interface TarjanFrame {
  readonly deps: readonly ExportTarget[];
  nextIndex: number;
  readonly node: string;
}

interface TarjanState<T> {
  readonly callStack: TarjanFrame[];
  readonly indices: Map<string, number>;
  readonly lowlink: Map<string, number>;
  readonly memo: Map<string, ExportLookup<T>>;
  nextOrder: number;
  readonly onStack: Set<string>;
  readonly readRule: (target: ExportTarget) => ExportRule<T>;
  readonly rules: Map<string, ExportRule<T>>;
  readonly sccStack: string[];
}

export const NO_EXPORT: ExportLookup<never> = { kind: 'none' };
export const CYCLE_EXPORT: ExportLookup<never> = { kind: 'cycle' };
export const EXPORTED_UNKNOWN: ExportLookup<never> = { kind: 'exported', value: undefined };

/** Builds a canonical lookup target for `name` exported by `file`. */
export function exportTarget(file: string, name: string): ExportTarget {
  return { file, key: `${file}\0${name}`, name };
}

/**
 * Resolves `entry` across arbitrary cyclic `export *` and indirect re-export graphs in time
 * linear in the reachable `(file, name)` vertices and edges.
 */
export function resolveExportGraph<T>(
  entry: ExportTarget,
  readRule: (target: ExportTarget) => ExportRule<T>,
  memo = new Map<string, ExportLookup<T>>(),
): ExportLookup<T> {
  const cached = memo.get(entry.key);
  if (cached !== undefined) {
    return cached;
  }
  const state: TarjanState<T> = {
    callStack: [],
    indices: new Map(),
    lowlink: new Map(),
    memo,
    nextOrder: 0,
    onStack: new Set(),
    readRule,
    rules: new Map(),
    sccStack: [],
  };
  enterTarget(entry, state);
  while (state.callStack.length > 0) {
    stepTarjan(state);
  }
  return memo.get(entry.key) ?? NO_EXPORT;
}

function enterTarget<T>(target: ExportTarget, state: TarjanState<T>): void {
  const rule = state.readRule(target);
  const order = state.nextOrder;
  state.nextOrder += 1;
  state.rules.set(target.key, rule);
  state.indices.set(target.key, order);
  state.lowlink.set(target.key, order);
  state.sccStack.push(target.key);
  state.onStack.add(target.key);
  state.callStack.push({ deps: ruleDeps(rule), nextIndex: 0, node: target.key });
}

function stepTarjan<T>(state: TarjanState<T>): void {
  const frame = state.callStack.at(-1);
  if (frame === undefined) {
    return;
  }
  const dep = frame.deps[frame.nextIndex];
  if (dep !== undefined) {
    frame.nextIndex += 1;
    advanceEdge(frame.node, dep, state);
    return;
  }
  state.callStack.pop();
  finishFrame(frame.node, state);
}

function advanceEdge<T>(fromKey: string, dep: ExportTarget, state: TarjanState<T>): void {
  if (state.memo.has(dep.key)) {
    return;
  }
  const depIndex = state.indices.get(dep.key);
  if (depIndex === undefined) {
    enterTarget(dep, state);
    return;
  }
  if (state.onStack.has(dep.key)) {
    const currentLow = state.lowlink.get(fromKey) ?? depIndex;
    state.lowlink.set(fromKey, Math.min(currentLow, depIndex));
  }
}

function finishFrame<T>(nodeKey: string, state: TarjanState<T>): void {
  const nodeLow = state.lowlink.get(nodeKey) ?? 0;
  const parent = state.callStack.at(-1);
  if (parent !== undefined) {
    const parentLow = state.lowlink.get(parent.node) ?? nodeLow;
    state.lowlink.set(parent.node, Math.min(parentLow, nodeLow));
  }
  if (nodeLow === state.indices.get(nodeKey)) {
    const members = popSccMembers(nodeKey, state);
    solveScc(members, state.rules, state.memo);
  }
}

function popSccMembers<T>(rootKey: string, state: TarjanState<T>): string[] {
  const members: string[] = [];
  while (state.sccStack.length > 0) {
    const member = state.sccStack.pop();
    if (member === undefined) {
      break;
    }
    state.onStack.delete(member);
    members.push(member);
    if (member === rootKey) {
      break;
    }
  }
  return members;
}

function solveScc<T>(
  members: readonly string[],
  rules: ReadonlyMap<string, ExportRule<T>>,
  memo: Map<string, ExportLookup<T>>,
): void {
  const single = members.length === 1 ? members[0] : undefined;
  const singleRule = single === undefined ? undefined : rules.get(single);
  if (single !== undefined && singleRule !== undefined && !hasSelfLoop(single, singleRule)) {
    memo.set(single, evaluateAcyclicRule(singleRule, memo));
    return;
  }
  solveCyclicScc(members, rules, memo);
}

function hasSelfLoop<T>(nodeKey: string, rule: ExportRule<T>): boolean {
  return ruleDeps(rule).some((dep) => dep.key === nodeKey);
}

function evaluateAcyclicRule<T>(
  rule: ExportRule<T>,
  memo: ReadonlyMap<string, ExportLookup<T>>,
): ExportLookup<T> {
  if (rule.kind === 'const') {
    return rule.lookup;
  }
  if (rule.kind === 'settledImport') {
    const remote = memo.get(rule.dep.key) ?? NO_EXPORT;
    return { kind: 'exported', value: remote.value };
  }
  if (rule.kind === 'reexport') {
    const remote = memo.get(rule.dep.key) ?? NO_EXPORT;
    return remote.kind === 'none' ? EXPORTED_UNKNOWN : remote;
  }
  return evaluateStarRule(rule.deps, (key) => memo.get(key) ?? NO_EXPORT);
}

interface SccContext<T> {
  readonly current: Map<string, ExportLookup<T>>;
  readonly dependents: ReadonlyMap<string, readonly string[]>;
  readonly memo: ReadonlyMap<string, ExportLookup<T>>;
  readonly rules: ReadonlyMap<string, ExportRule<T>>;
}

function solveCyclicScc<T>(
  members: readonly string[],
  rules: ReadonlyMap<string, ExportRule<T>>,
  memo: Map<string, ExportLookup<T>>,
): void {
  const inScc = new Set(members);
  const current = new Map<string, ExportLookup<T>>();
  const dependents = buildSccDependents(members, inScc, rules, current);
  propagateSccFixpoint(members, { current, dependents, memo, rules });
  for (const member of members) {
    const state = current.get(member) ?? CYCLE_EXPORT;
    const rule = rules.get(member);
    memo.set(member, closeSccMember(state, rule));
  }
}

function buildSccDependents<T>(
  members: readonly string[],
  inScc: ReadonlySet<string>,
  rules: ReadonlyMap<string, ExportRule<T>>,
  current: Map<string, ExportLookup<T>>,
): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const member of members) {
    const rule = rules.get(member);
    if (rule === undefined) {
      continue;
    }
    current.set(member, initialCyclicState(rule));
    for (const dep of ruleDeps(rule)) {
      if (inScc.has(dep.key)) {
        appendDependent(dependents, dep.key, member);
      }
    }
  }
  return dependents;
}

function appendDependent(dependents: Map<string, string[]>, from: string, to: string): void {
  const existing = dependents.get(from);
  if (existing === undefined) {
    dependents.set(from, [to]);
  } else {
    existing.push(to);
  }
}

function initialCyclicState<T>(rule: ExportRule<T>): ExportLookup<T> {
  if (rule.kind === 'const') {
    return rule.lookup;
  }
  return rule.kind === 'settledImport' ? EXPORTED_UNKNOWN : CYCLE_EXPORT;
}

function propagateSccFixpoint<T>(members: readonly string[], context: SccContext<T>): void {
  const { current, dependents, memo, rules } = context;
  const queue = [...members];
  const queued = new Set(members);
  const readKey = (key: string): ExportLookup<T> => current.get(key) ?? memo.get(key) ?? NO_EXPORT;
  for (const member of queue) {
    queued.delete(member);
    const rule = rules.get(member);
    if (rule === undefined) {
      continue;
    }
    const previous = current.get(member) ?? CYCLE_EXPORT;
    const next = evaluateCyclicRule(rule, readKey);
    if (!sameLookup(previous, next)) {
      current.set(member, next);
      enqueueDependents(dependents.get(member), queued, queue);
    }
  }
}

function enqueueDependents(
  items: readonly string[] | undefined,
  queued: Set<string>,
  queue: string[],
): void {
  if (items === undefined) {
    return;
  }
  for (const item of items) {
    if (!queued.has(item)) {
      queued.add(item);
      queue.push(item);
    }
  }
}

function evaluateCyclicRule<T>(
  rule: ExportRule<T>,
  readKey: (key: string) => ExportLookup<T>,
): ExportLookup<T> {
  if (rule.kind === 'const') {
    return rule.lookup;
  }
  if (rule.kind === 'settledImport') {
    return EXPORTED_UNKNOWN;
  }
  if (rule.kind === 'reexport') {
    const remote = readKey(rule.dep.key);
    return remote.kind === 'none' ? EXPORTED_UNKNOWN : remote;
  }
  return evaluateStarRule(rule.deps, readKey);
}

function evaluateStarRule<T>(
  deps: readonly ExportTarget[],
  readKey: (key: string) => ExportLookup<T>,
): ExportLookup<T> {
  let star: ExportLookup<T> = NO_EXPORT;
  for (const dep of deps) {
    star = mergeStarLookup(star, readKey(dep.key));
  }
  return star;
}

function mergeStarLookup<T>(current: ExportLookup<T>, next: ExportLookup<T>): ExportLookup<T> {
  if (current.kind === 'none' || next.kind === 'none') {
    return current.kind === 'none' ? next : current;
  }
  if (current.kind === 'cycle' || next.kind === 'cycle') {
    return current.kind === 'cycle' ? next : current;
  }
  return current.value !== undefined && current.value === next.value ? current : EXPORTED_UNKNOWN;
}

function closeSccMember<T>(
  state: ExportLookup<T>,
  rule: ExportRule<T> | undefined,
): ExportLookup<T> {
  if (state.kind !== 'cycle') {
    return state;
  }
  return rule?.kind === 'star' ? NO_EXPORT : EXPORTED_UNKNOWN;
}

function sameLookup<T>(first: ExportLookup<T>, second: ExportLookup<T>): boolean {
  return first.kind === second.kind && first.value === second.value;
}

function ruleDeps<T>(rule: ExportRule<T>): readonly ExportTarget[] {
  if (rule.kind === 'const') {
    return [];
  }
  if (rule.kind === 'star') {
    return rule.deps;
  }
  return [rule.dep];
}
