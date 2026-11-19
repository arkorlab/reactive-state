import {
  type BindingElement,
  type Expression,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { patternKey } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  type AssignedBindingSource,
  type AssignmentStep,
  bindingElementSteps,
  bindingReassignments,
  declaredBindingTarget,
  isConstVariable,
  normalizeAssignmentSteps,
  selectRangeArrayExpressions,
  selectSingleArrayExpressions,
  STEP_ARRAY_REST,
  STEP_DYNAMIC_ELEMENT,
  STEP_DYNAMIC_MEMBER,
  STEP_ELEMENT,
  STEP_MEMBER,
  STEP_OBJECT_REST,
} from './function-assignment-patterns.ts';
import {
  type CandidateCycleState,
  candidateObjects,
  LOGICAL_FORWARDING,
  selectMemberObjects,
  type VariableWriteMap,
} from './function-candidate-objects.ts';
import { type ObjectRestCopy, resolveObjectRestCopies } from './function-object-rest-copies.ts';
import { staticElementKey } from './function-this-writes.ts';
import { bindingIdentifiers } from './scope.ts';

/** Member callable assignment recorded against an object literal (`obj.swap = fn` or `defineProperty`). */
export interface AssignedCallable {
  readonly callable: Node | Expression;
  readonly key: string | undefined;
}

/** Per-file index of variable reassignments, member callable assignments, and `Object.assign` sources. */
export interface FileCallableIndex {
  readonly assignedSpreads: ReadonlyMap<ObjectLiteralExpression, readonly Expression[]>;
  readonly memberCallables: ReadonlyMap<ObjectLiteralExpression, readonly AssignedCallable[]>;
  readonly variableWrites: VariableWriteMap;
}

/** Surviving data callables and own accessors that can run with `this` bound to an object literal. */
export interface ObjectCallables {
  readonly allWritesUncertain?: boolean | undefined;
  readonly dynamic: ReadonlySet<Node>;
  readonly named: ReadonlyMap<string, ReadonlySet<Node>>;
  readonly ownAccessors: ReadonlySet<Node>;
}

/** Active-path cycle tracker threaded through nested `objectCallables` lookups. */
export interface CallableTraversal {
  readonly activeObjects: Set<ObjectLiteralExpression>;
  readonly getObjectCallables: (
    object: ObjectLiteralExpression,
    traversal: CallableTraversal,
  ) => ObjectCallables;
  hitCycle: boolean;
  readonly index: FileCallableIndex;
  truncatedRestObjects?: boolean | undefined;
}

/** Shared lookup context while resolving callables across expressions and patterns. */
export interface CallableLookupContext {
  hitCycle: boolean;
  readonly seen: Set<Node>;
  readonly traversal: CallableTraversal;
}

const EXPRESSION_CALLABLES = new WeakMap<FileCallableIndex, Map<Node, readonly Node[]>>();

/** Returns the per-`FileCallableIndex` cache of cycle-free callable expression evaluations. */
function callableMemo(index: FileCallableIndex): Map<Node, readonly Node[]> {
  let memo = EXPRESSION_CALLABLES.get(index);
  if (memo === undefined) {
    memo = new Map();
    EXPRESSION_CALLABLES.set(index, memo);
  }
  return memo;
}

/** Evaluates `run` in an isolated lookup branch and caches `keyNode` when no cycle back-edge hit. */
function memoizedCallableLookup(
  keyNode: Node,
  context: CallableLookupContext,
  run: (branch: CallableLookupContext) => readonly Node[],
): readonly Node[] {
  const memo = callableMemo(context.traversal.index);
  const cached = memo.get(keyNode);
  if (cached !== undefined) {
    return cached;
  }
  const childTraversal: CallableTraversal = {
    activeObjects: context.traversal.activeObjects,
    getObjectCallables: context.traversal.getObjectCallables,
    hitCycle: false,
    index: context.traversal.index,
  };
  const branch: CallableLookupContext = {
    hitCycle: false,
    seen: new Set(context.seen),
    traversal: childTraversal,
  };
  const deduped = [...new Set(run(branch))];
  if (childTraversal.hitCycle) {
    context.traversal.hitCycle = true;
  }
  if (childTraversal.truncatedRestObjects === true) {
    context.traversal.truncatedRestObjects = true;
  }
  if (branch.hitCycle || childTraversal.hitCycle) {
    context.hitCycle = true;
  } else {
    memo.set(keyNode, deduped);
  }
  return deduped;
}

/** Runs `run` with a branch-local clone of `context.seen`, propagating `hitCycle`. */
function withCallableBranch<T>(
  context: CallableLookupContext,
  run: (branch: CallableLookupContext) => T,
): T {
  const branch: CallableLookupContext = {
    hitCycle: false,
    seen: new Set(context.seen),
    traversal: context.traversal,
  };
  const result = run(branch);
  if (branch.hitCycle) {
    context.hitCycle = true;
  }
  return result;
}

/** Resolves `candidateObjects` while propagating any variable-alias cycle onto `traversal`. */
export function traversalCandidateObjects(
  source: Expression,
  traversal: CallableTraversal,
): readonly ObjectLiteralExpression[] {
  const cycle: CandidateCycleState = { hitCycle: false, seen: new Set() };
  const objects = candidateObjects(source, traversal.index.variableWrites, cycle.seen, cycle);
  if (cycle.hitCycle) {
    traversal.hitCycle = true;
  }
  return objects;
}

/** Resolves shallow object-rest copy sources while propagating alias cycles onto `traversal`. */
export function traversalObjectRestCopies(
  source: Expression,
  traversal: CallableTraversal,
): readonly ObjectRestCopy[] {
  const cycle: CandidateCycleState = { hitCycle: false, seen: new Set() };
  const resolved = resolveObjectRestCopies(source, traversal.index.variableWrites, cycle);
  if (cycle.hitCycle) {
    traversal.hitCycle = true;
  }
  if (resolved.truncatedObjects) {
    traversal.truncatedRestObjects = true;
  }
  return resolved.copies;
}

/** Resolves distinct non-arrow callables reachable from `value` across aliases, branches, and reads. */
export function expressionCallables(
  value: Expression,
  context: CallableLookupContext,
): readonly Node[] {
  if (isFunctionExpression(value)) {
    return [value];
  }
  if (isArrowFunction(value)) {
    return [];
  }
  if (isIdentifier(value)) {
    return identifierCallables(value, context);
  }
  return memoizedCallableLookup(value, context, (branch) =>
    computeExpressionCallables(value, branch),
  );
}

/** Evaluates branch and member callable expressions for `value` inside `context`. */
function computeExpressionCallables(
  value: Expression,
  context: CallableLookupContext,
): readonly Node[] {
  if (isConditionalExpression(value)) {
    return [
      ...withCallableBranch(context, (branch) =>
        expressionCallables(unwrapped(value.whenTrue), branch),
      ),
      ...withCallableBranch(context, (branch) =>
        expressionCallables(unwrapped(value.whenFalse), branch),
      ),
    ];
  }
  if (isBinaryExpression(value) && LOGICAL_FORWARDING.has(value.operatorToken.kind)) {
    return [
      ...withCallableBranch(context, (branch) =>
        expressionCallables(unwrapped(value.left), branch),
      ),
      ...withCallableBranch(context, (branch) =>
        expressionCallables(unwrapped(value.right), branch),
      ),
    ];
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = isPropertyAccessExpression(value) ? value.name.text : staticElementKey(value);
    return lookupMemberCallables(unwrapped(value.expression), key, context);
  }
  return [];
}

/** Resolves data callables stored under `key` (or any key when dynamic) on `holder`. */
function lookupMemberCallables(
  holder: Expression,
  key: string | undefined,
  context: CallableLookupContext,
): readonly Node[] {
  const found: Node[] = [];
  for (const srcObj of traversalCandidateObjects(holder, context.traversal)) {
    const inner = context.traversal.getObjectCallables(srcObj, context.traversal);
    appendObjectCallablesForKey(inner, key, undefined, found);
  }
  for (const copy of traversalObjectRestCopies(holder, context.traversal)) {
    if (key === undefined || !copy.excludedKeys.has(key)) {
      const inner = context.traversal.getObjectCallables(copy.object, context.traversal);
      appendObjectCallablesForKey(inner, key, copy.excludedKeys, found);
    }
  }
  return [...new Set(found)];
}

/** Appends dynamic and matching non-excluded `key` callables from `inner` onto `found`. */
function appendObjectCallablesForKey(
  inner: ObjectCallables,
  key: string | undefined,
  excludedKeys: ReadonlySet<string> | undefined,
  found: Node[],
): void {
  for (const callable of inner.dynamic) {
    found.push(callable);
  }
  if (key === undefined) {
    for (const [entryKey, group] of inner.named) {
      if (excludedKeys?.has(entryKey) !== true) {
        for (const callable of group) {
          found.push(callable);
        }
      }
    }
    return;
  }
  const matching = inner.named.get(key);
  if (matching !== undefined) {
    for (const callable of matching) {
      found.push(callable);
    }
  }
}

/** Resolves callables referenced by an identifier across declarations and reassignments. */
function identifierCallables(node: Identifier, context: CallableLookupContext): readonly Node[] {
  const declared = frameDeclarationOf(node);
  if (declared === undefined) {
    return [];
  }
  const target = declaredBindingTarget(node, declared);
  const cached = callableMemo(context.traversal.index).get(target);
  if (cached !== undefined) {
    return cached;
  }
  if (context.seen.has(target)) {
    context.hitCycle = true;
    return [];
  }
  return memoizedCallableLookup(target, context, (branch) => {
    branch.seen.add(target);
    if (isFunctionDeclaration(declared)) {
      return [declared];
    }
    if (!isVariableDeclaration(declared)) {
      return [];
    }
    const results = withCallableBranch(branch, (initBranch) => {
      return isIdentifier(declared.name)
        ? simpleVariableCallables(declared, initBranch)
        : [...destructuredCallables(node, declared, initBranch)];
    });
    if (!isConstVariable(declared)) {
      appendMutableVariableCallables(node, target, branch, results);
    }
    return results;
  });
}

/** Appends callables written to a mutable variable binding directly or via destructuring. */
function appendMutableVariableCallables(
  node: Identifier,
  target: Node,
  context: CallableLookupContext,
  results: Node[],
): void {
  const writes = context.traversal.index.variableWrites.get(target);
  if (writes !== undefined) {
    for (const assigned of writes) {
      results.push(
        ...withCallableBranch(context, (branch) => expressionCallables(assigned, branch)),
      );
    }
  }
  const reassignments = bindingReassignments(node.getSourceFile()).get(target);
  if (reassignments !== undefined) {
    for (const source of reassignments) {
      if (writes === undefined || source.steps.length > 0) {
        results.push(
          ...withCallableBranch(context, (branch) => assignedSourceCallables(source, branch)),
        );
      }
    }
  }
}

/** Projects an `AssignedBindingSource` across normalized `AssignmentStep`s to leaf callables. */
function assignedSourceCallables(
  source: AssignedBindingSource,
  context: CallableLookupContext,
): readonly Node[] {
  const steps = normalizeAssignmentSteps(source.steps);
  if (steps === undefined) {
    return [];
  }
  if (steps.length === 0) {
    return expressionCallables(source.root, context);
  }
  const leaf = steps.at(-1);
  if (leaf === undefined || leaf.kind === STEP_ARRAY_REST || leaf.kind === STEP_OBJECT_REST) {
    return [];
  }
  let holders: readonly Expression[] = [source.root];
  const intermediateSteps = steps.slice(0, -1);
  for (const step of intermediateSteps) {
    holders = advanceCallableContainerStep(holders, step, context);
  }
  return holders.flatMap((holder) =>
    withCallableBranch(context, (branch) => selectLeafAssignedCallables(holder, leaf, branch)),
  );
}

/** Advances container expressions across one intermediate `AssignmentStep`. */
function advanceCallableContainerStep(
  holders: readonly Expression[],
  step: AssignmentStep,
  context: CallableLookupContext,
): readonly Expression[] {
  if (step.kind === STEP_OBJECT_REST) {
    return holders;
  }
  if (step.kind === STEP_MEMBER || step.kind === STEP_DYNAMIC_MEMBER) {
    const key = step.kind === STEP_MEMBER ? step.key : undefined;
    return holders.flatMap((holder) => {
      const objs = traversalCandidateObjects(holder, context.traversal);
      return selectMemberObjects(objs, key, context.traversal.index.variableWrites, new Set());
    });
  }
  return holders.flatMap((holder) => selectStepArrayItems(holder, step, context));
}

/** Selects callables at the leaf `AssignmentStep` from `holder`. */
function selectLeafAssignedCallables(
  holder: Expression,
  leaf: AssignmentStep,
  context: CallableLookupContext,
): readonly Node[] {
  if (leaf.kind === STEP_MEMBER || leaf.kind === STEP_DYNAMIC_MEMBER) {
    return lookupMemberCallables(holder, leaf.kind === STEP_MEMBER ? leaf.key : undefined, context);
  }
  if (leaf.kind === STEP_ELEMENT || leaf.kind === STEP_DYNAMIC_ELEMENT) {
    const items = selectStepArrayItems(holder, leaf, context);
    return items.flatMap((item) =>
      withCallableBranch(context, (branch) => expressionCallables(item, branch)),
    );
  }
  return [];
}

/** Selects array literal element expressions matching an array `AssignmentStep`. */
function selectStepArrayItems(
  holder: Expression,
  step: Extract<
    AssignmentStep,
    { readonly kind: typeof STEP_ARRAY_REST | typeof STEP_DYNAMIC_ELEMENT | typeof STEP_ELEMENT }
  >,
  context: CallableLookupContext,
): readonly Expression[] {
  const cycle: CandidateCycleState = { hitCycle: false, seen: new Set(context.seen) };
  const items =
    step.kind === STEP_ELEMENT
      ? selectSingleArrayExpressions(holder, step.index, cycle)
      : selectRangeArrayExpressions(holder, step.startIndex, cycle);
  if (cycle.hitCycle) {
    context.hitCycle = true;
  }
  return items;
}

/** Resolves callables from a simple identifier variable declaration's initializer. */
function simpleVariableCallables(
  declared: VariableDeclaration,
  context: CallableLookupContext,
): Node[] {
  return declared.initializer === undefined
    ? []
    : [...expressionCallables(unwrapped(declared.initializer), context)];
}

/** Resolves callables bound through object destructuring (`const { swap = fn } = base`). */
function destructuredCallables(
  node: Identifier,
  declared: VariableDeclaration,
  context: CallableLookupContext,
): readonly Node[] {
  const bound = bindingIdentifiers(declared.name).find((each) => each.text === node.text);
  const steps = bound === undefined ? [] : bindingElementSteps(bound);
  const leaf = steps.at(-1);
  if (leaf === undefined) {
    return [];
  }
  const holders = resolveIntermediateObjectHolders(declared, steps.slice(0, -1), context.traversal);
  if (holders === undefined) {
    return [];
  }
  return collectLeafDestructuredCallables(holders, leaf, context);
}

/** Advances candidate object holder expressions across outer destructuring steps. */
function resolveIntermediateObjectHolders(
  declared: VariableDeclaration,
  outerSteps: readonly BindingElement[],
  traversal: CallableTraversal,
): readonly Expression[] | undefined {
  let holders: Expression[] =
    declared.initializer === undefined ? [] : [unwrapped(declared.initializer)];
  for (const step of outerSteps) {
    if (!isObjectBindingPattern(step.parent) || step.dotDotDotToken !== undefined) {
      return undefined;
    }
    holders = advanceSingleObjectStep(holders, step, traversal);
  }
  return holders;
}

/** Advances `holders` across a single intermediate object binding `step` and its default. */
function advanceSingleObjectStep(
  holders: readonly Expression[],
  step: BindingElement,
  traversal: CallableTraversal,
): Expression[] {
  const next: Expression[] = [];
  const key = patternKey(step);
  if (key !== undefined) {
    for (const holder of holders) {
      const objs = traversalCandidateObjects(holder, traversal);
      next.push(...selectMemberObjects(objs, key, traversal.index.variableWrites, new Set()));
    }
  }
  if (step.initializer !== undefined) {
    next.push(unwrapped(step.initializer));
  }
  return next;
}

/** Collects callables selected by `leaf` from `holders` plus `leaf.initializer` default. */
function collectLeafDestructuredCallables(
  holders: readonly Expression[],
  leaf: BindingElement,
  context: CallableLookupContext,
): readonly Node[] {
  const results: Node[] = [];
  if (isObjectBindingPattern(leaf.parent)) {
    const key = patternKey(leaf);
    if (key !== undefined) {
      for (const holder of holders) {
        results.push(...lookupMemberCallables(holder, key, context));
      }
    }
  }
  if (leaf.initializer !== undefined) {
    results.push(...expressionCallables(unwrapped(leaf.initializer), context));
  }
  return results;
}
