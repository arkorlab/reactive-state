import {
  type BindingElement,
  type Expression,
  isArrayBindingPattern,
  isArrayTypeNode,
  isCallSignatureDeclaration,
  isConstructorTypeNode,
  isConstructSignatureDeclaration,
  isFunctionTypeNode,
  isIdentifier,
  isIntersectionTypeNode,
  isNamedTupleMember,
  isOptionalTypeNode,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isPropertySignatureDeclaration,
  isRestTypeNode,
  isTupleTypeNode,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableDeclaration,
  SyntaxKind,
  type TupleTypeNode,
  type TypeNode,
} from 'typescript/ast';

import { frameDeclarationOf } from './framed-bindings.ts';
import { bindingStepKey, propertyNameText } from './function-assignment-patterns.ts';

export {
  type AssignedBindingSource,
  type AssignmentStep,
  bindingReassignments,
  declaredBindingTarget,
  normalizeAssignmentSteps,
} from './function-assignment-patterns.ts';

const ARRAY_TYPES: ReadonlySet<string> = new Set(['Array', 'ReadonlyArray']);

/** The types a binding is said to be a function of by their names: `Function`, and its kin. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'CallableFunction',
  'Function',
  'NewableFunction',
]);

/** Unwraps outer parentheses and `readonly` type operators around `type`. */
function unwrapTypeNode(type: TypeNode | undefined): TypeNode | undefined {
  let each = type;
  while (
    each !== undefined &&
    (isParenthesizedTypeNode(each) ||
      (isTypeOperatorNode(each) && each.operator === SyntaxKind.ReadonlyKeyword))
  ) {
    each = each.type;
  }
  return each;
}

/**
 * Whether `type`, written, includes a callable or constructable signature across parentheses,
 * unions, intersections, callable object type literals, and `Function` references.
 */
export function isFunctionType(type: TypeNode | undefined): boolean {
  const each = unwrapTypeNode(type);
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

/** Whether `holder` is a simple variable or parameter whose type annotates array elements as functions. */
export function holderDeclaresArrayElementFunction(
  holder: Expression,
  slotIndex?: number,
): boolean {
  if (!isIdentifier(holder)) {
    return false;
  }
  const declared = frameDeclarationOf(holder);
  if (
    declared === undefined ||
    (!isVariableDeclaration(declared) && !isParameterDeclaration(declared)) ||
    !isIdentifier(declared.name)
  ) {
    return false;
  }
  return isArrayElementFunctionType(declared.type, slotIndex);
}

/** Whether `type` annotates element `slotIndex` (or any element when omitted) with a function type. */
function isArrayElementFunctionType(type: TypeNode | undefined, slotIndex?: number): boolean {
  const each = unwrapTypeNode(type);
  if (each === undefined) {
    return false;
  }
  if (isUnionTypeNode(each) || isIntersectionTypeNode(each)) {
    return each.types.some((member) => isArrayElementFunctionType(member, slotIndex));
  }
  if (isArrayTypeNode(each)) {
    return isFunctionType(each.elementType);
  }
  if (isTupleTypeNode(each)) {
    return tupleElementIsFunctionType(each, slotIndex);
  }
  return (
    isTypeReferenceNode(each) &&
    isIdentifier(each.typeName) &&
    ARRAY_TYPES.has(each.typeName.text) &&
    isFunctionType(each.typeArguments?.[0])
  );
}

/** The array type a tuple's rest member spreads, `...T[]` or `...name: T[]`; none of a fixed member. */
function restArrayType(member: TypeNode): TypeNode | undefined {
  if (isRestTypeNode(member)) {
    return member.type;
  }
  return isNamedTupleMember(member) && member.dotDotDotToken !== undefined
    ? member.type
    : undefined;
}

/** The type a fixed tuple member supplies: `name: T` and `T?` supply `T`. */
function fixedMemberType(member: TypeNode): TypeNode {
  return isNamedTupleMember(member) || isOptionalTypeNode(member) ? member.type : member;
}

/** The element type of the array type `type`: `T` of `T[]`, `Array<T>`, `readonly T[]`. */
function arrayElementType(type: TypeNode | undefined): TypeNode | undefined {
  const each = unwrapTypeNode(type);
  if (each === undefined) {
    return undefined;
  }
  if (isArrayTypeNode(each)) {
    return each.elementType;
  }
  return isTypeReferenceNode(each) &&
    isIdentifier(each.typeName) &&
    ARRAY_TYPES.has(each.typeName.text)
    ? each.typeArguments?.[0]
    : undefined;
}

/** Checks whether `tuple` annotates `slotIndex` (or any tuple slot) with a function type. */
function tupleElementIsFunctionType(tuple: TupleTypeNode, slotIndex?: number): boolean {
  if (
    slotIndex !== undefined &&
    slotIndex >= 0 &&
    tuple.elements.slice(0, slotIndex + 1).every((member) => restArrayType(member) === undefined)
  ) {
    const selected = tuple.elements[slotIndex];
    return selected !== undefined && isFunctionType(fixedMemberType(selected));
  }
  return tuple.elements.some((member) => {
    const rest = restArrayType(member);
    return rest === undefined
      ? isFunctionType(fixedMemberType(member))
      : isArrayElementFunctionType(rest) || isFunctionType(rest);
  });
}

/** The type a tuple supplies at `slot`: its member there, or the element of a rest member before it. */
function tupleSlotType(tuple: TupleTypeNode, slot: number): TypeNode | undefined {
  for (const [at, member] of tuple.elements.entries()) {
    const rest = restArrayType(member);
    if (rest !== undefined) {
      return arrayElementType(rest);
    }
    if (at === slot) {
      return fixedMemberType(member);
    }
  }
  return undefined;
}

/** Whether `type` annotates the nested destructuring path `steps` with a function type. */
export function isPatternStepFunctionType(
  type: TypeNode | undefined,
  steps: readonly BindingElement[],
  index: number,
): boolean {
  const each = unwrapTypeNode(type);
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
  if (isArrayBindingPattern(step.parent)) {
    return isArrayPatternStepFunctionType(each, step, steps, index);
  }
  if (!isTypeLiteralNode(each) || step.dotDotDotToken !== undefined) {
    return false;
  }
  const key = bindingStepKey(step);
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

/** Advances `isPatternStepFunctionType` across a single `ArrayBindingPattern` element `step`. */
function isArrayPatternStepFunctionType(
  each: TypeNode,
  step: BindingElement,
  steps: readonly BindingElement[],
  index: number,
): boolean {
  if (step.dotDotDotToken !== undefined) {
    return index + 1 < steps.length && isPatternStepFunctionType(each, steps, index + 1);
  }
  if (isArrayTypeNode(each)) {
    return isPatternStepFunctionType(each.elementType, steps, index + 1);
  }
  if (
    isTypeReferenceNode(each) &&
    isIdentifier(each.typeName) &&
    ARRAY_TYPES.has(each.typeName.text)
  ) {
    return isPatternStepFunctionType(each.typeArguments?.[0], steps, index + 1);
  }
  if (!isTupleTypeNode(each) || !isArrayBindingPattern(step.parent)) {
    return false;
  }
  return isPatternStepFunctionType(
    tupleSlotType(each, step.parent.elements.indexOf(step)),
    steps,
    index + 1,
  );
}
