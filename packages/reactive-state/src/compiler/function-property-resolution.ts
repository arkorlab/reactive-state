import {
  type BindingElement,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { declaredBindingTarget } from './function-binding-types.ts';
import { bindingElementSteps } from './function-candidate-objects.ts';
import { elementEntryKey, objectWrites } from './function-entry-writes.ts';
import { bindingIdentifiers } from './scope.ts';

/** Whether a function's runtime `.name` comes from an unminified entry key or a minifiable binding. */
export type FunctionKind = 'entry' | 'renamed';

/** Classification of a present object property, spread entry, or binding arm. */
export type EntryKind = FunctionKind | 'non-function' | 'unknown';

/** Resolved object literal together with whether its binding chain is immutable (`const`). */
export interface ResolvedObject {
  readonly constant: boolean;
  readonly object: ObjectLiteralExpression;
}

/** Selected property expression or clean missing-key marker on a resolved object literal. */
export type ResolvedProperty =
  | { readonly kind: 'expr'; readonly value: Expression }
  | { readonly kind: 'missing-clean' }
  | { readonly kind: 'unknown' };

/** Cycle-tracking context threaded through object and identifier resolution. */
export interface ScanContext {
  readonly classifyExpression: (node: Expression, context: ScanContext) => EntryKind;
  hitCycle: boolean;
  readonly seen: Set<Node>;
}

const MISSING_CLEAN = 'missing-clean';
const NON_FUNCTION: EntryKind = 'non-function';
const RESOLVED_PROPERTIES = new WeakMap<ObjectLiteralExpression, Map<string, ResolvedProperty>>();

/** Runs `run` with an isolated copy of `context.seen`, propagating `hitCycle` back to `context`. */
export function withBranch<T>(context: ScanContext, run: (branch: ScanContext) => T): T {
  const branch: ScanContext = {
    classifyExpression: context.classifyExpression,
    hitCycle: false,
    seen: new Set(context.seen),
  };
  const result = run(branch);
  if (branch.hitCycle) {
    context.hitCycle = true;
  }
  return result;
}

/** Joins two candidate runtime branch classifications (`'non-function'` bottom, `'renamed'` top). */
export function combineBranchKinds(left: EntryKind, right: EntryKind): EntryKind {
  if (left === 'renamed' || right === 'renamed') {
    return 'renamed';
  }
  if (left === NON_FUNCTION) {
    return right;
  }
  if (right === NON_FUNCTION) {
    return left;
  }
  return left === right ? left : 'renamed';
}

/** Resolves an inline, projected, or lexically bound object literal expression. */
export function holderObject(holder: Expression, context: ScanContext): ResolvedObject | undefined {
  if (isObjectLiteralExpression(holder)) {
    return { constant: true, object: holder };
  }
  if (isPropertyAccessExpression(holder)) {
    return projectedHolderObject(holder, holder.expression, holder.name.text, context);
  }
  if (isElementAccessExpression(holder)) {
    return projectedElementHolderObject(holder, context);
  }
  return isIdentifier(holder) ? identifierHolderObject(holder, context) : undefined;
}

/** Resolves a static bracket projection (`outer['inner']`) to its object literal. */
function projectedElementHolderObject(
  holder: ElementAccessExpression,
  context: ScanContext,
): ResolvedObject | undefined {
  const key = elementEntryKey(holder);
  return key === undefined
    ? undefined
    : projectedHolderObject(holder, holder.expression, key, context);
}

/** Resolves a static member projection (`outer.inner` or `outer['inner']`) to its object literal. */
function projectedHolderObject(
  holder: Expression,
  receiver: Expression,
  key: string,
  context: ScanContext,
): ResolvedObject | undefined {
  if (context.seen.has(holder)) {
    context.hitCycle = true;
    return undefined;
  }
  context.seen.add(holder);
  const selected = resolvePropertyValue(unwrapped(receiver), key, context);
  return selected.kind === 'expr' ? holderObject(selected.value, context) : undefined;
}

/** Resolves a simple or destructured variable identifier to its underlying object literal. */
function identifierHolderObject(
  holder: Identifier,
  context: ScanContext,
): ResolvedObject | undefined {
  const declared = frameDeclarationOf(holder);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    declared.initializer === undefined
  ) {
    return undefined;
  }
  const target = declaredBindingTarget(holder, declared);
  if (context.seen.has(target)) {
    context.hitCycle = true;
    return undefined;
  }
  context.seen.add(target);
  const source = isIdentifier(declared.name)
    ? unwrapped(declared.initializer)
    : resolvePatternObjectExpression(holder.text, declared, context);
  if (source === undefined) {
    return undefined;
  }
  const inner = holderObject(source, context);
  return inner === undefined
    ? undefined
    : { constant: inner.constant && isConstDeclaration(declared), object: inner.object };
}

/** Follows static object destructuring steps from `declared.initializer` to `targetName`. */
function resolvePatternObjectExpression(
  targetName: string,
  declared: VariableDeclaration,
  context: ScanContext,
): Expression | undefined {
  if (declared.initializer === undefined) {
    return undefined;
  }
  const bound = bindingIdentifiers(declared.name).find((each) => each.text === targetName);
  if (bound === undefined) {
    return undefined;
  }
  let current: Expression | undefined = unwrapped(declared.initializer);
  const steps = bindingElementSteps(bound);
  for (const step of steps) {
    const key = patternObjectStepKey(step);
    if (current === undefined || key === undefined) {
      return undefined;
    }
    const next = resolvePropertyValue(current, key, context);
    current = next.kind === 'expr' ? next.value : undefined;
  }
  return current;
}

/** Static object key for a non-rest, default-free object binding `step`. */
function patternObjectStepKey(step: BindingElement): string | undefined {
  if (
    step.dotDotDotToken !== undefined ||
    step.initializer !== undefined ||
    !isObjectBindingPattern(step.parent)
  ) {
    return undefined;
  }
  if (step.propertyName !== undefined) {
    return keyOf(step.propertyName);
  }
  return step.name !== undefined && isIdentifier(step.name) ? step.name.text : undefined;
}

/** Whether `declared` belongs to a `const` declaration list. */
export function isConstDeclaration(declared: VariableDeclaration): boolean {
  return (
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/** Resolves the last static property initializer for `key` on an unchanged `const` object literal. */
export function resolvePropertyValue(
  holder: Expression,
  key: string,
  context: ScanContext,
): ResolvedProperty {
  return withBranch(context, (branch) => {
    const resolved = holderObject(holder, branch);
    if (resolved?.constant !== true) {
      return { kind: 'unknown' };
    }
    const cached = RESOLVED_PROPERTIES.get(resolved.object)?.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (branch.seen.has(resolved.object)) {
      branch.hitCycle = true;
      return { kind: 'unknown' };
    }
    const writes = objectWrites(resolved.object);
    if (writes.all || writes.keys.has(key)) {
      return { kind: 'unknown' };
    }
    branch.seen.add(resolved.object);
    const found = findLastPropertyValue(resolved.object, key, branch);
    if (!branch.hitCycle) {
      cacheResolvedProperty(resolved.object, key, found);
    }
    return found;
  });
}

/** Memoizes an acyclic `(object, key)` resolution result in `RESOLVED_PROPERTIES`. */
function cacheResolvedProperty(
  object: ObjectLiteralExpression,
  key: string,
  found: ResolvedProperty,
): void {
  let map = RESOLVED_PROPERTIES.get(object);
  if (map === undefined) {
    map = new Map();
    RESOLVED_PROPERTIES.set(object, map);
  }
  map.set(key, found);
}

/** Walks `object.properties` right-to-left to locate the surviving value expression of `key`. */
function findLastPropertyValue(
  object: ObjectLiteralExpression,
  key: string,
  context: ScanContext,
): ResolvedProperty {
  for (let index = object.properties.length - 1; index >= 0; index -= 1) {
    const property = object.properties[index];
    if (property !== undefined) {
      const step = inspectPropertyElement(property, key, context);
      if (step !== undefined) {
        return step;
      }
    }
  }
  return Object.hasOwn(Object.prototype, key) ? { kind: 'unknown' } : { kind: MISSING_CLEAN };
}

/** Evaluates one right-to-left object element for `key`, or `undefined` when scanning continues. */
function inspectPropertyElement(
  property: ObjectLiteralElementLike,
  key: string,
  context: ScanContext,
): ResolvedProperty | undefined {
  if (isSpreadAssignment(property)) {
    const inner = withBranch(context, (branch) =>
      resolvePropertyValue(unwrapped(property.expression), key, branch),
    );
    return inner.kind === MISSING_CLEAN ? undefined : inner;
  }
  const propKey = propertyKey(property);
  if (isPrototypeProperty(property, propKey)) {
    return unwrapped(property.initializer).kind === SyntaxKind.NullKeyword
      ? undefined
      : { kind: 'unknown' };
  }
  if (propKey === undefined) {
    return { kind: 'unknown' };
  }
  return propKey === key ? directPropertyValue(property) : undefined;
}

/** Extracts the value expression of a matching static property or shorthand assignment. */
function directPropertyValue(property: ObjectLiteralElementLike): ResolvedProperty {
  if (isPropertyAssignment(property)) {
    return { kind: 'expr', value: unwrapped(property.initializer) };
  }
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    return { kind: 'expr', value: property.name };
  }
  return { kind: 'unknown' };
}

/** Whether `property` is a non-computed `__proto__: ...` prototype setter. */
export function isPrototypeProperty(
  property: ObjectLiteralElementLike,
  key: string | undefined,
): property is PropertyAssignment {
  return (
    key === '__proto__' && isPropertyAssignment(property) && !isComputedPropertyName(property.name)
  );
}

/** Static property key of an object literal element. */
export function propertyKey(property: ObjectLiteralElementLike): string | undefined {
  if (isSpreadAssignment(property)) {
    return undefined;
  }
  if (isShorthandPropertyAssignment(property)) {
    return isIdentifier(property.name) ? property.name.text : undefined;
  }
  return keyOf(property.name);
}

/** The name of an entry the code writes: of a name, text, or a number; none of another. */
export function keyOf(name: PropertyName): string | undefined {
  if (isComputedPropertyName(name)) {
    const value = unwrapped(name.expression);
    if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
      return value.text;
    }
    return isNumericLiteral(value) ? String(Number(value.text)) : undefined;
  }
  if (isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  return isIdentifier(name) || isStringLiteral(name) ? name.text : undefined;
}
