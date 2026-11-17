import {
  type BindingElement,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBindingElement,
  isConditionalExpression,
  isIdentifier,
  isObjectBindingPattern,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
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
import { bindingIdentifiers } from './scope.ts';

/** Shallow object-rest copy source together with statically excluded sibling keys. */
export interface ObjectRestCopy {
  readonly excludedKeys: ReadonlySet<string>;
  readonly object: ObjectLiteralExpression;
}

const REST_COPY_MEMO = new WeakMap<VariableWriteMap, Map<Node, readonly ObjectRestCopy[]>>();

/** Returns the per-`VariableWriteMap` cache of cycle-free `ObjectRestCopy` evaluations. */
function restCopyMemo(variableWrites: VariableWriteMap): Map<Node, readonly ObjectRestCopy[]> {
  let memo = REST_COPY_MEMO.get(variableWrites);
  if (memo === undefined) {
    memo = new Map();
    REST_COPY_MEMO.set(variableWrites, memo);
  }
  return memo;
}

/** Deduplicates `ObjectRestCopy` entries by source object identity and excluded key set. */
function deduplicateRestCopies(copies: readonly ObjectRestCopy[]): readonly ObjectRestCopy[] {
  if (copies.length <= 1) {
    return copies;
  }
  const seen = new Map<ObjectLiteralExpression, ReadonlySet<string>[]>();
  const unique: ObjectRestCopy[] = [];
  for (const copy of copies) {
    const bucket = seen.get(copy.object) ?? [];
    if (bucket.every((prev) => !sameKeySet(prev, copy.excludedKeys))) {
      bucket.push(copy.excludedKeys);
      seen.set(copy.object, bucket);
      unique.push(copy);
    }
  }
  return unique;
}

function sameKeySet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) {
    if (!right.has(key)) return false;
  }
  return true;
}

/** Evaluates `run` in an isolated branch and caches `keyNode` when no cycle back-edge hit. */
function memoizedRestCopies(
  keyNode: Node,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
  run: (branch: CycleSeenState) => readonly ObjectRestCopy[],
): readonly ObjectRestCopy[] {
  const memo = restCopyMemo(variableWrites);
  const cached = memo.get(keyNode);
  if (cached !== undefined) {
    return cached;
  }
  const branch: CycleSeenState = { hitCycle: false, seen: new Set(state.seen) };
  const result = deduplicateRestCopies(run(branch));
  if (branch.hitCycle) {
    state.hitCycle = true;
  } else {
    memo.set(keyNode, result);
  }
  return result;
}

/** Unions `extraExcluded` onto every `ObjectRestCopy` in `copies`. */
function withExtraExcluded(
  copies: readonly ObjectRestCopy[],
  extraExcluded: ReadonlySet<string>,
): readonly ObjectRestCopy[] {
  if (extraExcluded.size === 0 || copies.length === 0) {
    return copies;
  }
  return deduplicateRestCopies(
    copies.map((copy) => {
      return {
        excludedKeys: new Set([...extraExcluded, ...copy.excludedKeys]),
        object: copy.object,
      };
    }),
  );
}

/** Collects shallow object-rest copy sources reachable from `node` (for `{ ...rest }`). */
export function objectRestCopies(
  node: Expression,
  variableWrites: VariableWriteMap,
  cycle: CycleSeenState,
): readonly ObjectRestCopy[] {
  return baseRestCopies(node, variableWrites, cycle);
}

/** Memoized cycle-aware lookup of `ObjectRestCopy` sources from `node` with no outer exclusions. */
function baseRestCopies(
  node: Expression,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly ObjectRestCopy[] {
  if (isIdentifier(node)) {
    return identifierRestCopies(node, variableWrites, state);
  }
  if (
    !isConditionalExpression(node) &&
    !(isBinaryExpression(node) && LOGICAL_FORWARDING.has(node.operatorToken.kind))
  ) {
    return [];
  }
  return memoizedRestCopies(node, variableWrites, state, (branch) =>
    branchRestCopies(node, variableWrites, branch),
  );
}

/** Evaluates conditional and logical branch `ObjectRestCopy` sources for `node`. */
function branchRestCopies(
  node: Expression,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly ObjectRestCopy[] {
  if (isConditionalExpression(node)) {
    return [
      ...withCandidateBranch(state, (branch) =>
        baseRestCopies(unwrapped(node.whenTrue), variableWrites, branch),
      ),
      ...withCandidateBranch(state, (branch) =>
        baseRestCopies(unwrapped(node.whenFalse), variableWrites, branch),
      ),
    ];
  }
  if (isBinaryExpression(node) && LOGICAL_FORWARDING.has(node.operatorToken.kind)) {
    return [
      ...withCandidateBranch(state, (branch) =>
        baseRestCopies(unwrapped(node.left), variableWrites, branch),
      ),
      ...withCandidateBranch(state, (branch) =>
        baseRestCopies(unwrapped(node.right), variableWrites, branch),
      ),
    ];
  }
  return [];
}

/** Collects object-rest copy sources bound to `node` via destructuring declarations or reassignments. */
function identifierRestCopies(
  node: Identifier,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly ObjectRestCopy[] {
  const declared = frameDeclarationOf(node);
  if (declared === undefined || !isVariableDeclaration(declared)) {
    return [];
  }
  const target = declaredBindingTarget(node, declared);
  const cached = restCopyMemo(variableWrites).get(target);
  if (cached !== undefined) {
    return cached;
  }
  if (state.seen.has(target)) {
    state.hitCycle = true;
    return [];
  }
  return memoizedRestCopies(target, variableWrites, state, (branch) => {
    branch.seen.add(target);
    const copies: ObjectRestCopy[] = [
      ...declarationRestCopies(node, declared, { state: branch, variableWrites }),
    ];
    if (!isConstVariable(declared)) {
      copies.push(...reassignedRestCopies(node, target, { state: branch, variableWrites }));
    }
    return copies;
  });
}

/** Extracts object-rest copy sources from `const { a, ...rest } = init` or `const alias = rest`. */
function declarationRestCopies(
  node: Identifier,
  declared: VariableDeclaration,
  env: { readonly state: CycleSeenState; readonly variableWrites: VariableWriteMap },
): readonly ObjectRestCopy[] {
  if (declared.initializer === undefined) {
    return [];
  }
  const init = unwrapped(declared.initializer);
  if (isIdentifier(declared.name)) {
    return baseRestCopies(init, env.variableWrites, env.state);
  }
  const bound = bindingIdentifiers(declared.name).find((each) => each.text === node.text);
  const steps = bound === undefined ? [] : bindingElementSteps(bound);
  const leaf = steps.at(-1);
  if (leaf === undefined) {
    return [];
  }
  const outerSteps = leaf.dotDotDotToken === undefined ? steps : steps.slice(0, -1);
  if (outerSteps.some((step) => step.dotDotDotToken !== undefined)) {
    return [];
  }
  let holders: Expression[] = [init];
  for (const step of outerSteps) {
    holders = advancePatternExpressions(holders, step, env.variableWrites, env.state);
  }
  if (leaf.dotDotDotToken !== undefined && isObjectBindingPattern(leaf.parent)) {
    return emitRestCopiesFromHolders(holders, siblingObjectPatternKeys(leaf), env);
  }
  return holders.flatMap((holder) => baseRestCopies(holder, env.variableWrites, env.state));
}

/** Extracts object-rest copy sources from post-declaration writes and `({ a, ...rest } = src)`. */
function reassignedRestCopies(
  node: Identifier,
  target: Node,
  env: { readonly state: CycleSeenState; readonly variableWrites: VariableWriteMap },
): readonly ObjectRestCopy[] {
  const copies: ObjectRestCopy[] = [];
  const writes = env.variableWrites.get(target);
  if (writes !== undefined) {
    for (const assigned of writes) {
      copies.push(
        ...withCandidateBranch(env.state, (branch) =>
          baseRestCopies(assigned, env.variableWrites, branch),
        ),
      );
    }
  }
  const reassignments = bindingReassignments(node.getSourceFile()).get(target) ?? [];
  for (const source of reassignments) {
    if (writes === undefined || source.steps.length > 0) {
      copies.push(
        ...withCandidateBranch(env.state, (branch) =>
          sourceRestCopies(source, { state: branch, variableWrites: env.variableWrites }),
        ),
      );
    }
  }
  return copies;
}

/** Projects a single `AssignedBindingSource` for object-rest copy sources. */
function sourceRestCopies(
  source: AssignedBindingSource,
  env: { readonly state: CycleSeenState; readonly variableWrites: VariableWriteMap },
): readonly ObjectRestCopy[] {
  const steps = normalizeAssignmentSteps(source.steps);
  if (steps === undefined) {
    return [];
  }
  const leaf = steps.at(-1);
  if (leaf?.kind === STEP_OBJECT_REST) {
    const holders = advanceAssignedExpressionSteps(
      [source.root],
      steps.slice(0, -1),
      env.variableWrites,
      env.state,
    );
    return holders === undefined ? [] : emitRestCopiesFromHolders(holders, leaf.excludedKeys, env);
  }
  const holders = advanceAssignedExpressionSteps(
    [source.root],
    steps,
    env.variableWrites,
    env.state,
  );
  if (holders === undefined) {
    return [];
  }
  return holders.flatMap((holder) => baseRestCopies(holder, env.variableWrites, env.state));
}

/** Emits direct `ObjectRestCopy` items plus chained rest copies for `holders` under `excludedKeys`. */
function emitRestCopiesFromHolders(
  holders: readonly Expression[],
  excludedKeys: ReadonlySet<string>,
  env: { readonly state: CycleSeenState; readonly variableWrites: VariableWriteMap },
): readonly ObjectRestCopy[] {
  const out: ObjectRestCopy[] = [];
  for (const holder of holders) {
    const objs = withCandidateBranch(env.state, (branch) =>
      candidateObjectsWithCycle(holder, env.variableWrites, branch),
    );
    for (const object of objs) {
      out.push({ excludedKeys, object });
    }
    const chained = withCandidateBranch(env.state, (branch) =>
      baseRestCopies(holder, env.variableWrites, branch),
    );
    out.push(...withExtraExcluded(chained, excludedKeys));
  }
  return deduplicateRestCopies(out);
}

/** Static sibling keys preceding an object binding rest element `...rest`. */
function siblingObjectPatternKeys(restElement: BindingElement): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!isObjectBindingPattern(restElement.parent)) {
    return keys;
  }
  for (const element of restElement.parent.elements) {
    if (element === restElement) {
      break;
    }
    if (isBindingElement(element) && element.dotDotDotToken === undefined) {
      const key = bindingStepKey(element);
      if (key !== undefined) {
        keys.add(key);
      }
    }
  }
  return keys;
}
