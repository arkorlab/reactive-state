import {
  type ArrayLiteralExpression,
  type BindingElement,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
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
import { frameDeclarationOf } from './framed-bindings.ts';
import { declaredBindingTarget } from './function-binding-types.ts';
import { staticElementKey } from './function-this-writes.ts';
import { bindingIdentifiers } from './scope.ts';

/** Mutable cycle marker threaded through candidate-object lookups when caching subtrees. */
export interface CandidateCycleState {
  hitCycle: boolean;
  readonly seen: Set<Node>;
}

/** Per-binding index of post-declaration expression writes (`x = rhs`). */
export type VariableWriteMap = ReadonlyMap<Node, readonly Expression[]>;

/** Logical operators that can forward either operand as a spread source or callable value. */
export const LOGICAL_FORWARDING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

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
  return keyOfPropertyName(property.name);
}

/** Static string, template, or numeric key expression. */
export function staticArgumentKey(node: Expression): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return isNumericLiteral(node) ? String(Number(node.text)) : undefined;
}

/** Resolves `ObjectLiteralExpression`s reachable from `node` across aliases, members, and patterns. */
export function candidateObjects(
  node: Expression,
  variableWrites: VariableWriteMap,
  seen: Set<Node>,
  cycle?: CandidateCycleState,
): readonly ObjectLiteralExpression[] {
  const state: CandidateCycleState = cycle ?? { hitCycle: false, seen };
  return candidateObjectsWithCycle(node, variableWrites, state);
}

/** Cycle-tracking worker resolving `ObjectLiteralExpression`s reachable from `node`. */
function candidateObjectsWithCycle(
  node: Expression,
  variableWrites: VariableWriteMap,
  state: CandidateCycleState,
): readonly ObjectLiteralExpression[] {
  if (isObjectLiteralExpression(node)) {
    return [node];
  }
  if (isConditionalExpression(node)) {
    return [
      ...candidateObjectsWithCycle(unwrapped(node.whenTrue), variableWrites, state),
      ...candidateObjectsWithCycle(unwrapped(node.whenFalse), variableWrites, state),
    ];
  }
  if (isBinaryExpression(node) && LOGICAL_FORWARDING.has(node.operatorToken.kind)) {
    return [
      ...candidateObjectsWithCycle(unwrapped(node.left), variableWrites, state),
      ...candidateObjectsWithCycle(unwrapped(node.right), variableWrites, state),
    ];
  }
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    const key = isPropertyAccessExpression(node) ? node.name.text : staticElementKey(node);
    const holders = candidateObjectsWithCycle(unwrapped(node.expression), variableWrites, state);
    return selectMemberObjectsWithCycle(holders, key, variableWrites, state);
  }
  return isIdentifier(node) ? identifierCandidateObjects(node, variableWrites, state) : [];
}

/** Resolves candidate object literals bound to `node` via simple or destructured declarations. */
function identifierCandidateObjects(
  node: Identifier,
  variableWrites: VariableWriteMap,
  state: CandidateCycleState,
): readonly ObjectLiteralExpression[] {
  const declared = frameDeclarationOf(node);
  if (declared === undefined || !isVariableDeclaration(declared)) {
    return [];
  }
  const target = declaredBindingTarget(node, declared);
  if (state.seen.has(target)) {
    state.hitCycle = true;
    return [];
  }
  state.seen.add(target);
  const objects = isIdentifier(declared.name)
    ? simpleDeclarationObjects(declared, variableWrites, state)
    : [...patternDeclarationObjects(node, declared, variableWrites, state)];
  if (!isConstVariable(declared)) {
    const writes = variableWrites.get(target);
    if (writes !== undefined) {
      for (const assigned of writes) {
        objects.push(...candidateObjectsWithCycle(assigned, variableWrites, state));
      }
    }
  }
  return objects;
}

/** Resolves candidate object literals from a direct `const x = ...` / `let x = ...` initializer. */
function simpleDeclarationObjects(
  declared: VariableDeclaration,
  variableWrites: VariableWriteMap,
  state: CandidateCycleState,
): ObjectLiteralExpression[] {
  return declared.initializer === undefined
    ? []
    : [...candidateObjectsWithCycle(unwrapped(declared.initializer), variableWrites, state)];
}

/** Steps through destructuring elements on `declared` to resolve inner object literals for `node`. */
function patternDeclarationObjects(
  node: Identifier,
  declared: VariableDeclaration,
  variableWrites: VariableWriteMap,
  state: CandidateCycleState,
): readonly ObjectLiteralExpression[] {
  const bound = bindingIdentifiers(declared.name).find((each) => each.text === node.text);
  if (bound === undefined) {
    return [];
  }
  let expressions: Expression[] =
    declared.initializer === undefined ? [] : [unwrapped(declared.initializer)];
  for (const step of bindingElementSteps(bound)) {
    if (step.dotDotDotToken !== undefined) {
      return [];
    }
    expressions = advancePatternExpressions(expressions, step, variableWrites, state);
  }
  return expressions.flatMap((expr) => candidateObjectsWithCycle(expr, variableWrites, state));
}

/** Projects candidate container `expressions` across a single destructuring `step` and its default. */
function advancePatternExpressions(
  expressions: readonly Expression[],
  step: BindingElement,
  variableWrites: VariableWriteMap,
  state: CandidateCycleState,
): Expression[] {
  const next: Expression[] = [];
  if (isObjectBindingPattern(step.parent)) {
    const key = bindingStepKey(step);
    for (const expr of expressions) {
      const holders = candidateObjectsWithCycle(expr, variableWrites, state);
      next.push(...memberValueExpressions(holders, key, variableWrites, state));
    }
  } else if (isArrayBindingPattern(step.parent)) {
    const index = step.parent.elements.indexOf(step);
    for (const expr of expressions) {
      const element = selectArrayElementExpression(expr, index, state);
      if (element !== undefined) {
        next.push(element);
      }
    }
  }
  if (step.initializer !== undefined) {
    next.push(unwrapped(step.initializer));
  }
  return next;
}

/** Resolves object literals stored under property `key` (or any data property if dynamic) on `holders`. */
export function selectMemberObjects(
  holders: readonly ObjectLiteralExpression[],
  key: string | undefined,
  variableWrites: VariableWriteMap,
  seen: Set<Node>,
): readonly ObjectLiteralExpression[] {
  return selectMemberObjectsWithCycle(holders, key, variableWrites, { hitCycle: false, seen });
}

/** Cycle-aware worker selecting member object literals on `holders`. */
function selectMemberObjectsWithCycle(
  holders: readonly ObjectLiteralExpression[],
  key: string | undefined,
  variableWrites: VariableWriteMap,
  state: CandidateCycleState,
): readonly ObjectLiteralExpression[] {
  return memberValueExpressions(holders, key, variableWrites, state).flatMap((value) =>
    candidateObjectsWithCycle(value, variableWrites, state),
  );
}

/** Collects value expressions contributed by `key` across `holders` and their spread sources. */
function memberValueExpressions(
  holders: readonly ObjectLiteralExpression[],
  key: string | undefined,
  variableWrites: VariableWriteMap,
  state: CandidateCycleState,
): readonly Expression[] {
  const values: Expression[] = [];
  for (const holder of holders) {
    if (state.seen.has(holder)) {
      state.hitCycle = true;
    } else {
      const branch: CandidateCycleState = {
        hitCycle: false,
        seen: new Set([...state.seen, holder]),
      };
      const memberValues = collectObjectMemberValues(holder, key, variableWrites, branch);
      if (branch.hitCycle) {
        state.hitCycle = true;
      }
      for (const item of memberValues) {
        values.push(item);
      }
    }
  }
  return values;
}

/** Collects matching property and spread expressions inside a single `holder` object literal. */
function collectObjectMemberValues(
  holder: ObjectLiteralExpression,
  key: string | undefined,
  variableWrites: VariableWriteMap,
  state: CandidateCycleState,
): readonly Expression[] {
  const found: Expression[] = [];
  for (const prop of holder.properties) {
    if (isSpreadAssignment(prop)) {
      const spreadHolders = candidateObjectsWithCycle(
        unwrapped(prop.expression),
        variableWrites,
        state,
      );
      found.push(...memberValueExpressions(spreadHolders, key, variableWrites, state));
    } else {
      const propKey = literalElementKey(prop);
      const value = propertyAssignmentExpression(prop);
      if (value !== undefined && (key === undefined || propKey === undefined || propKey === key)) {
        found.push(value);
      }
    }
  }
  return found;
}

/** Extracts the value expression of a `PropertyAssignment` or `ShorthandPropertyAssignment`. */
function propertyAssignmentExpression(property: ObjectLiteralElementLike): Expression | undefined {
  if (isPropertyAssignment(property)) {
    return unwrapped(property.initializer);
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}

/** Selects element `index` of a resolved `ArrayLiteralExpression` without prior spreads. */
function selectArrayElementExpression(
  holder: Expression,
  index: number,
  state: CandidateCycleState,
): Expression | undefined {
  const array = resolveSimpleArrayLiteral(holder, state);
  if (
    array === undefined ||
    index < 0 ||
    array.elements.slice(0, index + 1).some((each) => isSpreadElement(each))
  ) {
    return undefined;
  }
  const element = array.elements[index];
  return element === undefined || isOmittedExpression(element) ? undefined : unwrapped(element);
}

/** Follows simple `const` identifier initializers to an `ArrayLiteralExpression`. */
function resolveSimpleArrayLiteral(
  holder: Expression,
  state: CandidateCycleState,
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

/** Static object key selected by `step`. */
function bindingStepKey(step: BindingElement): string | undefined {
  if (step.propertyName !== undefined) {
    return keyOfPropertyName(step.propertyName);
  }
  return step.name !== undefined && isIdentifier(step.name) ? step.name.text : undefined;
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
