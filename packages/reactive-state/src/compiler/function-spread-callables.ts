import {
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
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { patternKey } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  callableThisWrites,
  EMPTY_WRITES,
  type ObjectWrites,
  staticElementKey,
} from './function-this-writes.ts';

/** Member callable assignment recorded against an object literal (`obj.swap = fn` or `defineProperty`). */
export interface AssignedCallable {
  readonly callable: Node | Expression;
  readonly key: string | undefined;
}

/** Per-file index of variable reassignments, member callable assignments, and `Object.assign` sources. */
export interface FileCallableIndex {
  readonly assignedSpreads: ReadonlyMap<ObjectLiteralExpression, readonly Expression[]>;
  readonly memberCallables: ReadonlyMap<ObjectLiteralExpression, readonly AssignedCallable[]>;
  readonly variableWrites: ReadonlyMap<VariableDeclaration, readonly Expression[]>;
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

/** Logical operators that can forward either operand as a spread source or callable value. */
const LOGICAL_FORWARDING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

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

/** Resolves `ObjectLiteralExpression`s reachable from `node` across aliases and branches. */
export function candidateObjects(
  node: Expression,
  variableWrites: ReadonlyMap<VariableDeclaration, readonly Expression[]>,
  seen: Set<Node>,
): readonly ObjectLiteralExpression[] {
  if (isObjectLiteralExpression(node)) {
    return [node];
  }
  if (isConditionalExpression(node)) {
    return [
      ...candidateObjects(unwrapped(node.whenTrue), variableWrites, seen),
      ...candidateObjects(unwrapped(node.whenFalse), variableWrites, seen),
    ];
  }
  if (isBinaryExpression(node) && LOGICAL_FORWARDING.has(node.operatorToken.kind)) {
    return [
      ...candidateObjects(unwrapped(node.left), variableWrites, seen),
      ...candidateObjects(unwrapped(node.right), variableWrites, seen),
    ];
  }
  const declared = isIdentifier(node) ? frameDeclarationOf(node) : undefined;
  if (declared === undefined || !isVariableDeclaration(declared) || seen.has(declared)) {
    return [];
  }
  seen.add(declared);
  const objects: ObjectLiteralExpression[] = [];
  if (declared.initializer !== undefined) {
    objects.push(...candidateObjects(unwrapped(declared.initializer), variableWrites, seen));
  }
  if (!isConstVariable(declared)) {
    for (const assigned of variableWrites.get(declared) ?? []) {
      objects.push(...candidateObjects(assigned, variableWrites, seen));
    }
  }
  return objects;
}

/** Static property key of an object literal element. */
export function literalElementKey(property: ObjectLiteralElementLike): string | undefined {
  if (isSpreadAssignment(property)) {
    return undefined;
  }
  if (isShorthandPropertyAssignment(property)) {
    return isIdentifier(property.name) ? property.name.text : undefined;
  }
  return keyOfPropertyName(property.name);
}

/** Static string, template, or numeric key expression. */
export function staticArgumentKey(node: Expression): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return isNumericLiteral(node) ? String(Number(node.text)) : undefined;
}

/** Flattens named data callables, dynamic data callables, and own accessors of `callables`. */
function collectAllCallables(callables: ObjectCallables): readonly Node[] {
  const list = new Set<Node>(callables.dynamic);
  for (const accessor of callables.ownAccessors) {
    list.add(accessor);
  }
  for (const group of callables.named.values()) {
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
  for (const spreadObj of candidateObjects(source, index.variableWrites, new Set())) {
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
  for (const protoObj of candidateObjects(proto, index.variableWrites, new Set())) {
    const inner = objectCallables(protoObj, index, activeObjects);
    for (const callable of inner.dynamic) {
      dynamic.add(callable);
    }
    for (const group of inner.named.values()) {
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
  for (const item of index.memberCallables.get(object) ?? []) {
    const resolved = isMethodDeclaration(item.callable)
      ? [item.callable]
      : expressionCallables(item.callable, { activeObjects, index, seen: new Set() });
    if (item.key === undefined) {
      for (const callable of resolved) {
        state.dynamic.add(callable);
      }
    } else {
      addNamedCallables(state.named, item.key, resolved);
    }
  }
  for (const source of index.assignedSpreads.get(object) ?? []) {
    mergeSpreadCallables(source, index, activeObjects, state);
  }
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
  for (const srcObj of candidateObjects(holder, context.index.variableWrites, new Set())) {
    const inner = objectCallables(srcObj, context.index, context.activeObjects);
    for (const callable of inner.dynamic) {
      found.push(callable);
    }
    if (key === undefined) {
      for (const group of inner.named.values()) {
        for (const callable of group) {
          found.push(callable);
        }
      }
    } else {
      for (const callable of inner.named.get(key) ?? []) {
        found.push(callable);
      }
    }
  }
  return found;
}

/** Resolves callables referenced by an identifier (`function swap`, `const s = ...`, `const { swap } = base`). */
function identifierCallables(node: Identifier, context: CallableLookupContext): readonly Node[] {
  const declared = frameDeclarationOf(node);
  if (declared === undefined || context.seen.has(declared)) {
    return [];
  }
  context.seen.add(declared);
  if (isFunctionDeclaration(declared)) {
    return [declared];
  }
  if (!isVariableDeclaration(declared)) {
    return [];
  }
  if (isIdentifier(declared.name)) {
    const results: Node[] = [];
    if (declared.initializer !== undefined) {
      results.push(...expressionCallables(unwrapped(declared.initializer), context));
    }
    if (!isConstVariable(declared)) {
      for (const assigned of context.index.variableWrites.get(declared) ?? []) {
        results.push(...expressionCallables(assigned, context));
      }
    }
    return results;
  }
  return destructuredCallables(node.text, declared, context);
}

/** Resolves callables bound through a top-level object destructuring (`const { swap = fn } = base`). */
function destructuredCallables(
  targetName: string,
  declared: VariableDeclaration,
  context: CallableLookupContext,
): readonly Node[] {
  if (!isObjectBindingPattern(declared.name)) {
    return [];
  }
  const element = declared.name.elements.find(
    (each) => each.name !== undefined && isIdentifier(each.name) && each.name.text === targetName,
  );
  if (element === undefined) {
    return [];
  }
  const results: Node[] = [];
  const key = patternKey(element);
  if (declared.initializer !== undefined && key !== undefined) {
    results.push(...lookupMemberCallables(unwrapped(declared.initializer), key, context));
  }
  if (element.initializer !== undefined) {
    results.push(...expressionCallables(unwrapped(element.initializer), context));
  }
  return results;
}

/** Whether `declared` belongs to a `const` variable declaration list. */
function isConstVariable(declared: VariableDeclaration): boolean {
  return (
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/** Static string, template, identifier, or numeric property name. */
function keyOfPropertyName(name: PropertyName): string | undefined {
  if (isComputedPropertyName(name)) {
    return staticArgumentKey(unwrapped(name.expression));
  }
  if (isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  return isIdentifier(name) || isStringLiteral(name) ? name.text : undefined;
}
