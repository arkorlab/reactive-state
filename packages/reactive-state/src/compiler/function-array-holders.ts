import {
  type ArrayLiteralExpression,
  type BindingElement,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBindingElement,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isObjectBindingPattern,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type PropertyAccessExpression,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  type AssignmentStep,
  bindingElementSteps,
  bindingStepKey,
  declaredBindingTarget,
  STEP_ARRAY_REST,
  STEP_DYNAMIC_ELEMENT,
  STEP_DYNAMIC_MEMBER,
  STEP_ELEMENT,
  STEP_MEMBER,
} from './function-assignment-patterns.ts';
import { elementEntryKey } from './function-entry-writes.ts';
import {
  type EntryKind,
  isConstDeclaration,
  type ResolvedProperty,
  resolvePropertyValue,
  type ScanContext,
  withBranch,
} from './function-table-entries.ts';
import { bindingIdentifiers } from './scope.ts';

const MISSING_CLEAN = 'missing-clean';
const REACHES_MEMO = new WeakMap<Node, Map<string, boolean>>();

/** Looks up a memoized `(node, stepKey)` cycle-free reachability result. */
export function getReachMemo(node: Node, stepKey: string): boolean | undefined {
  return REACHES_MEMO.get(node)?.get(stepKey);
}

/** Records a cycle-free `(node, stepKey)` reachability result. */
export function setReachMemo(node: Node, stepKey: string, value: boolean): void {
  let byStep = REACHES_MEMO.get(node);
  if (byStep === undefined) {
    byStep = new Map();
    REACHES_MEMO.set(node, byStep);
  }
  byStep.set(stepKey, value);
}

/** Canonical cache key for a normalized `AssignmentStep[]` path. */
export function serializeAssignmentSteps(steps: readonly AssignmentStep[]): string {
  return steps.map((step) => serializeSingleStep(step)).join('|');
}

/** Formats a single `AssignmentStep` into a collision-free cache token. */
function serializeSingleStep(step: AssignmentStep): string {
  if (step.kind === STEP_MEMBER) {
    return `m:${JSON.stringify(step.key)}`;
  }
  if (step.kind === STEP_DYNAMIC_MEMBER) {
    return 'dm';
  }
  if (step.kind === STEP_ELEMENT) {
    return `e:${step.index}`;
  }
  if (step.kind === STEP_DYNAMIC_ELEMENT) {
    return `de:${step.startIndex}`;
  }
  if (step.kind === STEP_ARRAY_REST) {
    return `ar:${step.startIndex}`;
  }
  const sorted = [...step.excludedKeys].toSorted((left, right) => left.localeCompare(right));
  return `or:${sorted.map((key) => JSON.stringify(key)).join(',')}`;
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

/** Detects functions inside non-inline array literals without proving mutating slots non-callable. */
export function classifyUnverifiedArraySlot(
  holder: Expression,
  index: number,
  context: ScanContext,
  rangeReaches: (array: ArrayLiteralExpression, context: ScanContext) => boolean,
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
    return kind === 'entry' || kind === 'renamed' ? 'renamed' : 'unknown';
  }
  return rangeReaches(array, context) ? 'renamed' : 'unknown';
}

/** Follows lexical bindings and static projections from `holder` to an `ArrayLiteralExpression`. */
export function resolveArrayLiteral(
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

/** Advances an intermediate array slot `slotIndex` on `current`. */
export function arrayElementStepReaches(
  current: Expression,
  slotIndex: number,
  env: {
    readonly context: ScanContext;
    readonly reaches: (
      expr: Expression,
      steps: readonly AssignmentStep[],
      ctx: ScanContext,
    ) => boolean;
    readonly tailSteps: readonly AssignmentStep[];
  },
): boolean {
  const array = withBranch(env.context, (branch) => resolveArrayLiteral(current, branch));
  if (array === undefined || slotIndex < 0) {
    return false;
  }
  if (array.elements.slice(0, slotIndex + 1).every((each) => !isSpreadElement(each))) {
    const element = array.elements[slotIndex];
    return (
      element !== undefined &&
      !isOmittedExpression(element) &&
      env.reaches(unwrapped(element), env.tailSteps, env.context)
    );
  }
  return arrayRangeStepReaches(current, 0, env);
}

/** Checks elements of `current` from `startIndex` (or `0` when spreads precede) against `env.tailSteps`. */
export function arrayRangeStepReaches(
  current: Expression,
  startIndex: number,
  env: {
    readonly context: ScanContext;
    readonly reaches: (
      expr: Expression,
      steps: readonly AssignmentStep[],
      ctx: ScanContext,
    ) => boolean;
    readonly tailSteps: readonly AssignmentStep[];
  },
): boolean {
  const array = withBranch(env.context, (branch) => resolveArrayLiteral(current, branch));
  if (array === undefined) {
    return false;
  }
  if (env.context.seen.has(array)) {
    env.context.hitCycle = true;
    return false;
  }
  const offset = array.elements.slice(0, startIndex).every((each) => !isSpreadElement(each))
    ? startIndex
    : 0;
  return withBranch(env.context, (branch) => {
    branch.seen.add(array);
    for (const element of array.elements.slice(offset)) {
      if (isSpreadElement(element)) {
        const spreadSteps: readonly AssignmentStep[] = [
          { kind: STEP_DYNAMIC_ELEMENT, startIndex: 0 },
          ...env.tailSteps,
        ];
        if (env.reaches(unwrapped(element.expression), spreadSteps, branch)) {
          return true;
        }
      } else if (
        !isOmittedExpression(element) &&
        env.reaches(unwrapped(element), env.tailSteps, branch)
      ) {
        return true;
      }
    }
    return false;
  });
}

/** Follows a simple variable declaration initializer (such as `const m = flag ? a : b`) along `steps`. */
export function identifierInitializerStepReaches(
  current: Expression,
  steps: readonly AssignmentStep[],
  context: ScanContext,
  reaches: (expr: Expression, nextSteps: readonly AssignmentStep[], ctx: ScanContext) => boolean,
): boolean {
  if (!isIdentifier(current)) {
    return false;
  }
  const declared = frameDeclarationOf(current);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    declared.initializer === undefined
  ) {
    return false;
  }
  const target = declaredBindingTarget(current, declared);
  const stepKey = `init:${serializeAssignmentSteps(steps)}`;
  const cached = getReachMemo(target, stepKey);
  if (cached !== undefined) {
    return cached;
  }
  if (context.seen.has(target)) {
    context.hitCycle = true;
    return false;
  }
  const init = unwrapped(declared.initializer);
  return withBranch(context, (branch) => {
    branch.seen.add(target);
    const found = reaches(init, steps, branch);
    if (!branch.hitCycle) {
      setReachMemo(target, stepKey, found);
    }
    return found;
  });
}
