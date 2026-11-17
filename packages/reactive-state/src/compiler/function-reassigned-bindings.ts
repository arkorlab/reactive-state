import {
  type Expression,
  isBinaryExpression,
  isConditionalExpression,
  isExpression,
  isIdentifier,
  isMethodDeclaration,
  isParameterDeclaration,
  isSpreadAssignment,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  arrayElementStepReaches,
  arrayRangeStepReaches,
  classifyUnverifiedArraySlot,
  getReachMemo,
  identifierInitializerStepReaches,
  resolveArrayLiteral,
  selectInlineArrayElement,
  serializeAssignmentSteps,
  setReachMemo,
} from './function-array-holders.ts';
import {
  type AssignmentStep,
  bindingReassignments,
  declaredBindingTarget,
  normalizeAssignmentSteps,
  STEP_ARRAY_REST,
  STEP_DYNAMIC_MEMBER,
  STEP_ELEMENT,
  STEP_MEMBER,
  STEP_OBJECT_REST,
} from './function-assignment-patterns.ts';
import { holderDeclaresArrayElementFunction } from './function-binding-types.ts';
import { LOGICAL_FORWARDING, propertyAssignmentExpression } from './function-candidate-objects.ts';
import { objectPostWrites } from './function-entry-writes.ts';
import {
  dynamicObjectEntryKind,
  type EntryKind,
  holderObject,
  isConstDeclaration,
  memberEntryKind,
  propertyKey,
  resolvePropertyValue,
  type ScanContext,
  withBranch,
} from './function-table-entries.ts';

export { selectInlineArrayElement } from './function-array-holders.ts';

interface ObjectKeyFilter {
  readonly excludedKeys?: ReadonlySet<string> | undefined;
  readonly key: string | undefined;
}

const MISSING_CLEAN = 'missing-clean';
const NON_FUNCTION: EntryKind = 'non-function';

/** Checks post-declaration reassignments of `binding` for any reachable function value. */
export function reassignedBindingEntryKind(binding: Node, context: ScanContext): EntryKind {
  const sources = bindingReassignments(binding.getSourceFile()).get(binding) ?? [];
  for (const source of sources) {
    const reachesFunction = withBranch(context, (branch) =>
      reachesAssignedFunction(source.root, source.steps, branch),
    );
    if (reachesFunction) {
      return 'renamed';
    }
  }
  return 'unknown';
}

/** Classifies static member `name` on `holder`, consulting mutable holder reassignments on `unknown`. */
export function containerMemberEntryKind(
  holder: Expression,
  name: string,
  context: ScanContext,
): EntryKind {
  const base = withBranch(context, (branch) => memberEntryKind(holder, name, branch));
  if (base !== 'unknown') {
    return base;
  }
  const hit = withBranch(context, (branch) => {
    return mutableHolderReassignmentReachesFunction(
      holder,
      [{ key: name, kind: STEP_MEMBER }],
      branch,
    );
  });
  return hit ? 'renamed' : 'unknown';
}

/** Classifies dynamic bracket access on `holder` across objects, arrays, and mutable reassignments. */
export function containerDynamicEntryKind(holder: Expression, context: ScanContext): EntryKind {
  const base = withBranch(context, (branch) => dynamicObjectEntryKind(holder, branch));
  if (base !== 'unknown') {
    return base;
  }
  if (holderDeclaresArrayElementFunction(holder)) {
    return 'renamed';
  }
  const viaArray = withBranch(context, (branch) =>
    arrayRangeReachesFunction(holder, 0, [], branch),
  );
  if (viaArray) {
    return 'renamed';
  }
  const viaMutable = withBranch(context, (branch) => {
    return mutableHolderReassignmentReachesFunction(
      holder,
      [{ kind: STEP_DYNAMIC_MEMBER }],
      branch,
    );
  });
  return viaMutable ? 'renamed' : 'unknown';
}

/** Whether spreading a mutable holder `source` can introduce functions from its reassignments. */
export function mutableSpreadReachesFunction(source: Expression, context: ScanContext): boolean {
  return mutableHolderReassignmentReachesFunction(source, [{ kind: STEP_DYNAMIC_MEMBER }], context);
}

/** Classifies element `index` on an inline, constant, annotated, or reassigned array holder. */
export function arraySlotEntryKind(
  holder: Expression,
  index: number,
  context: ScanContext,
): EntryKind {
  const inline = selectInlineArrayElement(holder, index);
  if (inline.kind === MISSING_CLEAN) {
    return NON_FUNCTION;
  }
  if (inline.kind === 'expr') {
    return context.classifyExpression(inline.value, context);
  }
  const unverified = withBranch(context, (branch) => {
    return classifyUnverifiedArraySlot(holder, index, branch, (array, inner) =>
      arrayRangeReachesFunction(array, 0, [], inner),
    );
  });
  if (unverified !== 'unknown') {
    return unverified;
  }
  if (holderDeclaresArrayElementFunction(holder, index)) {
    return 'renamed';
  }
  const viaMutable = withBranch(context, (branch) => {
    return mutableHolderReassignmentReachesFunction(
      holder,
      [{ index, kind: STEP_ELEMENT }],
      branch,
    );
  });
  return viaMutable ? 'renamed' : 'unknown';
}

/** Whether `kind` represents a function classification (`entry` or `renamed`). */
function isFunctionEntryKind(kind: EntryKind): boolean {
  return kind === 'entry' || kind === 'renamed';
}

/** Walks `rawSteps` from `current` with cycle-free memoization to test for reachable functions. */
function reachesAssignedFunction(
  current: Expression,
  rawSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  const steps = normalizeAssignmentSteps(rawSteps);
  if (steps === undefined) {
    return false;
  }
  const stepKey = serializeAssignmentSteps(steps);
  const cached = getReachMemo(current, stepKey);
  if (cached !== undefined) {
    return cached;
  }
  return withBranch(context, (branch) => {
    const found = computeReachesAssignedFunction(current, steps, branch);
    if (!branch.hitCycle) {
      setReachMemo(current, stepKey, found);
    }
    return found;
  });
}

/** Uncached worker walking normalized `steps` from `current`. */
function computeReachesAssignedFunction(
  current: Expression,
  steps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  if (isConditionalExpression(current)) {
    return (
      withBranch(context, (branch) =>
        reachesAssignedFunction(unwrapped(current.whenTrue), steps, branch),
      ) ||
      withBranch(context, (branch) =>
        reachesAssignedFunction(unwrapped(current.whenFalse), steps, branch),
      )
    );
  }
  if (isBinaryExpression(current) && LOGICAL_FORWARDING.has(current.operatorToken.kind)) {
    return (
      withBranch(context, (branch) =>
        reachesAssignedFunction(unwrapped(current.left), steps, branch),
      ) ||
      withBranch(context, (branch) =>
        reachesAssignedFunction(unwrapped(current.right), steps, branch),
      )
    );
  }
  const [step, ...tailSteps] = steps;
  if (step === undefined) {
    return isFunctionEntryKind(context.classifyExpression(current, context));
  }
  const viaContainer = withBranch(context, (branch) => {
    return tailSteps.length === 0
      ? leafAssignedStepReachesFunction(current, step, branch)
      : intermediateAssignedStepReachesFunction(current, step, tailSteps, branch);
  });
  return (
    viaContainer ||
    withBranch(context, (branch) =>
      identifierInitializerStepReaches(current, steps, branch, reachesAssignedFunction),
    ) ||
    withBranch(context, (branch) =>
      mutableHolderReassignmentReachesFunction(current, steps, branch),
    )
  );
}

/** Evaluates a terminal normalized assignment `step` on `current`. */
function leafAssignedStepReachesFunction(
  current: Expression,
  step: AssignmentStep,
  context: ScanContext,
): boolean {
  if (step.kind === STEP_ARRAY_REST || step.kind === STEP_OBJECT_REST) {
    return false;
  }
  if (step.kind === STEP_MEMBER) {
    return isFunctionEntryKind(memberEntryKind(current, step.key, context));
  }
  if (step.kind === STEP_DYNAMIC_MEMBER) {
    return (
      isFunctionEntryKind(dynamicObjectEntryKind(current, context)) ||
      arrayRangeReachesFunction(current, 0, [], context)
    );
  }
  if (step.kind === STEP_ELEMENT) {
    return isFunctionEntryKind(arraySlotEntryKind(current, step.index, context));
  }
  return arrayRangeReachesFunction(current, step.startIndex, [], context);
}

/** Advances an intermediate normalized assignment `step` across object or array containers. */
function intermediateAssignedStepReachesFunction(
  current: Expression,
  step: AssignmentStep,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  if (step.kind === STEP_OBJECT_REST) {
    return objectRestDynamicReachesFunction(
      current,
      step.excludedKeys,
      tailSteps.slice(1),
      context,
    );
  }
  if (step.kind === STEP_ARRAY_REST) {
    return false;
  }
  if (step.kind === STEP_MEMBER || step.kind === STEP_DYNAMIC_MEMBER) {
    return objectStepReachesFunction(
      current,
      { key: step.kind === STEP_MEMBER ? step.key : undefined },
      tailSteps,
      context,
    );
  }
  if (step.kind === STEP_ELEMENT) {
    return arrayElementStepReachesFunction(current, step.index, tailSteps, context);
  }
  return arrayRangeReachesFunction(current, step.startIndex, tailSteps, context);
}

/** Evaluates a dynamic key lookup on an object rest copy excluding `excludedKeys`. */
function objectRestDynamicReachesFunction(
  current: Expression,
  excludedKeys: ReadonlySet<string>,
  afterDynamicSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  const array = withBranch(context, (branch) => resolveArrayLiteral(current, branch));
  if (array !== undefined) {
    let skip = 0;
    while (excludedKeys.has(String(skip))) {
      skip += 1;
    }
    return arrayRangeReachesFunction(current, skip, afterDynamicSteps, context);
  }
  return objectStepReachesFunction(
    current,
    { excludedKeys, key: undefined },
    afterDynamicSteps,
    context,
  );
}

/** Advances an object property filter (`filter.key` or non-excluded keys) on `current`. */
function objectStepReachesFunction(
  current: Expression,
  filter: ObjectKeyFilter,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  if (filter.key !== undefined) {
    const fast = resolvePropertyValue(current, filter.key, context);
    if (fast.kind === MISSING_CLEAN) {
      return false;
    }
    if (fast.kind === 'expr') {
      return reachesAssignedFunction(fast.value, tailSteps, context);
    }
  }
  const resolved = withBranch(context, (branch) => holderObject(current, branch));
  if (resolved === undefined) {
    return false;
  }
  if (context.seen.has(resolved.object)) {
    context.hitCycle = true;
    return false;
  }
  return withBranch(context, (branch) => {
    branch.seen.add(resolved.object);
    return objectCandidatesReachFunction(resolved.object, filter, tailSteps, branch);
  });
}

/** Checks matching literal properties, spreads, and post-writes of `object` for `tailSteps`. */
function objectCandidatesReachFunction(
  object: ObjectLiteralExpression,
  filter: ObjectKeyFilter,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  for (const prop of object.properties) {
    if (objectPropertyReachesFunction(prop, filter, tailSteps, context)) {
      return true;
    }
  }
  return objectPostWritesReachFunction(object, filter, tailSteps, context);
}

/** Tests whether a single object literal property or spread `prop` reaches a function. */
function objectPropertyReachesFunction(
  prop: ObjectLiteralExpression['properties'][number],
  filter: ObjectKeyFilter,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  if (isSpreadAssignment(prop)) {
    const nextSteps = prependFilterSteps(filter, tailSteps);
    return withBranch(context, (branch) =>
      reachesAssignedFunction(unwrapped(prop.expression), nextSteps, branch),
    );
  }
  const propKey = propertyKey(prop);
  if (isExcludedOrMismatchedKey(propKey, filter)) {
    return false;
  }
  if (isMethodDeclaration(prop)) {
    return tailSteps.length === 0;
  }
  const value = propertyAssignmentExpression(prop);
  if (value === undefined) {
    return false;
  }
  return withBranch(context, (branch) => reachesAssignedFunction(value, tailSteps, branch));
}

/** Checks post-declaration member writes and `Object.assign` sources on `object` for `tailSteps`. */
function objectPostWritesReachFunction(
  object: ObjectLiteralExpression,
  filter: ObjectKeyFilter,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  const post = objectPostWrites(object);
  for (const write of post.memberValues) {
    const { callable } = write;
    if (!isExcludedOrMismatchedKey(write.key, filter)) {
      if (isMethodDeclaration(callable) && tailSteps.length === 0) {
        return true;
      }
      if (
        isExpression(callable) &&
        withBranch(context, (branch) => reachesAssignedFunction(callable, tailSteps, branch))
      ) {
        return true;
      }
    }
  }
  const retrySteps = prependFilterSteps(filter, tailSteps);
  for (const source of post.assignSources) {
    if (withBranch(context, (branch) => reachesAssignedFunction(source, retrySteps, branch))) {
      return true;
    }
  }
  return false;
}

/** Whether `candidateKey` is ruled out by `filter.key` or `filter.excludedKeys`. */
function isExcludedOrMismatchedKey(
  candidateKey: string | undefined,
  filter: ObjectKeyFilter,
): boolean {
  if (candidateKey === undefined) {
    return false;
  }
  if (filter.key !== undefined) {
    return candidateKey !== filter.key;
  }
  return filter.excludedKeys?.has(candidateKey) === true;
}

/** Prepends `filter` as selection step(s) onto `tailSteps` for spread/`Object.assign` forwarding. */
function prependFilterSteps(
  filter: ObjectKeyFilter,
  tailSteps: readonly AssignmentStep[],
): readonly AssignmentStep[] {
  if (filter.key !== undefined) {
    return [{ key: filter.key, kind: STEP_MEMBER }, ...tailSteps];
  }
  if (filter.excludedKeys !== undefined && filter.excludedKeys.size > 0) {
    return [
      { excludedKeys: filter.excludedKeys, kind: STEP_OBJECT_REST },
      { kind: STEP_DYNAMIC_MEMBER },
      ...tailSteps,
    ];
  }
  return [{ kind: STEP_DYNAMIC_MEMBER }, ...tailSteps];
}

/** Advances an intermediate array slot `slotIndex` on `current`. */
function arrayElementStepReachesFunction(
  current: Expression,
  slotIndex: number,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  return arrayElementStepReaches(current, slotIndex, {
    context,
    reaches: reachesAssignedFunction,
    tailSteps,
  });
}

/** Checks elements of `current` from `startIndex` (or `0` when spreads precede) against `tailSteps`. */
function arrayRangeReachesFunction(
  current: Expression,
  startIndex: number,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  return arrayRangeStepReaches(current, startIndex, {
    context,
    reaches: reachesAssignedFunction,
    tailSteps,
  });
}

/** Follows reassignments on a mutable container identifier `current` along `remainingSteps`. */
function mutableHolderReassignmentReachesFunction(
  current: Expression,
  remainingSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  if (!isIdentifier(current)) {
    return false;
  }
  const declared = frameDeclarationOf(current);
  if (
    declared === undefined ||
    (isVariableDeclaration(declared) && isConstDeclaration(declared)) ||
    (!isVariableDeclaration(declared) && !isParameterDeclaration(declared))
  ) {
    return false;
  }
  const target = declaredBindingTarget(current, declared);
  const stepKey = serializeAssignmentSteps(remainingSteps);
  const cached = getReachMemo(target, stepKey);
  if (cached !== undefined) {
    return cached;
  }
  if (context.seen.has(target)) {
    context.hitCycle = true;
    return false;
  }
  return withBranch(context, (branch) => {
    branch.seen.add(target);
    const sources = bindingReassignments(current.getSourceFile()).get(target) ?? [];
    let found = false;
    for (const source of sources) {
      const composed: readonly AssignmentStep[] = [...source.steps, ...remainingSteps];
      if (withBranch(branch, (inner) => reachesAssignedFunction(source.root, composed, inner))) {
        found = true;
        break;
      }
    }
    if (!branch.hitCycle) {
      setReachMemo(target, stepKey, found);
    }
    return found;
  });
}
