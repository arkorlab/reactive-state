import {
  type Expression,
  type CallExpression,
  isArrowFunction,
  isAwaitExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isIdentifier,
  isFunctionExpression,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isReturnStatement,
  isSpreadElement,
  isSpreadAssignment,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  isYieldExpression,
  type FunctionDeclaration,
  type Identifier,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { deferredArrayChange } from './framed-array-mutations.ts';
import {
  frameBindingOf,
  frameDeclarationOf,
  frameMemberName,
  type FrameBinding,
} from './framed-bindings.ts';
import { constantValue } from './numbers.ts';
import { readsBinding } from './scope.ts';

/** Source identity proofs for custom array text methods. */

/** A source-written function body, excluding references that may denote the native implementation. */
export function writtenArrayFunction(expression: Expression): boolean {
  const value = unwrapped(expression);
  return isArrowFunction(value) || isFunctionExpression(value);
}

type FunctionValue = Expression | FunctionDeclaration | MethodDeclaration;

/** Positive source proof for a directly assigned method; every possible written value must be custom. */
export function sourceArrayFunction(expression: Expression): boolean {
  return sourceFunctionValues(expression);
}

/**
 * The same proof of the method `receiver` holds at `path`, as `Reflect.get(receiver, name)` or a
 * pattern taking it apart reads it; a member read before a named receiver — `Reflect.get` itself —
 * leaves that receiver unproven.
 */
export function sourceArrayMethod(receiver: Expression, path: readonly string[]): boolean {
  const method = methodValue(receiver, true, path);
  return method !== undefined && sourceFunctionValues(method);
}

/** Whether every possible written value of `start` is a source-written function. */
function sourceFunctionValues(start: FunctionValue): boolean {
  const pending: { value: FunctionValue; seen: ReadonlySet<Node> }[] = [
    { value: start, seen: new Set() },
  ];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (at.seen.has(at.value)) return false;
    const values = sourceFunctions(at.value);
    if (values === undefined) return false;
    const seen = new Set([...at.seen, at.value]);
    for (const value of values) pending.push({ value, seen });
  }
  return true;
}

/** Each possible written function value, or no proof when one may be native or unknown. */
function sourceFunctions(value: FunctionValue): readonly FunctionValue[] | undefined {
  if (isFunctionDeclaration(value) || isMethodDeclaration(value))
    return value.body === undefined ? undefined : [];
  const expression = unwrapped(value);
  if (writtenArrayFunction(expression)) return [];
  if (isConditionalExpression(expression)) return [expression.whenTrue, expression.whenFalse];
  const next = isIdentifier(expression) ? functionValue(expression) : methodValue(expression);
  return next === undefined ? undefined : [next];
}

/** Immutable function aliases, or an unchanged named function in the nearest lexical scope. */
function functionValue(name: Identifier): FunctionValue | undefined {
  const selected = frameBindingOf(name);
  if (selected !== undefined) {
    return selected.keys.length === 0 ? constantInitializer(selected.binding) : undefined;
  }
  const declaration = frameDeclarationOf(name);
  return declaration !== undefined &&
    isFunctionDeclaration(declaration) &&
    firstReference(name, declaration)
    ? declaration
    : undefined;
}

/**
 * A method selected from an unmodified written object, preserving each literal selection step: of
 * `expression`'s member path, then of the `trailing` keys a reflective read selects past it.
 */
function methodValue(
  expression: Expression,
  checkPrior = true,
  trailing: readonly string[] = [],
): FunctionValue | undefined {
  let value: FunctionValue = unwrapped(expression);
  const keys: string[] = [...trailing];
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    keys.unshift(key);
    value = unwrapped(value.expression);
  }
  if (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (
      selected === undefined ||
      selected.keys.length > 0 ||
      (checkPrior && !firstReference(value, selected.binding))
    )
      return undefined;
    const initializer = constantInitializer(selected.binding);
    if (initializer === undefined) return undefined;
    value = unwrapped(initializer);
  }
  for (const key of keys) {
    if (!isObjectLiteralExpression(value)) return undefined;
    const selected = literalFunctionMember(value, key);
    if (selected === undefined) return undefined;
    value = selected;
  }
  return keys.length > 0 ? value : undefined;
}

/** A final own literal member; later opaque fields cannot establish the selected function's identity. */
function literalFunctionMember(
  object: ObjectLiteralExpression,
  key: string,
): FunctionValue | undefined {
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) return undefined;
    const name = writtenArrayKey(property.name);
    if (name === undefined) return undefined;
    if (name !== key) continue;
    if (isMethodDeclaration(property)) return property;
    return isPropertyAssignment(property) ? property.initializer : undefined;
  }
  return undefined;
}

/** Only const declarations retain a function alias without assuming subsequent assignments away. */
function constantInitializer(binding: FrameBinding): Expression | undefined {
  if (!isVariableDeclaration(binding) || !isVariableDeclarationList(binding.parent))
    return undefined;
  return isVariableStatement(binding.parent.parent) &&
    /^const\s/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding.initializer
    : undefined;
}

/** A mutable holder is not trusted after an earlier read or application effect could change it. */
function firstReference(
  reference: Identifier,
  binding: FrameBinding | FunctionDeclaration,
): boolean {
  const pending: Node[] = [binding.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.pos >= reference.pos || isTypeNode(node)) continue;
    if (deferredBefore(node, reference, pending)) continue;
    if (node.end <= reference.pos && isCallExpression(node) && quietWrittenCall(node)) continue;
    if (priorEffect(node, reference)) return false;
    if (priorBindingRead(node, reference, binding)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return !deferredArrayChange(reference, binding, {
    member: (value) => methodValue(value, false) !== undefined,
    quiet: quietWrittenCall,
  });
}

/** Other function bodies are deferred, but their computed method names are evaluated now. */
function deferredBefore(node: Node, reference: Identifier, pending: Node[]): boolean {
  if (!isAnswering(node) || node.end >= reference.pos) return false;
  if (
    (isMethodDeclaration(node) || isGetAccessorDeclaration(node)) &&
    isComputedPropertyName(node.name)
  )
    pending.push(node.name.expression);
  return true;
}

/** An earlier use of the same mutable binding can expose its identity before capture. */
function priorBindingRead(
  node: Node,
  reference: Identifier,
  binding: FrameBinding | FunctionDeclaration,
): boolean {
  return (
    isIdentifier(node) &&
    binding.name !== node &&
    readsBinding(node) &&
    node.text === reference.text &&
    frameDeclarationOf(node) === binding
  );
}

/** Completed earlier work can call a later-written hoisted mutator before a method is captured. */
function priorEffect(node: Node, reference: Identifier): boolean {
  if (node.end > reference.pos) return false;
  if (isComputedPropertyName(node)) return constantValue(node.expression) === undefined;
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    const { parent } = node;
    return !(
      isBinaryExpression(parent) &&
      parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      parent.left === node &&
      parent.end > reference.pos
    );
  }
  return (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isBinaryExpression(node) ||
    implicitEffect(node)
  );
}

/** Implicit calls, conversions, mutation and deferred completion also invalidate a mutable proof. */
function implicitEffect(node: Node): boolean {
  return (
    isTaggedTemplateExpression(node) ||
    isTemplateExpression(node) ||
    isSpreadAssignment(node) ||
    isSpreadElement(node) ||
    isAwaitExpression(node) ||
    isYieldExpression(node) ||
    isDeleteExpression(node) ||
    isPrefixUnaryExpression(node) ||
    isPostfixUnaryExpression(node) ||
    isClassDeclaration(node) ||
    isClassExpression(node)
  );
}

/** Repeated zero-argument calls with only a written primitive result cannot mutate a holder. */
function quietWrittenCall(call: CallExpression): boolean {
  if (call.arguments.length > 0) return false;
  const value = calledWrittenValue(unwrapped(call.expression));
  if (
    value === undefined ||
    !isAnswering(value) ||
    value.parameters.length > 0 ||
    answersLater(value)
  )
    return false;
  const { body } = value;
  if (body === undefined) return false;
  if (!isBlock(body)) return writtenPrimitive(body);
  if (body.statements.length === 0) return true;
  const [statement] = body.statements;
  return (
    body.statements.length === 1 &&
    statement !== undefined &&
    isReturnStatement(statement) &&
    (statement.expression === undefined || writtenPrimitive(statement.expression))
  );
}

/** A quiet call's direct declaration or literal member, after its preceding prefix is checked. */
function calledWrittenValue(callee: Expression): FunctionValue | undefined {
  if (!isIdentifier(callee)) return methodValue(callee, false);
  const declared = frameDeclarationOf(callee);
  if (declared === undefined) return undefined;
  if (isFunctionDeclaration(declared)) return declared;
  return isVariableDeclaration(declared) ? constantInitializer(declared) : undefined;
}

/** Literal primitive results and constant arithmetic perform no application work. */
function writtenPrimitive(expression: Expression): boolean {
  return (
    constantValue(expression) !== undefined ||
    expression.kind === SyntaxKind.TrueKeyword ||
    expression.kind === SyntaxKind.FalseKeyword ||
    expression.kind === SyntaxKind.NullKeyword
  );
}

/** An object field's literal name, with computed unknown names left unselected. */
export function writtenArrayKey(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name))
    return name.text;
  if (isNumericLiteral(name)) return String(Number(name.text));
  if (!isComputedPropertyName(name)) return undefined;
  const value = constantValue(name.expression);
  return value === undefined ? undefined : String(value);
}
