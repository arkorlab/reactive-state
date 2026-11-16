import {
  type ArrayLiteralExpression,
  type BindingElement,
  type BindingName,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBindingElement,
  isConstructorTypeNode,
  isDecorator,
  isFunctionTypeNode,
  isIdentifier,
  isObjectBindingPattern,
  isOmittedExpression,
  isParameterDeclaration,
  isSpreadElement,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  type TypeNode,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { namesType } from './framed.ts';
import {
  combineBranchKinds,
  type EntryKind,
  type FunctionKind,
  hasScanKind,
  holderObject,
  isConstDeclaration,
  keyOf,
  memberEntryKind,
  type ResolvedObject,
  type ResolvedProperty,
  resolvePropertyValue,
  type ScanContext,
  scanResolvedObject,
  withBranch,
} from './function-table-entries.ts';
import { bindingIdentifiers } from './scope.ts';

/** The types a parameter is said to be a function of by their names: `Function`, and its kin. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'CallableFunction',
  'Function',
  'NewableFunction',
]);

/** Classifies a dynamic lookup across all entries of a written object literal. */
export function dynamicObjectEntryKind(holder: Expression, context: ScanContext): EntryKind {
  const resolved = holderObject(holder, context);
  if (resolved === undefined) {
    return 'unknown';
  }
  return tableFunctionKind(resolved, context) ?? 'unknown';
}

/** Classifies a dynamic lookup across all entries of `resolved`. */
function tableFunctionKind(
  resolved: ResolvedObject,
  context: ScanContext,
): FunctionKind | undefined {
  const scan = scanResolvedObject(resolved, context);
  if (scan.stickyRenamed || hasScanKind(scan.entries, 'renamed')) {
    return 'renamed';
  }
  if (scan.dynamicEntry || hasScanKind(scan.entries, 'entry')) {
    return scan.unverified || hasScanKind(scan.entries, 'unknown') ? 'renamed' : 'entry';
  }
  return undefined;
}

/** Resolves an identifier through declarations, destructuring patterns, and function parameters. */
export function identifierEntryKind(node: Identifier, context: ScanContext): EntryKind {
  const declared = frameDeclarationOf(node);
  if (declared === undefined) {
    return 'unknown';
  }
  if (isParameterDeclaration(declared)) {
    return isOutsideParameterScope(node, declared)
      ? 'unknown'
      : parameterEntryKind(node, declared, context);
  }
  if (context.seen.has(declared)) {
    context.hitCycle = true;
    return 'unknown';
  }
  context.seen.add(declared);
  return isVariableDeclaration(declared) ? variableEntryKind(node, declared, context) : 'renamed';
}

/** Whether `node` always evaluates to `undefined` (`void ...` or unshadowed `undefined`). */
export function isGuaranteedUndefined(node: Expression): boolean {
  return isVoidExpression(node) || globalPathOf(node)?.join('.') === 'undefined';
}

/** Whether `node` sits in a signature's own computed name or decorators rather than its parameter scope. */
function isOutsideParameterScope(node: Identifier, parameter: ParameterDeclaration): boolean {
  const owner = parameter.parent;
  const ownerName = 'name' in owner ? owner.name : undefined;
  for (let at: Node = node; at !== owner; at = at.parent) {
    if (at === ownerName || isDecorator(at)) {
      return true;
    }
  }
  return false;
}

/** Classifies simple or destructured variable bindings, degrading non-`const` bindings. */
function variableEntryKind(
  node: Identifier,
  declared: VariableDeclaration,
  context: ScanContext,
): EntryKind {
  const constant = isConstDeclaration(declared);
  if (isIdentifier(declared.name)) {
    return simpleVariableEntryKind(declared, constant, context);
  }
  const source: ResolvedProperty =
    declared.initializer === undefined
      ? { kind: 'unknown' }
      : { kind: 'expr', value: unwrapped(declared.initializer) };
  const resolved = patternEntryKind(node.text, declared.name, source, context);
  return constant ? resolved : degradeMutableKind(resolved);
}

/** Preserves `'entry'` and `'non-function'` across `const` aliases while degrading `let`/`var`. */
function simpleVariableEntryKind(
  declared: VariableDeclaration,
  constant: boolean,
  context: ScanContext,
): EntryKind {
  const fromInit =
    declared.initializer === undefined
      ? 'unknown'
      : context.classifyExpression(unwrapped(declared.initializer), context);
  if (fromInit === 'unknown' && isFunctionType(declared.type)) {
    return 'renamed';
  }
  return constant ? fromInit : degradeMutableKind(fromInit);
}

/** Classifies simple or destructured parameter bindings, combining caller input with defaults. */
function parameterEntryKind(
  node: Identifier,
  parameter: ParameterDeclaration,
  context: ScanContext,
): EntryKind {
  if (context.seen.has(parameter)) {
    context.hitCycle = true;
    return 'unknown';
  }
  context.seen.add(parameter);
  const { initializer } = parameter;
  if (isIdentifier(parameter.name)) {
    const callerKind: EntryKind = isFunctionType(parameter.type) ? 'renamed' : 'unknown';
    if (initializer === undefined) {
      return callerKind;
    }
    const defaultKind = withBranch(context, (branch) =>
      branch.classifyExpression(unwrapped(initializer), branch),
    );
    return degradeMutableKind(combineBranchKinds(callerKind, defaultKind));
  }
  const callerKind = withBranch(context, (branch) =>
    patternEntryKind(node.text, parameter.name, { kind: 'unknown' }, branch),
  );
  if (initializer === undefined) {
    return degradeMutableKind(callerKind);
  }
  const defaultSource: ResolvedProperty = { kind: 'expr', value: unwrapped(initializer) };
  const defaultKind = withBranch(context, (branch) =>
    patternEntryKind(node.text, parameter.name, defaultSource, branch),
  );
  return degradeMutableKind(combineBranchKinds(callerKind, defaultKind));
}

/** Degrades `'entry'` to `'renamed'` and `'non-function'` to `'unknown'` on mutable/caller bindings. */
function degradeMutableKind(kind: EntryKind): EntryKind {
  return kind === 'entry' || kind === 'renamed' ? 'renamed' : 'unknown';
}

/** Evaluates a destructuring pattern path from `source` down to `targetName`. */
function patternEntryKind(
  targetName: string,
  pattern: BindingName,
  source: ResolvedProperty,
  context: ScanContext,
): EntryKind {
  const bound = bindingIdentifiers(pattern).find((each) => each.text === targetName);
  return bound === undefined
    ? 'unknown'
    : evaluateBindingSteps(source, patternSteps(bound), 0, context);
}

/** Collects enclosing `BindingElement`s from outermost pattern to innermost binding `bound`. */
function patternSteps(bound: Identifier): readonly BindingElement[] {
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

/** Steps through destructuring elements, combining source slots with pattern defaults at each level. */
function evaluateBindingSteps(
  source: ResolvedProperty,
  steps: readonly BindingElement[],
  index: number,
  context: ScanContext,
): EntryKind {
  const step = steps[index];
  if (step === undefined) {
    return 'unknown';
  }
  if (step.dotDotDotToken !== undefined) {
    return index + 1 < steps.length
      ? evaluateBindingSteps({ kind: 'unknown' }, steps, index + 1, context)
      : 'unknown';
  }
  return index + 1 === steps.length
    ? leafStepEntryKind(source, step, context)
    : intermediateStepEntryKind(source, steps, index, context);
}

/** Combines a leaf binding element's selected slot classification with its default initializer. */
function leafStepEntryKind(
  source: ResolvedProperty,
  step: BindingElement,
  context: ScanContext,
): EntryKind {
  const { initializer } = step;
  if (initializer === undefined) {
    return slotEntryKind(source, step, context);
  }
  const fromSource = withBranch(context, (branch) => slotEntryKind(source, step, branch));
  const fromDefault = withBranch(context, (branch) =>
    branch.classifyExpression(unwrapped(initializer), branch),
  );
  return combineBranchKinds(fromSource, fromDefault);
}

/** Advances an intermediate pattern step, combining outer pattern defaults when present. */
function intermediateStepEntryKind(
  source: ResolvedProperty,
  steps: readonly BindingElement[],
  index: number,
  context: ScanContext,
): EntryKind {
  const step = steps[index];
  if (step === undefined) {
    return 'unknown';
  }
  const selected = selectIntermediateSlot(source, step, context);
  const { initializer } = step;
  if (initializer === undefined) {
    return selected.kind === 'missing-clean'
      ? 'unknown'
      : evaluateBindingSteps(selected, steps, index + 1, context);
  }
  const defaultBranch = withBranch(context, (branch) =>
    evaluateBindingSteps({ kind: 'expr', value: unwrapped(initializer) }, steps, index + 1, branch),
  );
  if (
    selected.kind === 'missing-clean' ||
    (selected.kind === 'expr' && isGuaranteedUndefined(selected.value))
  ) {
    return defaultBranch;
  }
  const sourceBranch = withBranch(context, (branch) =>
    evaluateBindingSteps(selected, steps, index + 1, branch),
  );
  return combineBranchKinds(sourceBranch, defaultBranch);
}

/** Classifies the value selected by `step` from `source` at the leaf of a binding pattern. */
function slotEntryKind(
  source: ResolvedProperty,
  step: BindingElement,
  context: ScanContext,
): EntryKind {
  if (source.kind === 'missing-clean') {
    return 'non-function';
  }
  if (source.kind === 'unknown') {
    return 'unknown';
  }
  if (isObjectBindingPattern(step.parent)) {
    const key = bindingElementKey(step);
    return key === undefined
      ? dynamicObjectEntryKind(source.value, context)
      : memberEntryKind(source.value, key, context);
  }
  return isArrayBindingPattern(step.parent)
    ? arraySlotEntryKind(source.value, step.parent.elements.indexOf(step), context)
    : 'unknown';
}

/** Resolves the nested container expression selected by an intermediate `BindingElement`. */
function selectIntermediateSlot(
  source: ResolvedProperty,
  step: BindingElement,
  context: ScanContext,
): ResolvedProperty {
  if (source.kind !== 'expr') {
    return { kind: 'unknown' };
  }
  if (isObjectBindingPattern(step.parent)) {
    const key = bindingElementKey(step);
    return key === undefined
      ? { kind: 'unknown' }
      : resolvePropertyValue(source.value, key, context);
  }
  return isArrayBindingPattern(step.parent)
    ? selectInlineArrayElement(source.value, step.parent.elements.indexOf(step))
    : { kind: 'unknown' };
}

/** Selects element `index` of an inline destructured array literal without prior spread elements. */
function selectInlineArrayElement(holder: Expression, index: number): ResolvedProperty {
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
    return { kind: 'missing-clean' };
  }
  return { kind: 'expr', value: unwrapped(element) };
}

/** Classifies element `index` of an inline or variable-bound array literal in array destructuring. */
function arraySlotEntryKind(holder: Expression, index: number, context: ScanContext): EntryKind {
  const inline = selectInlineArrayElement(holder, index);
  if (inline.kind === 'missing-clean') {
    return 'non-function';
  }
  if (inline.kind === 'expr') {
    return context.classifyExpression(inline.value, context);
  }
  return unverifiedArraySlotKind(holder, index, context);
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
  if (!array.elements.slice(0, index + 1).some((each) => isSpreadElement(each))) {
    const element = array.elements[index];
    return element === undefined || isOmittedExpression(element)
      ? 'unknown'
      : degradeMutableKind(context.classifyExpression(unwrapped(element), context));
  }
  for (const element of array.elements) {
    if (!isOmittedExpression(element) && !isSpreadElement(element)) {
      const each = withBranch(context, (branch) =>
        branch.classifyExpression(unwrapped(element), branch),
      );
      if (each === 'entry' || each === 'renamed') {
        return 'renamed';
      }
    }
  }
  return 'unknown';
}

/** Follows an identifier chain to an `ArrayLiteralExpression`, if any. */
function resolveArrayLiteral(
  holder: Expression,
  context: ScanContext,
): ArrayLiteralExpression | undefined {
  if (isArrayLiteralExpression(holder)) {
    return holder;
  }
  const declared = isIdentifier(holder) ? frameDeclarationOf(holder) : undefined;
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    declared.initializer === undefined
  ) {
    return undefined;
  }
  if (context.seen.has(declared)) {
    context.hitCycle = true;
    return undefined;
  }
  context.seen.add(declared);
  return resolveArrayLiteral(unwrapped(declared.initializer), context);
}

/** Whether `node` stands directly as a destructuring initializer with no identifier alias to mutate it. */
function isInlinePatternSource(node: ArrayLiteralExpression): boolean {
  const { at, parent } = useOf(node);
  return (
    (isVariableDeclaration(parent) || isBindingElement(parent)) &&
    parent.initializer === at &&
    !isIdentifier(parent.name)
  );
}

/** Static object key selected by `step` (`{ pick }`, `{ pick: p }`, `{ ['pick']: p }`, `{ [0]: p }`). */
function bindingElementKey(step: BindingElement): string | undefined {
  if (step.propertyName !== undefined) {
    return keyOf(step.propertyName);
  }
  return step.name !== undefined && isIdentifier(step.name) ? step.name.text : undefined;
}

/**
 * Whether `type`, written, says a function: a function's type, `() => string`, a class's,
 * `new () => object`, or `Function`'s and its kin's (`FUNCTION_TYPES`), in a union too.
 */
function isFunctionType(type: TypeNode | undefined): boolean {
  return (
    type !== undefined &&
    (isFunctionTypeNode(type) || isConstructorTypeNode(type) || namesType(type, FUNCTION_TYPES))
  );
}
