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

/** Candidate value or container projection assigned to a mutable variable binding. */
export type AssignedBindingSource =
  | { readonly holder: Expression; readonly index: number; readonly kind: 'element' }
  | { readonly holder: Expression; readonly key: string; readonly kind: 'member' }
  | { readonly kind: 'expr'; readonly value: Expression };

type ReassignmentMap = Map<Node, AssignedBindingSource[]>;

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
  const visit = (node: Node): void => {
    if (isSkippedSyntax(node)) {
      return;
    }
    if (isBinaryExpression(node) && VALUE_ASSIGNING.has(node.operatorToken.kind)) {
      const rhs: AssignedBindingSource = { kind: 'expr', value: unwrapped(node.right) };
      recordAssignedTarget(unwrapTarget(node.left), rhs, map);
    }
    node.forEachChild(visit);
  };
  visit(file);
  REASSIGNMENTS.set(file, map);
  return map;
}

/** Records direct, object-destructured, or array-destructured assignment targets into `map`. */
function recordAssignedTarget(
  target: Node,
  source: AssignedBindingSource,
  map: ReassignmentMap,
): void {
  if (isIdentifier(target)) {
    const declared = frameDeclarationOf(target);
    if (declared !== undefined && isVariableDeclaration(declared)) {
      appendSource(map, declaredBindingTarget(target, declared), source);
    }
    return;
  }
  if (source.kind !== 'expr') {
    return;
  }
  if (isObjectLiteralExpression(target)) {
    recordObjectAssignmentPattern(target, source.value, map);
    return;
  }
  if (
    isArrayLiteralExpression(target) &&
    target.elements.every((element) => !isSpreadElement(element))
  ) {
    recordArrayAssignmentPattern(target, source.value, map);
  }
}

/** Records property selections and assignment defaults on `({ pick = fn } = holder)`. */
function recordObjectAssignmentPattern(
  pattern: Expression & { readonly properties: readonly Node[] },
  holder: Expression,
  map: ReassignmentMap,
): void {
  if (!isObjectLiteralExpression(pattern)) {
    return;
  }
  for (const prop of pattern.properties) {
    if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) {
      recordAssignedTarget(prop.name, { holder, key: prop.name.text, kind: 'member' }, map);
      if (prop.objectAssignmentInitializer !== undefined) {
        const fallback = unwrapped(prop.objectAssignmentInitializer);
        recordAssignedTarget(prop.name, { kind: 'expr', value: fallback }, map);
      }
    } else if (isPropertyAssignment(prop)) {
      const key = propertyNameText(prop.name);
      const inner = unwrapDefaultedTarget(prop.initializer, map);
      if (key !== undefined) {
        recordAssignedTarget(inner, { holder, key, kind: 'member' }, map);
      }
    }
  }
}

/** Records indexed selections and assignment defaults on `([pick = fn] = items)`. */
function recordArrayAssignmentPattern(
  pattern: Expression,
  holder: Expression,
  map: ReassignmentMap,
): void {
  if (!isArrayLiteralExpression(pattern)) {
    return;
  }
  for (const [index, element] of pattern.elements.entries()) {
    if (!isOmittedExpression(element)) {
      const inner = unwrapDefaultedTarget(element, map);
      recordAssignedTarget(inner, { holder, index, kind: 'element' }, map);
    }
  }
}

/** Records `= fallback` inside a destructuring assignment target and returns the inner target. */
function unwrapDefaultedTarget(node: Expression, map: ReassignmentMap): Node {
  const target = unwrapTarget(node);
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
    const inner = unwrapTarget(target.left);
    recordAssignedTarget(inner, { kind: 'expr', value: unwrapped(target.right) }, map);
    return inner;
  }
  return target;
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
