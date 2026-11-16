import {
  type BindingElement,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallSignatureDeclaration,
  isComputedPropertyName,
  isConstructorTypeNode,
  isConstructSignatureDeclaration,
  isFunctionTypeNode,
  isIdentifier,
  isIntersectionTypeNode,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableDeclaration,
  type Node,
  type PropertyName,
  type SourceFile,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { isSkippedSyntax, unwrapTarget, VALUE_ASSIGNING } from './function-this-writes.ts';
import { bindingIdentifiers } from './scope.ts';

/** Single container projection step inside a destructuring assignment pattern. */
export type AssignmentStep =
  | { readonly index: number; readonly kind: 'element' }
  | { readonly kind: 'dynamic-element'; readonly startIndex: number }
  | { readonly kind: 'dynamic-member' }
  | { readonly key: string; readonly kind: 'member' };

/** Candidate root expression and selection path assigned to a mutable binding. */
export interface AssignedBindingSource {
  readonly root: Expression;
  readonly steps: readonly AssignmentStep[];
}

type ReassignmentMap = Map<Node, AssignedBindingSource[]>;

interface AssignmentScanState {
  readonly handledDefaults: Set<Node>;
  readonly map: ReassignmentMap;
}

/** The types a binding is said to be a function of by their names: `Function`, and its kin. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'CallableFunction',
  'Function',
  'NewableFunction',
]);

const REASSIGNMENTS = new WeakMap<
  SourceFile,
  ReadonlyMap<Node, readonly AssignedBindingSource[]>
>();

/**
 * Whether `type`, written, includes a callable or constructable signature across parentheses,
 * unions, intersections, callable object type literals, and `Function` references.
 */
export function isFunctionType(type: TypeNode | undefined): boolean {
  let each = type;
  while (each !== undefined && isParenthesizedTypeNode(each)) {
    each = each.type;
  }
  if (each === undefined) {
    return false;
  }
  if (isUnionTypeNode(each) || isIntersectionTypeNode(each)) {
    return each.types.some((member) => isFunctionType(member));
  }
  if (isFunctionTypeNode(each) || isConstructorTypeNode(each)) {
    return true;
  }
  if (isTypeLiteralNode(each)) {
    return each.members.some(
      (member) => isCallSignatureDeclaration(member) || isConstructSignatureDeclaration(member),
    );
  }
  return (
    isTypeReferenceNode(each) &&
    isIdentifier(each.typeName) &&
    FUNCTION_TYPES.has(each.typeName.text)
  );
}

/** Whether `type` annotates the nested property path `steps` with a function type. */
export function isPatternStepFunctionType(
  type: TypeNode | undefined,
  steps: readonly BindingElement[],
  index: number,
): boolean {
  let each = type;
  while (each !== undefined && isParenthesizedTypeNode(each)) {
    each = each.type;
  }
  if (each === undefined) {
    return false;
  }
  if (isUnionTypeNode(each) || isIntersectionTypeNode(each)) {
    return each.types.some((member) => isPatternStepFunctionType(member, steps, index));
  }
  const step = steps[index];
  if (step === undefined) {
    return isFunctionType(each);
  }
  if (!isTypeLiteralNode(each) || step.dotDotDotToken !== undefined) {
    return false;
  }
  const key = stepPropertyKey(step);
  if (key === undefined) {
    return false;
  }
  return each.members.some((member) => {
    return (
      isPropertySignatureDeclaration(member) &&
      propertyNameText(member.name) === key &&
      isPatternStepFunctionType(member.type, steps, index + 1)
    );
  });
}

/** Resolves the specific declaring `Identifier` node within `declared` for `node`. */
export function declaredBindingTarget(node: Identifier, declared: FrameDeclaration): Node {
  if (isVariableDeclaration(declared) || isParameterDeclaration(declared)) {
    return bindingIdentifiers(declared.name).find((each) => each.text === node.text) ?? declared;
  }
  return declared;
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
    recordArrayAssignmentPattern(target, source, 0, state);
  }
}

/** Records property selections and assignment defaults on `({ nested: { pick = fn } } = holder)`. */
function recordObjectAssignmentPattern(
  pattern: Expression,
  source: AssignedBindingSource,
  state: AssignmentScanState,
): void {
  if (!isObjectLiteralExpression(pattern)) {
    return;
  }
  for (const prop of pattern.properties) {
    if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) {
      const nextStep: AssignmentStep = { key: prop.name.text, kind: 'member' };
      recordAssignedTarget(
        prop.name,
        { root: source.root, steps: [...source.steps, nextStep] },
        state,
      );
      if (prop.objectAssignmentInitializer !== undefined) {
        const fallback = unwrapped(prop.objectAssignmentInitializer);
        recordAssignedTarget(prop.name, { root: fallback, steps: [] }, state);
      }
    } else if (isPropertyAssignment(prop)) {
      const inner = unwrapDefaultedTarget(prop.initializer, state);
      const key = propertyNameText(prop.name);
      const nextStep: AssignmentStep =
        key === undefined ? { kind: 'dynamic-member' } : { key, kind: 'member' };
      recordAssignedTarget(inner, { root: source.root, steps: [...source.steps, nextStep] }, state);
    }
  }
}

/** Records indexed selections, rest patterns, and assignment defaults on `([pick = fn] = items)`. */
function recordArrayAssignmentPattern(
  pattern: Expression,
  source: AssignedBindingSource,
  offset: number,
  state: AssignmentScanState,
): void {
  if (!isArrayLiteralExpression(pattern)) {
    return;
  }
  for (const [index, element] of pattern.elements.entries()) {
    const slot = offset + index;
    if (isSpreadElement(element)) {
      const restInner = unwrapDefaultedTarget(element.expression, state);
      recordArrayRestTarget(restInner, source, slot, state);
    } else if (!isOmittedExpression(element)) {
      const inner = unwrapDefaultedTarget(element, state);
      const nextStep: AssignmentStep = { index: slot, kind: 'element' };
      recordAssignedTarget(inner, { root: source.root, steps: [...source.steps, nextStep] }, state);
    }
  }
}

/** Records nested array or object patterns bound inside an array rest target (`[a, ...[pick]]`). */
function recordArrayRestTarget(
  inner: Node,
  source: AssignedBindingSource,
  slot: number,
  state: AssignmentScanState,
): void {
  if (isArrayLiteralExpression(inner)) {
    recordArrayAssignmentPattern(inner, source, slot, state);
    return;
  }
  if (!isObjectLiteralExpression(inner)) {
    return;
  }
  for (const prop of inner.properties) {
    if (isPropertyAssignment(prop)) {
      const subTarget = unwrapDefaultedTarget(prop.initializer, state);
      const key = propertyNameText(prop.name);
      const nextStep: AssignmentStep =
        key !== undefined && /^\d+$/u.test(key)
          ? { index: slot + Number(key), kind: 'element' }
          : { kind: 'dynamic-element', startIndex: slot };
      recordAssignedTarget(
        subTarget,
        { root: source.root, steps: [...source.steps, nextStep] },
        state,
      );
    } else if (
      isShorthandPropertyAssignment(prop) &&
      isIdentifier(prop.name) &&
      prop.objectAssignmentInitializer !== undefined
    ) {
      const fallback = unwrapped(prop.objectAssignmentInitializer);
      recordAssignedTarget(prop.name, { root: fallback, steps: [] }, state);
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

/** Static key selected by `step` inside an object binding pattern. */
function stepPropertyKey(step: BindingElement): string | undefined {
  if (step.propertyName !== undefined) {
    return propertyNameText(step.propertyName);
  }
  return step.name !== undefined && isIdentifier(step.name) ? step.name.text : undefined;
}

/** Static string, template, identifier, or numeric property name. */
function propertyNameText(name: PropertyName): string | undefined {
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
