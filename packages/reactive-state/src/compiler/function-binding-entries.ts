import {
  type BindingElement,
  type BindingName,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isDecorator,
  isIdentifier,
  isObjectBindingPattern,
  isParameterDeclaration,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  declaredBindingTarget,
  isFunctionType,
  isPatternStepFunctionType,
} from './function-binding-types.ts';
import { bindingElementSteps } from './function-candidate-objects.ts';
import { isGuardedNonFunction } from './function-guarded-reads.ts';
import {
  arraySlotEntryKind,
  containerDynamicEntryKind,
  containerMemberEntryKind,
  reassignedBindingEntryKind,
  selectInlineArrayElement,
} from './function-reassigned-bindings.ts';
import {
  combineBranchKinds,
  type EntryKind,
  isConstDeclaration,
  keyOf,
  type ResolvedProperty,
  resolvePropertyValue,
  type ScanContext,
  withBranch,
} from './function-table-entries.ts';
import { bindingIdentifiers } from './scope.ts';

export {
  arraySlotEntryKind,
  containerDynamicEntryKind,
  containerMemberEntryKind,
  mutableSpreadReachesFunction,
} from './function-reassigned-bindings.ts';

const MISSING_CLEAN = 'missing-clean';
const NON_FUNCTION: EntryKind = 'non-function';
const BINDING_ENTRY_KINDS = new WeakMap<Node, EntryKind>();

/** Resolves an identifier through declarations, destructuring patterns, and function parameters. */
export function identifierEntryKind(node: Identifier, context: ScanContext): EntryKind {
  const declared = frameDeclarationOf(node);
  if (declared === undefined) {
    return 'unknown';
  }
  if (isParameterDeclaration(declared) && isOutsideParameterScope(node, declared)) {
    return 'unknown';
  }
  if (isGuardedNonFunction(node, declared)) {
    return NON_FUNCTION;
  }
  const target = declaredBindingTarget(node, declared);
  const cached = BINDING_ENTRY_KINDS.get(target);
  if (cached !== undefined) {
    return cached;
  }
  if (context.seen.has(target)) {
    context.hitCycle = true;
    return 'unknown';
  }
  return withBranch(context, (branch) => {
    branch.seen.add(target);
    const kind = computeDeclaredEntryKind(node, declared, target, branch);
    if (!branch.hitCycle) {
      BINDING_ENTRY_KINDS.set(target, kind);
    }
    return kind;
  });
}

/** Computes the uncached `EntryKind` of `declared` inside `context` (with `target` already in `seen`). */
function computeDeclaredEntryKind(
  node: Identifier,
  declared: NonNullable<ReturnType<typeof frameDeclarationOf>>,
  target: Node,
  context: ScanContext,
): EntryKind {
  if (isParameterDeclaration(declared)) {
    return parameterEntryKind(node, declared, target, context);
  }
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
  const bound = bindingIdentifiers(declared.name).find((each) => each.text === node.text);
  const steps = bound === undefined ? [] : bindingElementSteps(bound);
  const resolved =
    bound === undefined ? 'unknown' : evaluateBindingSteps(source, steps, 0, context);
  if (constant) {
    return resolved === 'unknown' && isPatternStepFunctionType(declared.type, steps, 0)
      ? 'renamed'
      : resolved;
  }
  if (
    degradeMutableKind(resolved) === 'renamed' ||
    isPatternStepFunctionType(declared.type, steps, 0)
  ) {
    return 'renamed';
  }
  return reassignedBindingEntryKind(declaredBindingTarget(node, declared), context);
}

/** Preserves `'entry'` and `NON_FUNCTION` across `const` aliases while checking mutable types/writes. */
function simpleVariableEntryKind(
  declared: VariableDeclaration,
  constant: boolean,
  context: ScanContext,
): EntryKind {
  const fromInit =
    declared.initializer === undefined
      ? 'unknown'
      : context.classifyExpression(unwrapped(declared.initializer), context);
  if (constant) {
    return fromInit === 'unknown' && isFunctionType(declared.type) ? 'renamed' : fromInit;
  }
  if (degradeMutableKind(fromInit) === 'renamed' || isFunctionType(declared.type)) {
    return 'renamed';
  }
  return reassignedBindingEntryKind(declared.name, context);
}

/** Classifies simple or destructured parameter bindings, combining caller input with defaults. */
function parameterEntryKind(
  node: Identifier,
  parameter: ParameterDeclaration,
  target: Node,
  context: ScanContext,
): EntryKind {
  const fromDeclaration = isIdentifier(parameter.name)
    ? simpleParameterEntryKind(parameter, context)
    : destructuredParameterEntryKind(node, parameter, context);
  return fromDeclaration === 'renamed' ? 'renamed' : reassignedBindingEntryKind(target, context);
}

/** Classifies a simple identifier parameter binding from its annotation and default initializer. */
function simpleParameterEntryKind(
  parameter: ParameterDeclaration,
  context: ScanContext,
): EntryKind {
  const callerKind: EntryKind = isFunctionType(parameter.type) ? 'renamed' : 'unknown';
  const { initializer } = parameter;
  if (initializer === undefined) {
    return callerKind;
  }
  const defaultKind = withBranch(context, (branch) =>
    branch.classifyExpression(unwrapped(initializer), branch),
  );
  return degradeMutableKind(combineBranchKinds(callerKind, defaultKind));
}

/** Classifies a destructured parameter binding from caller input, annotations, and defaults. */
function destructuredParameterEntryKind(
  node: Identifier,
  parameter: ParameterDeclaration,
  context: ScanContext,
): EntryKind {
  const bound = bindingIdentifiers(parameter.name).find((each) => each.text === node.text);
  const steps = bound === undefined ? [] : bindingElementSteps(bound);
  if (isPatternStepFunctionType(parameter.type, steps, 0)) {
    return 'renamed';
  }
  const callerKind = withBranch(context, (branch) =>
    patternEntryKind(node.text, parameter.name, { kind: 'unknown' }, branch),
  );
  if (parameter.initializer === undefined) {
    return degradeMutableKind(callerKind);
  }
  const defaultSource: ResolvedProperty = { kind: 'expr', value: unwrapped(parameter.initializer) };
  const defaultKind = withBranch(context, (branch) =>
    patternEntryKind(node.text, parameter.name, defaultSource, branch),
  );
  return degradeMutableKind(combineBranchKinds(callerKind, defaultKind));
}

/** Degrades `'entry'` to `'renamed'` and `NON_FUNCTION` to `'unknown'` on mutable/caller bindings. */
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
    : evaluateBindingSteps(source, bindingElementSteps(bound), 0, context);
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
    return selected.kind === MISSING_CLEAN
      ? 'unknown'
      : evaluateBindingSteps(selected, steps, index + 1, context);
  }
  const defaultBranch = withBranch(context, (branch) =>
    evaluateBindingSteps({ kind: 'expr', value: unwrapped(initializer) }, steps, index + 1, branch),
  );
  if (
    selected.kind === MISSING_CLEAN ||
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
  if (source.kind === MISSING_CLEAN) {
    return NON_FUNCTION;
  }
  if (source.kind === 'unknown') {
    return 'unknown';
  }
  if (isObjectBindingPattern(step.parent)) {
    const key = bindingElementKey(step);
    return key === undefined
      ? containerDynamicEntryKind(source.value, context)
      : containerMemberEntryKind(source.value, key, context);
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

/** Static object key selected by `step` (`{ pick }`, `{ pick: p }`, `{ ['pick']: p }`, `{ [0]: p }`). */
function bindingElementKey(step: BindingElement): string | undefined {
  if (step.propertyName !== undefined) {
    return keyOf(step.propertyName);
  }
  return step.name !== undefined && isIdentifier(step.name) ? step.name.text : undefined;
}
