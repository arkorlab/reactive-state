import {
  type BindingElement,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBindingElement,
  isConditionalExpression,
  isIdentifier,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isVariableDeclaration,
  type Node,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  type AssignedBindingSource,
  bindingElementSteps,
  bindingReassignments,
  bindingStepKey,
  type CycleSeenState,
  declaredBindingTarget,
  isConstVariable,
  normalizeAssignmentSteps,
  STEP_OBJECT_REST,
} from './function-assignment-patterns.ts';
import {
  advanceAssignedExpressionSteps,
  advancePatternExpressions,
  candidateObjectsWithCycle,
  LOGICAL_FORWARDING,
  type VariableWriteMap,
  withCandidateBranch,
} from './function-candidate-objects.ts';
import {
  EMPTY_UNCLOSED_REST_COPIES,
  type ObjectRestCopy,
  type ObjectRestCopyResolution,
  RestCopyBuilder,
} from './function-rest-copy-builder.ts';
import { restTargetSafety } from './function-rest-target-writes.ts';
import { bindingIdentifiers } from './scope.ts';

export {
  EMPTY_EXCLUDED_KEYS,
  MAX_REST_COPY_CANDIDATES,
  type ObjectRestCopy,
  type ObjectRestCopyResolution,
} from './function-rest-copy-builder.ts';

const MAX_CLOSURE_CHECK_STEPS = 512;

interface ClosureCheckState {
  hitCycle: boolean;
  overflowed: boolean;
  readonly seen: Set<Node>;
  steps: number;
}

const CLOSED_HOLDER_MEMO = new WeakMap<VariableWriteMap, Map<Node, boolean>>();
const REST_COPY_MEMO = new WeakMap<VariableWriteMap, Map<Node, ObjectRestCopyResolution>>();

function perWriteMapMemo<T>(
  store: WeakMap<VariableWriteMap, Map<Node, T>>,
  variableWrites: VariableWriteMap,
): Map<Node, T> {
  let memo = store.get(variableWrites);
  if (memo === undefined) {
    memo = new Map();
    store.set(variableWrites, memo);
  }
  return memo;
}

/** Evaluates `run` in an isolated branch and caches `keyNode` when no cycle back-edge hit. */
function memoizedRestCopies(
  keyNode: Node,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
  run: (branch: CycleSeenState) => ObjectRestCopyResolution,
): ObjectRestCopyResolution {
  const memo = perWriteMapMemo(REST_COPY_MEMO, variableWrites);
  const cached = memo.get(keyNode);
  if (cached !== undefined) {
    return cached;
  }
  const branch: CycleSeenState = { hitCycle: false, seen: new Set(state.seen) };
  const raw = run(branch);
  if (branch.hitCycle) {
    state.hitCycle = true;
    return raw.closed ? { ...raw, closed: false } : raw;
  }
  memo.set(keyNode, raw);
  return raw;
}

/** Unions `extraExcluded` onto `source` without materializing combinations once `source` has overflowed. */
function withExtraExcluded(
  source: ObjectRestCopyResolution,
  extraExcluded: ReadonlySet<string>,
  hasDynamicExclusion: boolean,
): ObjectRestCopyResolution {
  if (source.overflowed) {
    return source;
  }
  if (extraExcluded.size === 0 || source.copies.length === 0) {
    return hasDynamicExclusion && source.closed ? { ...source, closed: false } : source;
  }
  const builder = new RestCopyBuilder(source.closed && !hasDynamicExclusion);
  for (const target of source.targets) {
    builder.addTarget(target);
  }
  for (const copy of source.copies) {
    builder.addCopy(copy.object, new Set([...extraExcluded, ...copy.excludedKeys]));
  }
  return builder.finish();
}

/** Collects bounded shallow object-rest copy resolution reachable from `node` (for `{ ...rest }`). */
export function resolveObjectRestCopies(
  node: Expression,
  variableWrites: VariableWriteMap,
  cycle: CycleSeenState,
): ObjectRestCopyResolution {
  return baseRestCopies(node, variableWrites, cycle);
}

/** Collects shallow object-rest copy sources reachable from `node` (for `{ ...rest }`). */
export function objectRestCopies(
  node: Expression,
  variableWrites: VariableWriteMap,
  cycle: CycleSeenState,
): readonly ObjectRestCopy[] {
  return baseRestCopies(node, variableWrites, cycle).copies;
}

/** Memoized cycle-aware lookup of `ObjectRestCopyResolution` from `node` with no outer exclusions. */
function baseRestCopies(
  node: Expression,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): ObjectRestCopyResolution {
  if (isIdentifier(node)) {
    return identifierRestCopies(node, variableWrites, state);
  }
  const arms = forwardedBranchArms(node);
  if (arms === undefined) {
    return EMPTY_UNCLOSED_REST_COPIES;
  }
  return memoizedRestCopies(node, variableWrites, state, (branch) => {
    const builder = new RestCopyBuilder(true);
    for (const arm of arms) {
      builder.addResolution(
        withCandidateBranch(branch, (inner) => baseRestCopies(arm, variableWrites, inner)),
      );
    }
    return builder.finish();
  });
}

/** Collects object-rest copy sources bound to `node` via destructuring declarations or reassignments. */
function identifierRestCopies(
  node: Identifier,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): ObjectRestCopyResolution {
  const declared = frameDeclarationOf(node);
  if (declared === undefined || !isVariableDeclaration(declared)) {
    return EMPTY_UNCLOSED_REST_COPIES;
  }
  const target = declaredBindingTarget(node, declared);
  const cached = perWriteMapMemo(REST_COPY_MEMO, variableWrites).get(target);
  if (cached !== undefined) {
    return cached;
  }
  if (state.seen.has(target)) {
    state.hitCycle = true;
    return EMPTY_UNCLOSED_REST_COPIES;
  }
  return memoizedRestCopies(target, variableWrites, state, (branch) => {
    branch.seen.add(target);
    const safety = restTargetSafety(node.getSourceFile());
    const constant = isConstVariable(declared);
    const builder = new RestCopyBuilder(constant && !safety.escaped.has(target));
    builder.addResolution(declarationRestCopies(node, declared, { state: branch, variableWrites }));
    if (!constant) {
      builder.addResolution(reassignedRestCopies(node, target, { state: branch, variableWrites }));
    }
    builder.addTarget(target);
    return builder.finish();
  });
}

/** Extracts object-rest copy sources from `const { a, ...rest } = init` or `const alias = rest`. */
function declarationRestCopies(
  node: Identifier,
  declared: VariableDeclaration,
  env: { readonly state: CycleSeenState; readonly variableWrites: VariableWriteMap },
): ObjectRestCopyResolution {
  const rawInit = declared.initializer;
  if (rawInit === undefined) {
    return EMPTY_UNCLOSED_REST_COPIES;
  }
  const init = unwrapped(rawInit);
  if (isIdentifier(declared.name)) {
    return baseRestCopies(init, env.variableWrites, env.state);
  }
  const bound = bindingIdentifiers(declared.name).find((each) => each.text === node.text);
  const steps = bound === undefined ? [] : bindingElementSteps(bound);
  const leaf = steps.at(-1);
  if (leaf === undefined) {
    return EMPTY_UNCLOSED_REST_COPIES;
  }
  const outerSteps = leaf.dotDotDotToken === undefined ? steps : steps.slice(0, -1);
  if (outerSteps.some((step) => step.dotDotDotToken !== undefined)) {
    return EMPTY_UNCLOSED_REST_COPIES;
  }
  let holders: Expression[] = [init];
  for (const step of outerSteps) {
    holders = advancePatternExpressions(holders, step, env.variableWrites, env.state);
  }
  if (leaf.dotDotDotToken !== undefined && isObjectBindingPattern(leaf.parent)) {
    const siblings = siblingObjectPatternKeys(leaf);
    return emitRestCopiesFromHolders(holders, {
      allowClosed: outerSteps.length === 0 && !siblings.hasDynamic,
      env,
      excludedKeys: siblings.keys,
    });
  }
  const builder = new RestCopyBuilder(false);
  for (const holder of holders) {
    builder.addResolution(baseRestCopies(holder, env.variableWrites, env.state));
  }
  return builder.finish();
}

/** Extracts object-rest copy sources from post-declaration writes and `({ a, ...rest } = src)`. */
function reassignedRestCopies(
  node: Identifier,
  target: Node,
  env: { readonly state: CycleSeenState; readonly variableWrites: VariableWriteMap },
): ObjectRestCopyResolution {
  const builder = new RestCopyBuilder(false);
  const writes = env.variableWrites.get(target);
  if (writes !== undefined) {
    for (const assigned of writes) {
      builder.addResolution(
        withCandidateBranch(env.state, (branch) =>
          baseRestCopies(assigned, env.variableWrites, branch),
        ),
      );
    }
  }
  const reassignments = bindingReassignments(node.getSourceFile()).get(target) ?? [];
  for (const source of reassignments) {
    if (writes === undefined || source.steps.length > 0) {
      builder.addResolution(
        withCandidateBranch(env.state, (branch) =>
          sourceRestCopies(source, { state: branch, variableWrites: env.variableWrites }),
        ),
      );
    }
  }
  return builder.finish();
}

/** Projects a single `AssignedBindingSource` for object-rest copy sources. */
function sourceRestCopies(
  source: AssignedBindingSource,
  env: { readonly state: CycleSeenState; readonly variableWrites: VariableWriteMap },
): ObjectRestCopyResolution {
  const steps = normalizeAssignmentSteps(source.steps);
  if (steps === undefined) {
    return EMPTY_UNCLOSED_REST_COPIES;
  }
  const leaf = steps.at(-1);
  if (leaf?.kind === STEP_OBJECT_REST) {
    const holders = advanceAssignedExpressionSteps(
      [source.root],
      steps.slice(0, -1),
      env.variableWrites,
      env.state,
    );
    return holders === undefined
      ? EMPTY_UNCLOSED_REST_COPIES
      : emitRestCopiesFromHolders(holders, {
          allowClosed: false,
          env,
          excludedKeys: leaf.excludedKeys,
        });
  }
  const holders = advanceAssignedExpressionSteps(
    [source.root],
    steps,
    env.variableWrites,
    env.state,
  );
  if (holders === undefined) {
    return EMPTY_UNCLOSED_REST_COPIES;
  }
  const builder = new RestCopyBuilder(false);
  for (const holder of holders) {
    builder.addResolution(baseRestCopies(holder, env.variableWrites, env.state));
  }
  return builder.finish();
}

/** Emits direct `ObjectRestCopy` items plus chained rest copies for `holders` under `excludedKeys`. */
function emitRestCopiesFromHolders(
  holders: readonly Expression[],
  options: {
    readonly allowClosed: boolean;
    readonly env: { readonly state: CycleSeenState; readonly variableWrites: VariableWriteMap };
    readonly excludedKeys: ReadonlySet<string>;
  },
): ObjectRestCopyResolution {
  const { allowClosed, env, excludedKeys } = options;
  const builder = new RestCopyBuilder(allowClosed && holders.length > 0);
  for (const holder of holders) {
    const objs = withCandidateBranch(env.state, (branch) =>
      candidateObjectsWithCycle(holder, env.variableWrites, branch),
    );
    for (const object of objs) {
      builder.addCopy(object, excludedKeys);
    }
    const chained = withCandidateBranch(env.state, (branch) =>
      baseRestCopies(holder, env.variableWrites, branch),
    );
    const expanded = withExtraExcluded(chained, excludedKeys, false);
    if (expanded.copies.length > 0 || expanded.overflowed) {
      builder.addResolution(expanded);
    }
    if (builder.closed && !isClosedRestSourceHolder(holder, env.variableWrites)) {
      builder.closed = false;
    }
  }
  return builder.finish();
}

/** Whether every runtime branch of `holder` resolves to closed direct objects or closed rest copies. */
function isClosedRestSourceHolder(holder: Expression, variableWrites: VariableWriteMap): boolean {
  return checkClosedHolder(holder, variableWrites, {
    hitCycle: false,
    overflowed: false,
    seen: new Set(),
    steps: 0,
  });
}

function checkClosedHolder(
  rawHolder: Expression,
  variableWrites: VariableWriteMap,
  state: ClosureCheckState,
): boolean {
  state.steps += 1;
  if (state.steps > MAX_CLOSURE_CHECK_STEPS) {
    state.overflowed = true;
    return false;
  }
  const holder = unwrapped(rawHolder);
  if (isObjectLiteralExpression(holder)) {
    return true;
  }
  if (isIdentifier(holder)) {
    return checkClosedIdentifierHolder(holder, variableWrites, state);
  }
  const branches = forwardedBranchArms(holder);
  return branches !== undefined && checkClosedBranchHolder(holder, branches, variableWrites, state);
}

function checkClosedBranchHolder(
  holder: Expression,
  branches: readonly [Expression, Expression],
  variableWrites: VariableWriteMap,
  state: ClosureCheckState,
): boolean {
  const memo = perWriteMapMemo(CLOSED_HOLDER_MEMO, variableWrites);
  const cached = memo.get(holder);
  if (cached !== undefined) {
    return cached;
  }
  const left = runClosureBranch(state, undefined, (branch) =>
    checkClosedHolder(branches[0], variableWrites, branch),
  );
  if (!left.closed) {
    if (left.cacheable) {
      memo.set(holder, false);
    }
    return false;
  }
  const right = runClosureBranch(state, undefined, (branch) =>
    checkClosedHolder(branches[1], variableWrites, branch),
  );
  if (left.cacheable && right.cacheable) {
    memo.set(holder, right.closed);
  }
  return right.closed;
}

function checkClosedIdentifierHolder(
  holder: Identifier,
  variableWrites: VariableWriteMap,
  state: ClosureCheckState,
): boolean {
  const declared = frameDeclarationOf(holder);
  if (declared === undefined || !isVariableDeclaration(declared)) {
    return false;
  }
  const target = declaredBindingTarget(holder, declared);
  const memo = perWriteMapMemo(CLOSED_HOLDER_MEMO, variableWrites);
  const cached = memo.get(target);
  if (cached !== undefined) {
    return cached;
  }
  if (state.seen.has(target)) {
    state.hitCycle = true;
    return false;
  }
  const chainedCycle: CycleSeenState = { hitCycle: false, seen: new Set(state.seen) };
  const chained = baseRestCopies(holder, variableWrites, chainedCycle);
  if (chainedCycle.hitCycle) {
    state.hitCycle = true;
  }
  if (chained.closed && chained.copies.length > 0) {
    if (!chainedCycle.hitCycle) {
      memo.set(target, true);
    }
    return true;
  }
  const rawInit = declared.initializer;
  if (
    rawInit === undefined ||
    !isIdentifier(declared.name) ||
    !isConstVariable(declared) ||
    restTargetSafety(holder.getSourceFile()).escaped.has(target)
  ) {
    if (!chainedCycle.hitCycle) {
      memo.set(target, false);
    }
    return false;
  }
  const outcome = runClosureBranch(state, target, (branch) =>
    checkClosedHolder(rawInit, variableWrites, branch),
  );
  if (!chainedCycle.hitCycle && outcome.cacheable) {
    memo.set(target, outcome.closed);
  }
  return outcome.closed;
}

function runClosureBranch(
  state: ClosureCheckState,
  extraSeen: Node | undefined,
  run: (branch: ClosureCheckState) => boolean,
): { readonly cacheable: boolean; readonly closed: boolean } {
  const seen = new Set(state.seen);
  if (extraSeen !== undefined) {
    seen.add(extraSeen);
  }
  const branch: ClosureCheckState = {
    hitCycle: false,
    overflowed: false,
    seen,
    steps: state.steps,
  };
  const closed = run(branch);
  state.steps = branch.steps;
  if (branch.hitCycle) {
    state.hitCycle = true;
  }
  if (branch.overflowed) {
    state.overflowed = true;
  }
  return { cacheable: !branch.hitCycle && !branch.overflowed, closed };
}

function forwardedBranchArms(holder: Expression): readonly [Expression, Expression] | undefined {
  if (isConditionalExpression(holder)) {
    return [unwrapped(holder.whenTrue), unwrapped(holder.whenFalse)];
  }
  if (isBinaryExpression(holder) && LOGICAL_FORWARDING.has(holder.operatorToken.kind)) {
    return [unwrapped(holder.left), unwrapped(holder.right)];
  }
  return undefined;
}

/** Static sibling keys preceding an object binding rest element `...rest`, plus computed-key flag. */
function siblingObjectPatternKeys(restElement: BindingElement): {
  readonly hasDynamic: boolean;
  readonly keys: ReadonlySet<string>;
} {
  const keys = new Set<string>();
  let hasDynamic = false;
  if (!isObjectBindingPattern(restElement.parent)) {
    return { hasDynamic, keys };
  }
  for (const element of restElement.parent.elements) {
    if (element === restElement) {
      break;
    }
    if (isBindingElement(element) && element.dotDotDotToken === undefined) {
      const key = bindingStepKey(element);
      if (key === undefined) {
        hasDynamic = true;
      } else {
        keys.add(key);
      }
    }
  }
  return { hasDynamic, keys };
}
