import {
  type BindingElement,
  type Expression,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
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
import { patternKey } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { declaredBindingTarget } from './function-binding-types.ts';
import {
  bindingElementSteps,
  candidateObjects,
  isConstVariable,
  literalElementKey,
  LOGICAL_FORWARDING,
  selectMemberObjects,
  type VariableWriteMap,
} from './function-candidate-objects.ts';
import {
  callableThisWrites,
  EMPTY_WRITES,
  type ObjectWrites,
  staticElementKey,
} from './function-this-writes.ts';
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
interface ObjectCallables {
  readonly dynamic: ReadonlySet<Node>;
  readonly named: ReadonlyMap<string, ReadonlySet<Node>>;
  readonly ownAccessors: ReadonlySet<Node>;
}

/** Shared lookup context while resolving callables across expressions and patterns. */
interface CallableLookupContext {
  readonly activeObjects: Set<ObjectLiteralExpression>;
  readonly index: FileCallableIndex;
  readonly seen: Set<Node>;
}

const OBJECT_CALLABLES = new WeakMap<ObjectLiteralExpression, ObjectCallables>();

/** Aggregates `this`-writes across every own, spread-copied, or assigned callable on `object`. */
export function callableWritesOnObject(
  object: ObjectLiteralExpression,
  index: FileCallableIndex,
): ObjectWrites {
  const callables = objectCallables(object, index, new Set());
  const candidates = collectAllCallables(callables);
  if (candidates.length === 0) {
    return EMPTY_WRITES;
  }
  const resolveExpr = (value: Expression): readonly Node[] =>
    expressionCallables(value, { activeObjects: new Set(), index, seen: new Set() });
  const keys = new Set<string>();
  for (const callable of candidates) {
    const writes = callableThisWrites(callable, resolveExpr, new Set());
    if (writes.all) {
      return { all: true, keys };
    }
    for (const key of writes.keys) {
      keys.add(key);
    }
  }
  return keys.size === 0 ? EMPTY_WRITES : { all: false, keys };
}

/** Flattens named data callables, dynamic data callables, and own accessors of `callables`. */
function collectAllCallables(callables: ObjectCallables): readonly Node[] {
  const list = new Set<Node>(callables.dynamic);
  for (const accessor of callables.ownAccessors) {
    list.add(accessor);
  }
  const groups = callables.named.values();
  for (const group of groups) {
    for (const callable of group) {
      list.add(callable);
    }
  }
  return [...list];
}

/** Computes surviving callables on `object`, propagating spread sources and post-declaration writes. */
function objectCallables(
  object: ObjectLiteralExpression,
  index: FileCallableIndex,
  activeObjects: Set<ObjectLiteralExpression>,
): ObjectCallables {
  if (activeObjects.size === 0) {
    const cached = OBJECT_CALLABLES.get(object);
    if (cached !== undefined) {
      return cached;
    }
  }
  if (activeObjects.has(object)) {
    return { dynamic: new Set(), named: new Map(), ownAccessors: new Set() };
  }
  const nextActive = new Set([...activeObjects, object]);
  const named = new Map<string, Set<Node>>();
  const dynamic = new Set<Node>();
  const ownAccessors = new Set<Node>();
  for (const property of object.properties) {
    recordPropertyCallables(property, index, nextActive, { dynamic, named, ownAccessors });
  }
  applyAssignedCallables(object, index, nextActive, { dynamic, named });
  const result: ObjectCallables = { dynamic, named, ownAccessors };
  if (activeObjects.size === 0) {
    OBJECT_CALLABLES.set(object, result);
  }
  return result;
}

/** Records callables from one literal property or spread element onto `state`. */
function recordPropertyCallables(
  property: ObjectLiteralElementLike,
  index: FileCallableIndex,
  activeObjects: Set<ObjectLiteralExpression>,
  state: {
    readonly dynamic: Set<Node>;
    readonly named: Map<string, Set<Node>>;
    readonly ownAccessors: Set<Node>;
  },
): void {
  if (isSpreadAssignment(property)) {
    mergeSpreadCallables(unwrapped(property.expression), index, activeObjects, state);
    return;
  }
  const key = literalElementKey(property);
  if (
    key === '__proto__' &&
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name)
  ) {
    if (unwrapped(property.initializer).kind !== SyntaxKind.NullKeyword) {
      mergePrototypeCallables(unwrapped(property.initializer), index, activeObjects, state.dynamic);
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
  const resolved = directElementCallables(property, index, activeObjects);
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
  index: FileCallableIndex,
  activeObjects: Set<ObjectLiteralExpression>,
): readonly Node[] {
  if (isMethodDeclaration(property)) {
    return [property];
  }
  const lookup: CallableLookupContext = { activeObjects, index, seen: new Set() };
  if (isPropertyAssignment(property)) {
    return expressionCallables(unwrapped(property.initializer), lookup);
  }
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    return expressionCallables(property.name, lookup);
  }
  return [];
}

/** Unions data callables (excluding getters/setters) from `source` into `state`. */
function mergeSpreadCallables(
  source: Expression,
  index: FileCallableIndex,
  activeObjects: Set<ObjectLiteralExpression>,
  state: { readonly dynamic: Set<Node>; readonly named: Map<string, Set<Node>> },
): void {
  const spreadObjects = candidateObjects(source, index.variableWrites, new Set());
  for (const spreadObj of spreadObjects) {
    const inner = objectCallables(spreadObj, index, activeObjects);
    for (const callable of inner.dynamic) {
      state.dynamic.add(callable);
    }
    for (const [key, group] of inner.named) {
      addNamedCallables(state.named, key, group);
    }
  }
}

/** Copies data callables from a `__proto__` object literal into `dynamic`. */
function mergePrototypeCallables(
  proto: Expression,
  index: FileCallableIndex,
  activeObjects: Set<ObjectLiteralExpression>,
  dynamic: Set<Node>,
): void {
  const protoObjects = candidateObjects(proto, index.variableWrites, new Set());
  for (const protoObj of protoObjects) {
    const inner = objectCallables(protoObj, index, activeObjects);
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
  index: FileCallableIndex,
  activeObjects: Set<ObjectLiteralExpression>,
  state: { readonly dynamic: Set<Node>; readonly named: Map<string, Set<Node>> },
): void {
  const assignedItems = index.memberCallables.get(object);
  if (assignedItems !== undefined) {
    for (const item of assignedItems) {
      recordAssignedItem(item, index, activeObjects, state);
    }
  }
  const spreadSources = index.assignedSpreads.get(object);
  if (spreadSources !== undefined) {
    for (const source of spreadSources) {
      mergeSpreadCallables(source, index, activeObjects, state);
    }
  }
}

/** Resolves and records one post-declaration member callable assignment onto `state`. */
function recordAssignedItem(
  item: AssignedCallable,
  index: FileCallableIndex,
  activeObjects: Set<ObjectLiteralExpression>,
  state: { readonly dynamic: Set<Node>; readonly named: Map<string, Set<Node>> },
): void {
  const resolved = isMethodDeclaration(item.callable)
    ? [item.callable]
    : expressionCallables(item.callable, { activeObjects, index, seen: new Set() });
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

/** Resolves non-arrow callables reachable from `value` across aliases, branches, and member reads. */
function expressionCallables(value: Expression, context: CallableLookupContext): readonly Node[] {
  if (isFunctionExpression(value)) {
    return [value];
  }
  if (isArrowFunction(value)) {
    return [];
  }
  if (isConditionalExpression(value)) {
    return [
      ...expressionCallables(unwrapped(value.whenTrue), context),
      ...expressionCallables(unwrapped(value.whenFalse), context),
    ];
  }
  if (isBinaryExpression(value) && LOGICAL_FORWARDING.has(value.operatorToken.kind)) {
    return [
      ...expressionCallables(unwrapped(value.left), context),
      ...expressionCallables(unwrapped(value.right), context),
    ];
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = isPropertyAccessExpression(value) ? value.name.text : staticElementKey(value);
    return lookupMemberCallables(unwrapped(value.expression), key, context);
  }
  return isIdentifier(value) ? identifierCallables(value, context) : [];
}

/** Resolves data callables stored under `key` (or any key when dynamic) on `holder`. */
function lookupMemberCallables(
  holder: Expression,
  key: string | undefined,
  context: CallableLookupContext,
): readonly Node[] {
  const found: Node[] = [];
  const sourceObjects = candidateObjects(holder, context.index.variableWrites, new Set());
  for (const srcObj of sourceObjects) {
    const inner = objectCallables(srcObj, context.index, context.activeObjects);
    appendObjectCallablesForKey(inner, key, found);
  }
  return found;
}

/** Appends dynamic and matching `key` callables from `inner` onto `found`. */
function appendObjectCallablesForKey(
  inner: ObjectCallables,
  key: string | undefined,
  found: Node[],
): void {
  for (const callable of inner.dynamic) {
    found.push(callable);
  }
  if (key === undefined) {
    const groups = inner.named.values();
    for (const group of groups) {
      for (const callable of group) {
        found.push(callable);
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

/** Resolves callables referenced by an identifier (`function swap`, `const s = ...`, `const { swap } = base`). */
function identifierCallables(node: Identifier, context: CallableLookupContext): readonly Node[] {
  const declared = frameDeclarationOf(node);
  if (declared === undefined) {
    return [];
  }
  const target = declaredBindingTarget(node, declared);
  if (context.seen.has(target)) {
    return [];
  }
  context.seen.add(target);
  if (isFunctionDeclaration(declared)) {
    return [declared];
  }
  if (!isVariableDeclaration(declared)) {
    return [];
  }
  const results = isIdentifier(declared.name)
    ? simpleVariableCallables(declared, context)
    : [...destructuredCallables(node, declared, context)];
  if (!isConstVariable(declared)) {
    const writes = context.index.variableWrites.get(target);
    if (writes !== undefined) {
      for (const assigned of writes) {
        results.push(...expressionCallables(assigned, context));
      }
    }
  }
  return results;
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
  const holders = resolveIntermediateObjectHolders(declared, steps.slice(0, -1), context);
  if (holders === undefined) {
    return [];
  }
  return collectLeafDestructuredCallables(holders, leaf, context);
}

/** Advances candidate object holder expressions across outer destructuring steps. */
function resolveIntermediateObjectHolders(
  declared: VariableDeclaration,
  outerSteps: readonly BindingElement[],
  context: CallableLookupContext,
): readonly Expression[] | undefined {
  let holders: Expression[] =
    declared.initializer === undefined ? [] : [unwrapped(declared.initializer)];
  for (const step of outerSteps) {
    if (!isObjectBindingPattern(step.parent) || step.dotDotDotToken !== undefined) {
      return undefined;
    }
    holders = advanceSingleObjectStep(holders, step, context.index.variableWrites);
  }
  return holders;
}

/** Advances `holders` across a single intermediate object binding `step` and its default. */
function advanceSingleObjectStep(
  holders: readonly Expression[],
  step: BindingElement,
  writes: VariableWriteMap,
): Expression[] {
  const next: Expression[] = [];
  const key = patternKey(step);
  if (key !== undefined) {
    for (const holder of holders) {
      const objs = candidateObjects(holder, writes, new Set());
      next.push(...selectMemberObjects(objs, key, writes, new Set()));
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
