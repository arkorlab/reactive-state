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

const REST_COPY_MEMO = new WeakMap<VariableWriteMap, Map<Node, ObjectRestCopyResolution>>();

/** Returns the per-`VariableWriteMap` cache of cycle-free `ObjectRestCopyResolution` evaluations. */
function restCopyMemo(variableWrites: VariableWriteMap): Map<Node, ObjectRestCopyResolution> {
  let memo = REST_COPY_MEMO.get(variableWrites);
  if (memo === undefined) {
    memo = new Map();
    REST_COPY_MEMO.set(variableWrites, memo);
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
  const memo = restCopyMemo(variableWrites);
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
  if (
    !isConditionalExpression(node) &&
    !(isBinaryExpression(node) && LOGICAL_FORWARDING.has(node.operatorToken.kind))
  ) {
    return EMPTY_UNCLOSED_REST_COPIES;
  }
  return memoizedRestCopies(node, variableWrites, state, (branch) =>
    branchRestCopies(node, variableWrites, branch),
  );
}

/** Evaluates conditional and logical branch `ObjectRestCopyResolution` sources for `node`. */
function branchRestCopies(
  node: Expression,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): ObjectRestCopyResolution {
  if (isConditionalExpression(node)) {
    const builder = new RestCopyBuilder(true);
    builder.addResolution(
      withCandidateBranch(state, (branch) =>
        baseRestCopies(unwrapped(node.whenTrue), variableWrites, branch),
      ),
    );
    builder.addResolution(
      withCandidateBranch(state, (branch) =>
        baseRestCopies(unwrapped(node.whenFalse), variableWrites, branch),
      ),
    );
    return builder.finish();
  }
  if (isBinaryExpression(node) && LOGICAL_FORWARDING.has(node.operatorToken.kind)) {
    const builder = new RestCopyBuilder(true);
    builder.addResolution(
      withCandidateBranch(state, (branch) =>
        baseRestCopies(unwrapped(node.left), variableWrites, branch),
      ),
    );
    builder.addResolution(
      withCandidateBranch(state, (branch) =>
        baseRestCopies(unwrapped(node.right), variableWrites, branch),
      ),
    );
    return builder.finish();
  }
  return EMPTY_UNCLOSED_REST_COPIES;
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
  const cached = restCopyMemo(variableWrites).get(target);
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
    if (
      builder.closed &&
      !isClosedRestSourceHolder(holder, chained, env.variableWrites, new Set())
    ) {
      builder.closed = false;
    }
  }
  return builder.finish();
}

/** Whether every runtime branch of `holder` is accounted for by closed direct objects or `chained`. */
function isClosedRestSourceHolder(
  initialHolder: Expression,
  initialChained: ObjectRestCopyResolution,
  variableWrites: VariableWriteMap,
  seen: Set<Node>,
): boolean {
  let holder = initialHolder;
  let chained = initialChained;
  while (isIdentifier(holder)) {
    if (chained.closed && chained.copies.length > 0) {
      return true;
    }
    const next = stepClosedIdentifierHolder(holder, seen);
    if (next === undefined) {
      return false;
    }
    holder = next;
    chained = baseRestCopies(next, variableWrites, { hitCycle: false, seen: new Set() });
  }
  if (isObjectLiteralExpression(holder) || (chained.closed && chained.copies.length > 0)) {
    return true;
  }
  const branches = forwardedBranchArms(holder);
  if (branches === undefined) {
    return false;
  }
  return branches.every((arm) => {
    return isClosedRestSourceHolder(
      arm,
      baseRestCopies(arm, variableWrites, { hitCycle: false, seen: new Set() }),
      variableWrites,
      new Set(seen),
    );
  });
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

function stepClosedIdentifierHolder(holder: Identifier, seen: Set<Node>): Expression | undefined {
  const declared = frameDeclarationOf(holder);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    !isConstVariable(declared) ||
    seen.has(declared) ||
    restTargetSafety(holder.getSourceFile()).escaped.has(declared)
  ) {
    return undefined;
  }
  const rawInit = declared.initializer;
  if (rawInit === undefined) {
    return undefined;
  }
  seen.add(declared);
  return unwrapped(rawInit);
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
