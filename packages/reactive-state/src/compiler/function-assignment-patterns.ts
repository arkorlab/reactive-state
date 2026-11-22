import {
  type ArrayLiteralExpression,
  type BindingElement,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isComputedPropertyName,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyName,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { isSkippedSyntax, unwrapTarget, VALUE_ASSIGNING } from './function-this-writes.ts';
import { bindingIdentifiers } from './scope.ts';

export const STEP_ARRAY_REST = 'array-rest';
export const STEP_DYNAMIC_ELEMENT = 'dynamic-element';
export const STEP_DYNAMIC_MEMBER = 'dynamic-member';
export const STEP_ELEMENT = 'element';
export const STEP_MEMBER = 'member';
export const STEP_OBJECT_REST = 'object-rest';

/** Cycle-tracking state threaded through candidate-object and array-element lookups. */
export interface CycleSeenState {
  hitCycle: boolean;
  readonly seen: Set<Node>;
}

/** Single container projection step from an assigned RHS root to a destructured target binding. */
export type AssignmentStep =
  | { readonly excludedKeys: ReadonlySet<string>; readonly kind: typeof STEP_OBJECT_REST }
  | { readonly index: number; readonly kind: typeof STEP_ELEMENT }
  | { readonly key: string; readonly kind: typeof STEP_MEMBER }
  | { readonly kind: typeof STEP_ARRAY_REST; readonly startIndex: number }
  | { readonly kind: typeof STEP_DYNAMIC_ELEMENT; readonly startIndex: number }
  | { readonly kind: typeof STEP_DYNAMIC_MEMBER };

/** Post-declaration assignment RHS root together with outer-to-inner destructuring steps. */
export interface AssignedBindingSource {
  readonly root: Expression;
  readonly steps: readonly AssignmentStep[];
}

type ReassignmentMap = Map<Node, AssignedBindingSource[]>;

interface AssignmentScanState {
  readonly handledDefaults: Set<Node>;
  readonly map: ReassignmentMap;
}

const REASSIGNMENTS = new WeakMap<
  SourceFile,
  ReadonlyMap<Node, readonly AssignedBindingSource[]>
>();

/** Resolves the specific declaring `Identifier` node within `declared` for `node`. */
export function declaredBindingTarget(node: Identifier, declared: FrameDeclaration): Node {
  if (isVariableDeclaration(declared) || isParameterDeclaration(declared)) {
    return bindingIdentifiers(declared.name).find((each) => each.text === node.text) ?? declared;
  }
  return declared;
}

/** Collects enclosing `BindingElement`s from outermost pattern to innermost binding `bound`. */
export function bindingElementSteps(bound: Identifier): readonly BindingElement[] {
  const steps: BindingElement[] = [];
  for (
    let at: Node = bound.parent;
    !isVariableDeclaration(at) && !isParameterDeclaration(at);
    at = at.parent
  ) {
    if (isBindingElement(at)) {
      steps.unshift(at);
    }
  }
  return steps;
}

/** Whether `declared` belongs to a `const` variable declaration list. */
export function isConstVariable(declared: VariableDeclaration): boolean {
  return (
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/** Static property key of an object literal element. */
export function literalElementKey(property: ObjectLiteralElementLike): string | undefined {
  if (isSpreadAssignment(property)) {
    return undefined;
  }
  if (isShorthandPropertyAssignment(property)) {
    return isIdentifier(property.name) ? property.name.text : undefined;
  }
  return propertyNameText(property.name);
}

/** Static string, template, or numeric key expression. */
export function staticArgumentKey(node: Expression): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return isNumericLiteral(node) ? String(Number(node.text)) : undefined;
}

/** Static object key selected by `step`. */
export function bindingStepKey(step: BindingElement): string | undefined {
  if (step.propertyName !== undefined) {
    return propertyNameText(step.propertyName);
  }
  return step.name !== undefined && isIdentifier(step.name) ? step.name.text : undefined;
}

/** Static string, template, identifier, or numeric property name. */
export function propertyNameText(name: PropertyName): string | undefined {
  if (isComputedPropertyName(name)) {
    return staticArgumentKey(unwrapped(name.expression));
  }
  if (isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  return isIdentifier(name) || isStringLiteral(name) ? name.text : undefined;
}

/** Normalizes `array-rest` and `object-rest` steps right-to-left, or `undefined` if unreachable. */
export function normalizeAssignmentSteps(
  steps: readonly AssignmentStep[],
): readonly AssignmentStep[] | undefined {
  let acc: AssignmentStep[] = [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step !== undefined) {
      const folded = prependNormalizedStep(step, acc);
      if (folded === undefined) {
        return undefined;
      }
      acc = folded;
    }
  }
  return acc;
}

/** Folds `head` onto an already-normalized suffix `tail`. */
function prependNormalizedStep(
  head: AssignmentStep,
  tail: AssignmentStep[],
): AssignmentStep[] | undefined {
  if (head.kind === STEP_ARRAY_REST) {
    return foldArrayRestStep(head.startIndex, tail);
  }
  if (head.kind === STEP_OBJECT_REST) {
    return foldObjectRestStep(head.excludedKeys, tail);
  }
  return [head, ...tail];
}

/** Projects suffix steps through `Array.prototype.slice(startIndex)` produced by an array rest target. */
function foldArrayRestStep(
  startIndex: number,
  tail: AssignmentStep[],
): AssignmentStep[] | undefined {
  const [next, ...after] = tail;
  if (next === undefined) {
    return [{ kind: STEP_ARRAY_REST, startIndex }];
  }
  if (next.kind === STEP_ELEMENT) {
    return [{ index: startIndex + next.index, kind: STEP_ELEMENT }, ...after];
  }
  if (next.kind === STEP_ARRAY_REST) {
    return [{ kind: STEP_ARRAY_REST, startIndex: startIndex + next.startIndex }, ...after];
  }
  if (next.kind === STEP_DYNAMIC_ELEMENT) {
    return [{ kind: STEP_DYNAMIC_ELEMENT, startIndex: startIndex + next.startIndex }, ...after];
  }
  if (next.kind === STEP_MEMBER) {
    return /^\d+$/u.test(next.key)
      ? [{ index: startIndex + Number(next.key), kind: STEP_ELEMENT }, ...after]
      : undefined;
  }
  if (next.kind === STEP_DYNAMIC_MEMBER) {
    return [{ kind: STEP_DYNAMIC_ELEMENT, startIndex }, ...after];
  }
  if (after.length === 0) {
    return undefined;
  }
  let skip = 0;
  while (next.excludedKeys.has(String(skip))) {
    skip += 1;
  }
  return [{ kind: STEP_DYNAMIC_ELEMENT, startIndex: startIndex + skip }, ...after.slice(1)];
}

/** Projects suffix steps through `CopyDataProperties` produced by an object rest target. */
function foldObjectRestStep(
  excludedKeys: ReadonlySet<string>,
  tail: AssignmentStep[],
): AssignmentStep[] | undefined {
  const [next, ...after] = tail;
  if (next === undefined) {
    return [{ excludedKeys, kind: STEP_OBJECT_REST }];
  }
  if (next.kind === STEP_MEMBER) {
    return excludedKeys.has(next.key) ? undefined : [next, ...after];
  }
  if (next.kind === STEP_OBJECT_REST) {
    return [
      { excludedKeys: new Set([...excludedKeys, ...next.excludedKeys]), kind: STEP_OBJECT_REST },
      ...after,
    ];
  }
  if (next.kind === STEP_DYNAMIC_MEMBER) {
    return excludedKeys.size === 0
      ? [next, ...after]
      : [{ excludedKeys, kind: STEP_OBJECT_REST }, next, ...after];
  }
  return undefined;
}

/** Indexes post-declaration assignment sources per declared binding node across `file`. */
export function bindingReassignments(
  file: SourceFile,
): ReadonlyMap<Node, readonly AssignedBindingSource[]> {
  const cached = REASSIGNMENTS.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const map: ReassignmentMap = new Map();
  const handledDefaults = new Set<Node>();
  const state: AssignmentScanState = { handledDefaults, map };
  const visit = (node: Node): void => {
    if (isSkippedSyntax(node)) {
      return;
    }
    if (
      isBinaryExpression(node) &&
      VALUE_ASSIGNING.has(node.operatorToken.kind) &&
      !handledDefaults.has(node)
    ) {
      recordAssignedTarget(
        unwrapTarget(node.left),
        { root: unwrapped(node.right), steps: [] },
        state,
      );
    }
    node.forEachChild(visit);
  };
  visit(file);
  REASSIGNMENTS.set(file, map);
  return map;
}

/** Records direct, object-destructured, or array-destructured assignment targets into `state.map`. */
function recordAssignedTarget(
  target: Node,
  source: AssignedBindingSource,
  state: AssignmentScanState,
): void {
  if (isIdentifier(target)) {
    const declared = frameDeclarationOf(target);
    if (
      declared !== undefined &&
      (isVariableDeclaration(declared) || isParameterDeclaration(declared))
    ) {
      appendSource(state.map, declaredBindingTarget(target, declared), source);
    }
    return;
  }
  if (isObjectLiteralExpression(target)) {
    recordObjectAssignmentPattern(target, source, state);
    return;
  }
  if (isArrayLiteralExpression(target)) {
    recordArrayAssignmentPattern(target, source, state);
  }
}

/** Records property selections, object rest copies, and defaults on `({ a, ...rest } = holder)`. */
function recordObjectAssignmentPattern(
  pattern: Expression,
  source: AssignedBindingSource,
  state: AssignmentScanState,
): void {
  if (!isObjectLiteralExpression(pattern)) {
    return;
  }
  const excludedKeys = new Set<string>();
  for (const prop of pattern.properties) {
    recordObjectAssignmentElement(prop, source, excludedKeys, state);
  }
}

/** Records a single property or spread element inside an object assignment pattern. */
function recordObjectAssignmentElement(
  prop: ObjectLiteralElementLike,
  source: AssignedBindingSource,
  excludedKeys: Set<string>,
  state: AssignmentScanState,
): void {
  if (isSpreadAssignment(prop)) {
    const restInner = unwrapDefaultedTarget(prop.expression, state);
    const nextStep: AssignmentStep = {
      excludedKeys: new Set(excludedKeys),
      kind: STEP_OBJECT_REST,
    };
    recordAssignedTarget(
      restInner,
      { root: source.root, steps: [...source.steps, nextStep] },
      state,
    );
    return;
  }
  if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) {
    excludedKeys.add(prop.name.text);
    const nextStep: AssignmentStep = { key: prop.name.text, kind: STEP_MEMBER };
    recordAssignedTarget(
      prop.name,
      { root: source.root, steps: [...source.steps, nextStep] },
      state,
    );
    if (prop.objectAssignmentInitializer !== undefined) {
      const fallback = unwrapped(prop.objectAssignmentInitializer);
      recordAssignedTarget(prop.name, { root: fallback, steps: [] }, state);
    }
    return;
  }
  if (!isPropertyAssignment(prop)) {
    return;
  }
  const inner = unwrapDefaultedTarget(prop.initializer, state);
  const key = propertyNameText(prop.name);
  if (key !== undefined) {
    excludedKeys.add(key);
  }
  const nextStep: AssignmentStep =
    key === undefined ? { kind: STEP_DYNAMIC_MEMBER } : { key, kind: STEP_MEMBER };
  recordAssignedTarget(inner, { root: source.root, steps: [...source.steps, nextStep] }, state);
}

/** Records indexed selections, rest copies, and assignment defaults on `([first, ...rest] = items)`. */
function recordArrayAssignmentPattern(
  pattern: Expression,
  source: AssignedBindingSource,
  state: AssignmentScanState,
): void {
  if (!isArrayLiteralExpression(pattern)) {
    return;
  }
  for (const [index, element] of pattern.elements.entries()) {
    if (isSpreadElement(element)) {
      const restInner = unwrapDefaultedTarget(element.expression, state);
      const nextStep: AssignmentStep = { kind: STEP_ARRAY_REST, startIndex: index };
      recordAssignedTarget(
        restInner,
        { root: source.root, steps: [...source.steps, nextStep] },
        state,
      );
    } else if (!isOmittedExpression(element)) {
      const inner = unwrapDefaultedTarget(element, state);
      const nextStep: AssignmentStep = { index, kind: STEP_ELEMENT };
      recordAssignedTarget(inner, { root: source.root, steps: [...source.steps, nextStep] }, state);
    }
  }
}

/** Records `= fallback` inside a destructuring assignment target and returns the inner target. */
function unwrapDefaultedTarget(node: Expression, state: AssignmentScanState): Node {
  let current = unwrapTarget(node);
  while (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    state.handledDefaults.add(current);
    const inner = unwrapTarget(current.left);
    recordAssignedTarget(inner, { root: unwrapped(current.right), steps: [] }, state);
    current = inner;
  }
  return current;
}

/** Appends `source` to `map.get(binding)`. */
function appendSource(map: ReassignmentMap, binding: Node, source: AssignedBindingSource): void {
  const list = map.get(binding);
  if (list === undefined) {
    map.set(binding, [source]);
    return;
  }
  list.push(source);
}

/** Selects `[element]` at `index` of a resolved `ArrayLiteralExpression` without prior spreads. */
export function selectSingleArrayExpressions(
  holder: Expression,
  index: number,
  state: CycleSeenState,
): readonly Expression[] {
  const array = resolveSimpleArrayLiteral(holder, state);
  if (
    array === undefined ||
    index < 0 ||
    array.elements.slice(0, index + 1).some((each) => isSpreadElement(each))
  ) {
    return [];
  }
  const element = array.elements[index];
  return element === undefined || isOmittedExpression(element) ? [] : [unwrapped(element)];
}

/** Selects non-spread elements of a resolved `ArrayLiteralExpression` from `startIndex` onwards. */
export function selectRangeArrayExpressions(
  holder: Expression,
  startIndex: number,
  state: CycleSeenState,
): readonly Expression[] {
  const array = resolveSimpleArrayLiteral(holder, state);
  if (array === undefined || startIndex < 0) {
    return [];
  }
  const offset = array.elements.slice(0, startIndex).every((each) => !isSpreadElement(each))
    ? startIndex
    : 0;
  const out: Expression[] = [];
  for (const element of array.elements.slice(offset)) {
    if (!isSpreadElement(element) && !isOmittedExpression(element)) {
      out.push(unwrapped(element));
    }
  }
  return out;
}

/** Follows simple `const` identifier initializers to an `ArrayLiteralExpression`. */
function resolveSimpleArrayLiteral(
  holder: Expression,
  state: CycleSeenState,
): ArrayLiteralExpression | undefined {
  let current: Expression = holder;
  for (;;) {
    if (isArrayLiteralExpression(current)) {
      return current;
    }
    const declared = isIdentifier(current) ? frameDeclarationOf(current) : undefined;
    if (
      declared === undefined ||
      !isVariableDeclaration(declared) ||
      !isIdentifier(declared.name) ||
      !isConstVariable(declared) ||
      declared.initializer === undefined
    ) {
      return undefined;
    }
    if (state.seen.has(declared.name)) {
      state.hitCycle = true;
      return undefined;
    }
    state.seen.add(declared.name);
    current = unwrapped(declared.initializer);
  }
}
