import {
  type Expression,
  isComputedPropertyName,
  isExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import {
  type AssignedCallable,
  type CallableLookupContext,
  type CallableTraversal,
  expressionCallables,
  type FileCallableIndex,
  type ObjectCallables,
  traversalCandidateObjects,
  traversalObjectRestCopies,
} from './function-callable-expressions.ts';
import { literalElementKey } from './function-candidate-objects.ts';
import {
  callableThisWrites,
  type CallableWrites,
  EMPTY_CALLABLE_WRITES,
  type ThisPropertyAssignment,
} from './function-this-writes.ts';

export type { AssignedCallable, FileCallableIndex } from './function-callable-expressions.ts';

const EMPTY_OBJECT_CALLABLES: ObjectCallables = {
  dynamic: new Set(),
  named: new Map(),
  ownAccessors: new Set(),
};

const OBJECT_CALLABLES = new WeakMap<ObjectLiteralExpression, ObjectCallables>();

/** Aggregates `this`-writes across every own, spread-copied, or assigned callable on `object`. */
export function callableWritesOnObject(
  object: ObjectLiteralExpression,
  index: FileCallableIndex,
  excludedKeys?: ReadonlySet<string>,
): CallableWrites {
  const rootTraversal: CallableTraversal = {
    activeObjects: new Set(),
    getObjectCallables: objectCallables,
    hitCycle: false,
    index,
  };
  const callables = objectCallables(object, rootTraversal);
  const uncertain =
    callables.allWritesUncertain === true || rootTraversal.truncatedRestObjects === true;
  const candidates = collectAllCallables(callables, excludedKeys);
  if (!uncertain && candidates.length === 0) {
    return EMPTY_CALLABLE_WRITES;
  }
  const resolveExpr = (value: Expression): readonly Node[] => {
    const traversal: CallableTraversal = {
      activeObjects: new Set(),
      getObjectCallables: objectCallables,
      hitCycle: false,
      index,
    };
    return expressionCallables(value, { hitCycle: false, seen: new Set(), traversal });
  };
  let all = uncertain;
  const keys = new Set<string>();
  const untrackedKeys = new Set<string>();
  const assignments: ThisPropertyAssignment[] = [];
  for (const callable of candidates) {
    const writes = callableThisWrites(callable, resolveExpr, new Set());
    if (writes.all) {
      all = true;
    }
    for (const key of writes.keys) {
      keys.add(key);
    }
    for (const key of writes.untrackedKeys) {
      untrackedKeys.add(key);
    }
    assignments.push(...writes.assignments);
  }
  return !all && keys.size === 0 && assignments.length === 0
    ? EMPTY_CALLABLE_WRITES
    : { all, assignments, keys, untrackedKeys };
}

/** Flattens named data callables, dynamic data callables, and (when unfiltered) own accessors. */
function collectAllCallables(
  callables: ObjectCallables,
  excludedKeys?: ReadonlySet<string>,
): readonly Node[] {
  const list = new Set<Node>(callables.dynamic);
  if (excludedKeys === undefined) {
    for (const accessor of callables.ownAccessors) {
      list.add(accessor);
    }
  }
  for (const [key, group] of callables.named) {
    if (excludedKeys?.has(key) !== true) {
      for (const callable of group) {
        list.add(callable);
      }
    }
  }
  return [...list];
}

/** Computes and memoizes surviving callables on `object` whenever no active cycle is truncated. */
function objectCallables(
  object: ObjectLiteralExpression,
  traversal: CallableTraversal,
): ObjectCallables {
  const cached = OBJECT_CALLABLES.get(object);
  if (cached !== undefined) {
    return cached;
  }
  if (traversal.activeObjects.has(object)) {
    traversal.hitCycle = true;
    return EMPTY_OBJECT_CALLABLES;
  }
  const local: CallableTraversal = {
    activeObjects: new Set([...traversal.activeObjects, object]),
    getObjectCallables: objectCallables,
    hitCycle: false,
    index: traversal.index,
  };
  const named = new Map<string, Set<Node>>();
  const dynamic = new Set<Node>();
  const ownAccessors = new Set<Node>();
  for (const property of object.properties) {
    recordPropertyCallables(property, local, { dynamic, named, ownAccessors });
  }
  applyAssignedCallables(object, local, { dynamic, named });
  const result: ObjectCallables = {
    allWritesUncertain: local.truncatedRestObjects === true,
    dynamic,
    named,
    ownAccessors,
  };
  if (local.hitCycle) {
    traversal.hitCycle = true;
  } else {
    OBJECT_CALLABLES.set(object, result);
  }
  return result;
}

/** Records callables from one literal property or spread element onto `state`. */
function recordPropertyCallables(
  property: ObjectLiteralElementLike,
  traversal: CallableTraversal,
  state: {
    readonly dynamic: Set<Node>;
    readonly named: Map<string, Set<Node>>;
    readonly ownAccessors: Set<Node>;
  },
): void {
  if (isSpreadAssignment(property)) {
    mergeSpreadCallables(unwrapped(property.expression), traversal, state);
    return;
  }
  const key = literalElementKey(property);
  if (
    key === '__proto__' &&
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name)
  ) {
    if (unwrapped(property.initializer).kind !== SyntaxKind.NullKeyword) {
      mergePrototypeCallables(unwrapped(property.initializer), traversal, state.dynamic);
    }
    return;
  }
  if (isGetAccessorDeclaration(property) || isSetAccessorDeclaration(property)) {
    state.ownAccessors.add(property);
    if (key !== undefined) {
      state.named.set(key, new Set());
    }
    return;
  }
  const resolved = directElementCallables(property, traversal);
  if (key === undefined) {
    for (const callable of resolved) {
      state.dynamic.add(callable);
    }
    return;
  }
  state.named.set(key, new Set(resolved));
}

/** Resolves callables contributed directly by a method, property assignment, or shorthand entry. */
function directElementCallables(
  property: ObjectLiteralElementLike,
  traversal: CallableTraversal,
): readonly Node[] {
  if (isMethodDeclaration(property)) {
    return [property];
  }
  const lookup: CallableLookupContext = { hitCycle: false, seen: new Set(), traversal };
  if (isPropertyAssignment(property)) {
    return expressionCallables(unwrapped(property.initializer), lookup);
  }
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    return expressionCallables(property.name, lookup);
  }
  return [];
}

/** Unions data callables (excluding getters/setters and rest-excluded keys) from `source`. */
function mergeSpreadCallables(
  source: Expression,
  traversal: CallableTraversal,
  state: { readonly dynamic: Set<Node>; readonly named: Map<string, Set<Node>> },
): void {
  for (const spreadObj of traversalCandidateObjects(source, traversal)) {
    copyObjectCallables(objectCallables(spreadObj, traversal), undefined, traversal, state);
  }
  for (const copy of traversalObjectRestCopies(source, traversal)) {
    copyObjectCallables(
      objectCallables(copy.object, traversal),
      copy.excludedKeys,
      traversal,
      state,
    );
  }
}

/** Copies data callables from `inner` into `state`, skipping keys in `excludedKeys`. */
function copyObjectCallables(
  inner: ObjectCallables,
  excludedKeys: ReadonlySet<string> | undefined,
  traversal: CallableTraversal,
  state: { readonly dynamic: Set<Node>; readonly named: Map<string, Set<Node>> },
): void {
  if (inner.allWritesUncertain === true) {
    traversal.truncatedRestObjects = true;
  }
  for (const callable of inner.dynamic) {
    state.dynamic.add(callable);
  }
  for (const [key, group] of inner.named) {
    if (excludedKeys?.has(key) !== true) {
      addNamedCallables(state.named, key, group);
    }
  }
}

/** Copies data callables from a `__proto__` object literal into `dynamic`. */
function mergePrototypeCallables(
  proto: Expression,
  traversal: CallableTraversal,
  dynamic: Set<Node>,
): void {
  const protoObjects = traversalCandidateObjects(proto, traversal);
  for (const protoObj of protoObjects) {
    const inner = objectCallables(protoObj, traversal);
    if (inner.allWritesUncertain === true) {
      traversal.truncatedRestObjects = true;
    }
    for (const callable of inner.dynamic) {
      dynamic.add(callable);
    }
    const groups = inner.named.values();
    for (const group of groups) {
      for (const callable of group) {
        dynamic.add(callable);
      }
    }
  }
}

/** Merges post-declaration `obj.swap = fn`, `defineProperty`, and `Object.assign` callables onto `state`. */
function applyAssignedCallables(
  object: ObjectLiteralExpression,
  traversal: CallableTraversal,
  state: { readonly dynamic: Set<Node>; readonly named: Map<string, Set<Node>> },
): void {
  const assignedItems = traversal.index.memberCallables.get(object);
  if (assignedItems !== undefined) {
    for (const item of assignedItems) {
      recordAssignedItem(item, traversal, state);
    }
  }
  const spreadSources = traversal.index.assignedSpreads.get(object);
  if (spreadSources !== undefined) {
    for (const source of spreadSources) {
      mergeSpreadCallables(source, traversal, state);
    }
  }
}

/** Resolves and records one post-declaration member callable assignment onto `state`. */
function recordAssignedItem(
  item: AssignedCallable,
  traversal: CallableTraversal,
  state: { readonly dynamic: Set<Node>; readonly named: Map<string, Set<Node>> },
): void {
  let resolved: readonly Node[] = [];
  if (isMethodDeclaration(item.callable)) {
    resolved = [item.callable];
  } else if (isExpression(item.callable)) {
    resolved = expressionCallables(item.callable, { hitCycle: false, seen: new Set(), traversal });
  }
  if (item.key === undefined) {
    for (const callable of resolved) {
      state.dynamic.add(callable);
    }
    return;
  }
  addNamedCallables(state.named, item.key, resolved);
}

/** Adds `items` into `named.get(key)` without overwriting earlier candidate callables. */
function addNamedCallables(
  named: Map<string, Set<Node>>,
  key: string,
  items: Iterable<Node>,
): void {
  let bucket = named.get(key);
  if (bucket === undefined) {
    bucket = new Set();
    named.set(key, bucket);
  }
  for (const item of items) {
    bucket.add(item);
  }
}
