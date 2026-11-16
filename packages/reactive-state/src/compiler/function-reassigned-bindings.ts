import {
  type ArrayLiteralExpression,
  type BindingElement,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isConditionalExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isObjectBindingPattern,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  type AssignmentStep,
  bindingReassignments,
  declaredBindingTarget,
} from './function-binding-types.ts';
import {
  bindingElementSteps,
  bindingStepKey,
  LOGICAL_FORWARDING,
  propertyAssignmentExpression,
} from './function-candidate-objects.ts';
import { elementEntryKey, objectPostWrites } from './function-entry-writes.ts';
import {
  dynamicObjectEntryKind,
  type EntryKind,
  holderObject,
  isConstDeclaration,
  memberEntryKind,
  propertyKey,
  type ResolvedProperty,
  resolvePropertyValue,
  type ScanContext,
  withBranch,
} from './function-table-entries.ts';
import { bindingIdentifiers } from './scope.ts';

const DYNAMIC_MEMBER = 'dynamic-member' as const;
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

/** Classifies element `index` on an inline or constant-bound array literal. */
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
  return unverifiedArraySlotKind(holder, index, context);
}

/** Selects element `index` of an inline destructured array literal without prior spread elements. */
export function selectInlineArrayElement(holder: Expression, index: number): ResolvedProperty {
  if (
    index < 0 ||
    !isArrayLiteralExpression(holder) ||
    !isInlinePatternSource(holder) ||
    holder.elements.slice(0, index + 1).some((each) => isSpreadElement(each))
  ) {
    return { kind: 'unknown' };
  }
  const element = holder.elements[index];
  if (element === undefined || isOmittedExpression(element)) {
    return { kind: MISSING_CLEAN };
  }
  return { kind: 'expr', value: unwrapped(element) };
}

/** Whether `kind` represents a function classification (`'entry'` or `'renamed'`). */
function isFunctionEntryKind(kind: EntryKind): boolean {
  return kind === 'entry' || kind === 'renamed';
}

/** Walks `steps` from `current` to test whether any candidate runtime path yields a function. */
function reachesAssignedFunction(
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
  const viaContainer =
    tailSteps.length === 0
      ? leafAssignedStepReachesFunction(current, step, context)
      : intermediateAssignedStepReachesFunction(current, step, tailSteps, context);
  return viaContainer || mutableHolderReassignmentReachesFunction(current, steps, context);
}

/** Evaluates the final assignment `step` against `current`. */
function leafAssignedStepReachesFunction(
  current: Expression,
  step: AssignmentStep,
  context: ScanContext,
): boolean {
  if (step.kind === 'member') {
    return isFunctionEntryKind(memberEntryKind(current, step.key, context));
  }
  if (step.kind === DYNAMIC_MEMBER) {
    return isFunctionEntryKind(dynamicObjectEntryKind(current, context));
  }
  if (step.kind === 'element') {
    return isFunctionEntryKind(arraySlotEntryKind(current, step.index, context));
  }
  return arrayRangeReachesFunction(current, step.startIndex, [], context);
}

/** Advances an intermediate assignment `step` across object or array containers. */
function intermediateAssignedStepReachesFunction(
  current: Expression,
  step: AssignmentStep,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  if (step.kind === 'member' || step.kind === DYNAMIC_MEMBER) {
    return objectStepReachesFunction(
      current,
      step.kind === 'member' ? step.key : undefined,
      tailSteps,
      context,
    );
  }
  if (step.kind === 'element') {
    return arrayElementStepReachesFunction(current, step.index, tailSteps, context);
  }
  return arrayRangeReachesFunction(current, step.startIndex, tailSteps, context);
}

/** Advances an intermediate object property `key` (or any key when `undefined`) on `current`. */
function objectStepReachesFunction(
  current: Expression,
  key: string | undefined,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  if (key !== undefined) {
    const fast = resolvePropertyValue(current, key, context);
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
    return objectCandidatesReachFunction(resolved.object, key, tailSteps, branch);
  });
}

/** Checks matching literal properties, spreads, and post-writes of `object` for `tailSteps`. */
function objectCandidatesReachFunction(
  object: ObjectLiteralExpression,
  key: string | undefined,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  for (const prop of object.properties) {
    if (objectPropertyReachesFunction(prop, key, tailSteps, context)) {
      return true;
    }
  }
  return objectPostWritesReachFunction(object, key, tailSteps, context);
}

/** Tests whether a single object literal property or spread `prop` reaches a function along `tailSteps`. */
function objectPropertyReachesFunction(
  prop: ObjectLiteralExpression['properties'][number],
  key: string | undefined,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  if (isSpreadAssignment(prop)) {
    const nextSteps = prependMemberStep(key, tailSteps);
    return withBranch(context, (branch) =>
      reachesAssignedFunction(unwrapped(prop.expression), nextSteps, branch),
    );
  }
  const propKey = propertyKey(prop);
  const value = propertyAssignmentExpression(prop);
  if (value === undefined || (key !== undefined && propKey !== undefined && propKey !== key)) {
    return false;
  }
  return withBranch(context, (branch) => reachesAssignedFunction(value, tailSteps, branch));
}

/** Checks post-declaration member writes and `Object.assign` sources on `object` for `tailSteps`. */
function objectPostWritesReachFunction(
  object: ObjectLiteralExpression,
  key: string | undefined,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  const post = objectPostWrites(object);
  for (const write of post.memberValues) {
    const { callable } = write;
    if (
      isExpression(callable) &&
      (key === undefined || write.key === undefined || write.key === key)
    ) {
      const hit = withBranch(context, (branch) =>
        reachesAssignedFunction(callable, tailSteps, branch),
      );
      if (hit) {
        return true;
      }
    }
  }
  const retrySteps = prependMemberStep(key, tailSteps);
  for (const source of post.assignSources) {
    const hit = withBranch(context, (branch) =>
      reachesAssignedFunction(source, retrySteps, branch),
    );
    if (hit) {
      return true;
    }
  }
  return false;
}

/** Advances an intermediate array slot `slotIndex` on `current`. */
function arrayElementStepReachesFunction(
  current: Expression,
  slotIndex: number,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  const array = withBranch(context, (branch) => resolveArrayLiteral(current, branch));
  if (array === undefined || slotIndex < 0) {
    return false;
  }
  if (array.elements.slice(0, slotIndex + 1).every((each) => !isSpreadElement(each))) {
    const element = array.elements[slotIndex];
    return (
      element !== undefined &&
      !isOmittedExpression(element) &&
      reachesAssignedFunction(unwrapped(element), tailSteps, context)
    );
  }
  return arrayRangeReachesFunction(current, 0, tailSteps, context);
}

/** Checks elements of `current` from `startIndex` (or `0` when spreads precede) against `tailSteps`. */
function arrayRangeReachesFunction(
  current: Expression,
  startIndex: number,
  tailSteps: readonly AssignmentStep[],
  context: ScanContext,
): boolean {
  const array = withBranch(context, (branch) => resolveArrayLiteral(current, branch));
  if (array === undefined) {
    return false;
  }
  if (context.seen.has(array)) {
    context.hitCycle = true;
    return false;
  }
  const offset = array.elements.slice(0, startIndex).every((each) => !isSpreadElement(each))
    ? startIndex
    : 0;
  return withBranch(context, (branch) => {
    branch.seen.add(array);
    for (const element of array.elements.slice(offset)) {
      if (isSpreadElement(element)) {
        const spreadSteps: readonly AssignmentStep[] = [
          { kind: 'dynamic-element', startIndex: 0 },
          ...tailSteps,
        ];
        if (reachesAssignedFunction(unwrapped(element.expression), spreadSteps, branch)) {
          return true;
        }
      } else if (
        !isOmittedExpression(element) &&
        reachesAssignedFunction(unwrapped(element), tailSteps, branch)
      ) {
        return true;
      }
    }
    return false;
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
  if (declared === undefined || !isVariableDeclaration(declared) || isConstDeclaration(declared)) {
    return false;
  }
  const target = declaredBindingTarget(current, declared);
  if (context.seen.has(target)) {
    context.hitCycle = true;
    return false;
  }
  const sources = bindingReassignments(current.getSourceFile()).get(target) ?? [];
  for (const source of sources) {
    const composed: readonly AssignmentStep[] = [...source.steps, ...remainingSteps];
    const hit = withBranch(context, (branch) => {
      branch.seen.add(target);
      return reachesAssignedFunction(source.root, composed, branch);
    });
    if (hit) {
      return true;
    }
  }
  return false;
}

/** Detects functions inside non-inline array literals without proving mutating slots non-callable. */
function unverifiedArraySlotKind(
  holder: Expression,
  index: number,
  context: ScanContext,
): EntryKind {
  const array = resolveArrayLiteral(holder, context);
  if (array === undefined || index < 0) {
    return 'unknown';
  }
  if (array.elements.slice(0, index + 1).every((each) => !isSpreadElement(each))) {
    const element = array.elements[index];
    if (element === undefined || isOmittedExpression(element)) {
      return 'unknown';
    }
    const kind = context.classifyExpression(unwrapped(element), context);
    return isFunctionEntryKind(kind) ? 'renamed' : 'unknown';
  }
  for (const element of array.elements) {
    if (!isOmittedExpression(element) && !isSpreadElement(element)) {
      const each = withBranch(context, (branch) =>
        branch.classifyExpression(unwrapped(element), branch),
      );
      if (isFunctionEntryKind(each)) {
        return 'renamed';
      }
    }
  }
  return 'unknown';
}

/** Follows an identifier, member projection, or destructured `const` chain to an `ArrayLiteralExpression`. */
function resolveArrayLiteral(
  holder: Expression,
  context: ScanContext,
): ArrayLiteralExpression | undefined {
  let current: Expression = holder;
  for (;;) {
    if (isArrayLiteralExpression(current)) {
      return current;
    }
    const next = nextArrayHolderExpression(current, context);
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }
}

/** Resolves one lexical or projected step from `current` toward its underlying array initializer. */
function nextArrayHolderExpression(
  current: Expression,
  context: ScanContext,
): Expression | undefined {
  if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    return projectedArrayHolderExpression(current, context);
  }
  if (!isIdentifier(current)) {
    return undefined;
  }
  const declared = frameDeclarationOf(current);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    declared.initializer === undefined
  ) {
    return undefined;
  }
  const target = declaredBindingTarget(current, declared);
  if (context.seen.has(target)) {
    context.hitCycle = true;
    return undefined;
  }
  context.seen.add(target);
  if (isIdentifier(declared.name)) {
    return unwrapped(declared.initializer);
  }
  return isConstDeclaration(declared)
    ? resolveDestructuredArrayExpression(current, declared, context)
    : undefined;
}

/** Resolves a static member projection (`outer.items` or `outer['items']`) toward an array literal. */
function projectedArrayHolderExpression(
  current: ElementAccessExpression | PropertyAccessExpression,
  context: ScanContext,
): Expression | undefined {
  if (context.seen.has(current)) {
    context.hitCycle = true;
    return undefined;
  }
  const key = isPropertyAccessExpression(current) ? current.name.text : elementEntryKey(current);
  if (key === undefined) {
    return undefined;
  }
  context.seen.add(current);
  const selected = resolvePropertyValue(unwrapped(current.expression), key, context);
  return selected.kind === 'expr' ? selected.value : undefined;
}

/** Resolves the expression selected by a `const` destructuring binding `node` inside `declared`. */
function resolveDestructuredArrayExpression(
  node: Identifier,
  declared: VariableDeclaration,
  context: ScanContext,
): Expression | undefined {
  if (declared.initializer === undefined) {
    return undefined;
  }
  const bound = bindingIdentifiers(declared.name).find((each) => each.text === node.text);
  if (bound === undefined) {
    return undefined;
  }
  let selected: ResolvedProperty = { kind: 'expr', value: unwrapped(declared.initializer) };
  for (const step of bindingElementSteps(bound)) {
    if (step.dotDotDotToken !== undefined || step.initializer !== undefined) {
      return undefined;
    }
    selected = selectDestructuredStep(selected, step, context);
  }
  return selected.kind === 'expr' ? selected.value : undefined;
}

/** Prepends a static or dynamic member selection step onto `tailSteps`. */
function prependMemberStep(
  key: string | undefined,
  tailSteps: readonly AssignmentStep[],
): readonly AssignmentStep[] {
  return [key === undefined ? { kind: DYNAMIC_MEMBER } : { key, kind: 'member' }, ...tailSteps];
}

/** Advances one default-free destructuring `step` while resolving a `const` array holder. */
function selectDestructuredStep(
  source: ResolvedProperty,
  step: BindingElement,
  context: ScanContext,
): ResolvedProperty {
  if (source.kind !== 'expr') {
    return { kind: 'unknown' };
  }
  if (isObjectBindingPattern(step.parent)) {
    const key = bindingStepKey(step);
    return key === undefined
      ? { kind: 'unknown' }
      : resolvePropertyValue(source.value, key, context);
  }
  return isArrayBindingPattern(step.parent)
    ? selectInlineArrayElement(source.value, step.parent.elements.indexOf(step))
    : { kind: 'unknown' };
}

/** Whether `node` stands directly as a destructuring initializer with no identifier alias to mutate it. */
function isInlinePatternSource(node: ArrayLiteralExpression): boolean {
  const { at, parent } = useOf(node);
  return (
    isExpression(at) &&
    (isVariableDeclaration(parent) || isBindingElement(parent)) &&
    parent.initializer === at &&
    parent.name !== undefined &&
    !isIdentifier(parent.name)
  );
}
