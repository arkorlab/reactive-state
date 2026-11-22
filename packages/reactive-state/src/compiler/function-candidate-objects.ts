import {
  type BindingElement,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isBinaryExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  type AssignedBindingSource,
  type AssignmentStep,
  bindingElementSteps,
  bindingReassignments,
  bindingStepKey,
  type CycleSeenState,
  declaredBindingTarget,
  isConstVariable,
  literalElementKey,
  normalizeAssignmentSteps,
  selectRangeArrayExpressions,
  selectSingleArrayExpressions,
  STEP_ARRAY_REST,
  STEP_DYNAMIC_MEMBER,
  STEP_ELEMENT,
  STEP_MEMBER,
  STEP_OBJECT_REST,
} from './function-assignment-patterns.ts';
import { staticElementKey } from './function-this-writes.ts';
import { bindingIdentifiers } from './scope.ts';

export {
  bindingElementSteps,
  bindingStepKey,
  type CycleSeenState as CandidateCycleState,
  isConstVariable,
  literalElementKey,
  staticArgumentKey,
} from './function-assignment-patterns.ts';

/** Per-binding index of post-declaration expression writes (`x = rhs`). */
export type VariableWriteMap = ReadonlyMap<Node, readonly Expression[]>;

/** Logical operators that can forward either operand as a spread source or callable value. */
export const LOGICAL_FORWARDING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

const DYNAMIC_MEMBER_KEY = '\0*';

const CANDIDATE_MEMO = new WeakMap<
  VariableWriteMap,
  Map<Node, readonly ObjectLiteralExpression[]>
>();

const MEMBER_EXPR_MEMO = new WeakMap<
  VariableWriteMap,
  WeakMap<ObjectLiteralExpression, Map<string, readonly Expression[]>>
>();

/** Returns the per-`VariableWriteMap` cache of cycle-free candidate-object evaluations. */
function candidateMemo(
  variableWrites: VariableWriteMap,
): Map<Node, readonly ObjectLiteralExpression[]> {
  let memo = CANDIDATE_MEMO.get(variableWrites);
  if (memo === undefined) {
    memo = new Map();
    CANDIDATE_MEMO.set(variableWrites, memo);
  }
  return memo;
}

/** Returns the per-`(VariableWriteMap, holder)` cache of cycle-free member value expressions. */
function holderMemberMemo(
  variableWrites: VariableWriteMap,
  holder: ObjectLiteralExpression,
): Map<string, readonly Expression[]> {
  let byHolder = MEMBER_EXPR_MEMO.get(variableWrites);
  if (byHolder === undefined) {
    byHolder = new WeakMap();
    MEMBER_EXPR_MEMO.set(variableWrites, byHolder);
  }
  let byKey = byHolder.get(holder);
  if (byKey === undefined) {
    byKey = new Map();
    byHolder.set(holder, byKey);
  }
  return byKey;
}

/** Evaluates `run` in a branch-local `seen` set and caches `keyNode` when no cycle back-edge hit. */
function memoizedCandidateLookup(
  keyNode: Node,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
  run: (branch: CycleSeenState) => readonly ObjectLiteralExpression[],
): readonly ObjectLiteralExpression[] {
  const memo = candidateMemo(variableWrites);
  const cached = memo.get(keyNode);
  if (cached !== undefined) {
    return cached;
  }
  const branch: CycleSeenState = { hitCycle: false, seen: new Set(state.seen) };
  const deduped = [...new Set(run(branch))];
  if (branch.hitCycle) {
    state.hitCycle = true;
  } else {
    memo.set(keyNode, deduped);
  }
  return deduped;
}

/** Runs `run` with a branch-local clone of `state.seen`, propagating `hitCycle` back to `state`. */
export function withCandidateBranch<T>(
  state: CycleSeenState,
  run: (branch: CycleSeenState) => T,
): T {
  const branch: CycleSeenState = { hitCycle: false, seen: new Set(state.seen) };
  const result = run(branch);
  if (branch.hitCycle) {
    state.hitCycle = true;
  }
  return result;
}

/** Resolves `ObjectLiteralExpression`s reachable from `node` across aliases, members, and patterns. */
export function candidateObjects(
  node: Expression,
  variableWrites: VariableWriteMap,
  seen: Set<Node>,
  cycle?: CycleSeenState,
): readonly ObjectLiteralExpression[] {
  const state: CycleSeenState = cycle ?? { hitCycle: false, seen };
  return candidateObjectsWithCycle(node, variableWrites, state);
}

/** Cycle-tracking worker resolving distinct `ObjectLiteralExpression`s reachable from `node`. */
export function candidateObjectsWithCycle(
  node: Expression,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly ObjectLiteralExpression[] {
  if (isObjectLiteralExpression(node)) {
    return [node];
  }
  if (isIdentifier(node)) {
    return identifierCandidateObjects(node, variableWrites, state);
  }
  return memoizedCandidateLookup(node, variableWrites, state, (branch) =>
    computeExpressionCandidateObjects(node, variableWrites, branch),
  );
}

/** Evaluates branch/member candidate object expressions for `node` inside `state`. */
function computeExpressionCandidateObjects(
  node: Expression,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly ObjectLiteralExpression[] {
  if (isConditionalExpression(node)) {
    return [
      ...withCandidateBranch(state, (branch) =>
        candidateObjectsWithCycle(unwrapped(node.whenTrue), variableWrites, branch),
      ),
      ...withCandidateBranch(state, (branch) =>
        candidateObjectsWithCycle(unwrapped(node.whenFalse), variableWrites, branch),
      ),
    ];
  }
  if (isBinaryExpression(node) && LOGICAL_FORWARDING.has(node.operatorToken.kind)) {
    return [
      ...withCandidateBranch(state, (branch) =>
        candidateObjectsWithCycle(unwrapped(node.left), variableWrites, branch),
      ),
      ...withCandidateBranch(state, (branch) =>
        candidateObjectsWithCycle(unwrapped(node.right), variableWrites, branch),
      ),
    ];
  }
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    const key = isPropertyAccessExpression(node) ? node.name.text : staticElementKey(node);
    const holders = candidateObjectsWithCycle(unwrapped(node.expression), variableWrites, state);
    return selectMemberObjectsWithCycle(holders, key, variableWrites, state);
  }
  return [];
}

/** Resolves candidate object literals bound to `node` via declarations and reassignments. */
function identifierCandidateObjects(
  node: Identifier,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly ObjectLiteralExpression[] {
  const declared = frameDeclarationOf(node);
  if (declared === undefined || !isVariableDeclaration(declared)) {
    return [];
  }
  const target = declaredBindingTarget(node, declared);
  const cached = candidateMemo(variableWrites).get(target);
  if (cached !== undefined) {
    return cached;
  }
  if (state.seen.has(target)) {
    state.hitCycle = true;
    return [];
  }
  return memoizedCandidateLookup(target, variableWrites, state, (branch) => {
    branch.seen.add(target);
    const objects = withCandidateBranch(branch, (initBranch) => {
      return isIdentifier(declared.name)
        ? simpleDeclarationObjects(declared, variableWrites, initBranch)
        : [...patternDeclarationObjects(node, declared, variableWrites, initBranch)];
    });
    if (!isConstVariable(declared)) {
      objects.push(...mutableAssignedObjects(node, target, variableWrites, branch));
    }
    return objects;
  });
}

/** Collects candidate objects from direct `variableWrites` and destructuring `bindingReassignments`. */
function mutableAssignedObjects(
  node: Identifier,
  target: Node,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly ObjectLiteralExpression[] {
  const objects: ObjectLiteralExpression[] = [];
  const writes = variableWrites.get(target);
  if (writes !== undefined) {
    for (const assigned of writes) {
      objects.push(
        ...withCandidateBranch(state, (branch) =>
          candidateObjectsWithCycle(assigned, variableWrites, branch),
        ),
      );
    }
  }
  const reassignments = bindingReassignments(node.getSourceFile()).get(target);
  if (reassignments !== undefined) {
    for (const source of reassignments) {
      if (writes === undefined || source.steps.length > 0) {
        objects.push(
          ...withCandidateBranch(state, (branch) =>
            assignedSourceCandidateObjects(source, variableWrites, branch),
          ),
        );
      }
    }
  }
  return objects;
}

/** Projects an `AssignedBindingSource` across its `AssignmentStep`s to candidate object literals. */
function assignedSourceCandidateObjects(
  source: AssignedBindingSource,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly ObjectLiteralExpression[] {
  const steps = normalizeAssignmentSteps(source.steps);
  if (steps === undefined || steps.at(-1)?.kind === STEP_OBJECT_REST) {
    return [];
  }
  const expressions = advanceAssignedExpressionSteps([source.root], steps, variableWrites, state);
  if (expressions === undefined) {
    return [];
  }
  return expressions.flatMap((expr) =>
    withCandidateBranch(state, (branch) => candidateObjectsWithCycle(expr, variableWrites, branch)),
  );
}

/** Advances candidate expressions across normalized `steps`, returning `undefined` on array rest. */
export function advanceAssignedExpressionSteps(
  initial: readonly Expression[],
  steps: readonly AssignmentStep[],
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly Expression[] | undefined {
  let expressions = initial;
  let pendingExcluded: ReadonlySet<string> | undefined;
  for (const step of steps) {
    if (step.kind === STEP_ARRAY_REST) {
      return undefined;
    }
    if (step.kind === STEP_OBJECT_REST) {
      pendingExcluded = step.excludedKeys;
    } else {
      expressions = advanceSingleAssignedStep(expressions, step, pendingExcluded, {
        state,
        variableWrites,
      });
      pendingExcluded = undefined;
    }
  }
  return expressions;
}

/** Advances candidate expressions across one non-rest `AssignmentStep`. */
function advanceSingleAssignedStep(
  expressions: readonly Expression[],
  step: Exclude<
    AssignmentStep,
    { readonly kind: typeof STEP_ARRAY_REST | typeof STEP_OBJECT_REST }
  >,
  excludedKeys: ReadonlySet<string> | undefined,
  env: { readonly state: CycleSeenState; readonly variableWrites: VariableWriteMap },
): readonly Expression[] {
  if (step.kind === STEP_MEMBER || step.kind === STEP_DYNAMIC_MEMBER) {
    const key = step.kind === STEP_MEMBER ? step.key : undefined;
    return expressions.flatMap((expr) => {
      return withCandidateBranch(env.state, (branch) => {
        const holders = candidateObjectsWithCycle(expr, env.variableWrites, branch);
        return memberValueExpressions(holders, { excludedKeys, key }, env.variableWrites, branch);
      });
    });
  }
  return expressions.flatMap((expr) => {
    return withCandidateBranch(env.state, (branch) => {
      return step.kind === STEP_ELEMENT
        ? selectSingleArrayExpressions(expr, step.index, branch)
        : selectRangeArrayExpressions(expr, step.startIndex, branch);
    });
  });
}

/** Resolves candidate object literals from a direct `const x = ...` / `let x = ...` initializer. */
function simpleDeclarationObjects(
  declared: VariableDeclaration,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): ObjectLiteralExpression[] {
  return declared.initializer === undefined
    ? []
    : [...candidateObjectsWithCycle(unwrapped(declared.initializer), variableWrites, state)];
}

/** Steps through destructuring elements on `declared` to resolve inner object literals for `node`. */
function patternDeclarationObjects(
  node: Identifier,
  declared: VariableDeclaration,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly ObjectLiteralExpression[] {
  const bound = bindingIdentifiers(declared.name).find((each) => each.text === node.text);
  if (bound === undefined) {
    return [];
  }
  let expressions: Expression[] =
    declared.initializer === undefined ? [] : [unwrapped(declared.initializer)];
  for (const step of bindingElementSteps(bound)) {
    if (step.dotDotDotToken !== undefined) {
      return [];
    }
    expressions = advancePatternExpressions(expressions, step, variableWrites, state);
  }
  return expressions.flatMap((expr) =>
    withCandidateBranch(state, (branch) => candidateObjectsWithCycle(expr, variableWrites, branch)),
  );
}

/** Projects candidate container `expressions` across a single destructuring `step` and its default. */
export function advancePatternExpressions(
  expressions: readonly Expression[],
  step: BindingElement,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): Expression[] {
  const next: Expression[] = [];
  if (isObjectBindingPattern(step.parent)) {
    const key = bindingStepKey(step);
    for (const expr of expressions) {
      const members = withCandidateBranch(state, (branch) => {
        const holders = candidateObjectsWithCycle(expr, variableWrites, branch);
        return memberValueExpressions(holders, { key }, variableWrites, branch);
      });
      next.push(...members);
    }
  } else if (isArrayBindingPattern(step.parent)) {
    const index = step.parent.elements.indexOf(step);
    for (const expr of expressions) {
      next.push(
        ...withCandidateBranch(state, (branch) =>
          selectSingleArrayExpressions(expr, index, branch),
        ),
      );
    }
  }
  if (step.initializer !== undefined) {
    next.push(unwrapped(step.initializer));
  }
  return next;
}

/** Resolves object literals stored under property `key` (or any data property if dynamic) on `holders`. */
export function selectMemberObjects(
  holders: readonly ObjectLiteralExpression[],
  key: string | undefined,
  variableWrites: VariableWriteMap,
  seen: Set<Node>,
): readonly ObjectLiteralExpression[] {
  return selectMemberObjectsWithCycle(holders, key, variableWrites, { hitCycle: false, seen });
}

/** Cycle-aware worker selecting distinct member object literals on `holders`. */
function selectMemberObjectsWithCycle(
  holders: readonly ObjectLiteralExpression[],
  key: string | undefined,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly ObjectLiteralExpression[] {
  const resolved = memberValueExpressions(holders, { key }, variableWrites, state).flatMap(
    (value) => {
      return withCandidateBranch(state, (branch) =>
        candidateObjectsWithCycle(value, variableWrites, branch),
      );
    },
  );
  return [...new Set(resolved)];
}

interface MemberSelectionFilter {
  readonly excludedKeys?: ReadonlySet<string> | undefined;
  readonly key: string | undefined;
}

/** Collects value expressions matching `filter` across `holders` and their spread sources. */
function memberValueExpressions(
  holders: readonly ObjectLiteralExpression[],
  filter: MemberSelectionFilter,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly Expression[] {
  const values: Expression[] = [];
  const cacheable = filter.excludedKeys === undefined || filter.excludedKeys.size === 0;
  const cacheKey = filter.key ?? DYNAMIC_MEMBER_KEY;
  for (const holder of holders) {
    const byKey = cacheable ? holderMemberMemo(variableWrites, holder) : undefined;
    const cached = byKey?.get(cacheKey);
    if (cached !== undefined) {
      values.push(...cached);
    } else if (state.seen.has(holder)) {
      state.hitCycle = true;
    } else {
      const memberValues = withCandidateBranch(state, (branch) => {
        branch.seen.add(holder);
        const collected = [
          ...new Set(collectObjectMemberValues(holder, filter, variableWrites, branch)),
        ];
        if (byKey !== undefined && !branch.hitCycle) {
          byKey.set(cacheKey, collected);
        }
        return collected;
      });
      values.push(...memberValues);
    }
  }
  return [...new Set(values)];
}

/** Collects matching property and spread expressions inside a single `holder` object literal. */
function collectObjectMemberValues(
  holder: ObjectLiteralExpression,
  filter: MemberSelectionFilter,
  variableWrites: VariableWriteMap,
  state: CycleSeenState,
): readonly Expression[] {
  const found: Expression[] = [];
  for (const prop of holder.properties) {
    if (isSpreadAssignment(prop)) {
      const spreadValues = withCandidateBranch(state, (branch) => {
        const spreadHolders = candidateObjectsWithCycle(
          unwrapped(prop.expression),
          variableWrites,
          branch,
        );
        return memberValueExpressions(spreadHolders, filter, variableWrites, branch);
      });
      found.push(...spreadValues);
    } else {
      const propKey = literalElementKey(prop);
      const value = propertyAssignmentExpression(prop);
      if (value !== undefined && matchesMemberFilter(propKey, filter)) {
        found.push(value);
      }
    }
  }
  return found;
}

/** Whether `propKey` satisfies `filter.key` and `filter.excludedKeys`. */
function matchesMemberFilter(propKey: string | undefined, filter: MemberSelectionFilter): boolean {
  if (propKey === undefined) {
    return true;
  }
  if (filter.key !== undefined) {
    return propKey === filter.key;
  }
  return filter.excludedKeys?.has(propKey) !== true;
}

/** Extracts the value expression of a `PropertyAssignment` or `ShorthandPropertyAssignment`. */
export function propertyAssignmentExpression(
  property: ObjectLiteralElementLike,
): Expression | undefined {
  if (isPropertyAssignment(property)) {
    return unwrapped(property.initializer);
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}
