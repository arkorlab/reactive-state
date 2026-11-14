import {
  type Expression,
  type CallExpression,
  isArrayBindingPattern,
  isArrowFunction,
  isAwaitExpression,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isFunctionExpression,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSpreadElement,
  isSpreadAssignment,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  isYieldExpression,
  type FunctionDeclaration,
  type Identifier,
  type MethodDeclaration,
  type Node,
  type ObjectBindingPattern,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { ownerKeyFirst } from './class-key-order.ts';
import { useOf } from './code-globals.ts';
import { destructuredFirst, patternAfter } from './destructuring-order.ts';
import { deferredArrayChange } from './framed-array-mutations.ts';
import {
  frameBindingOf,
  frameDeclarationOf,
  frameMemberName,
  type FrameBinding,
} from './framed-bindings.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

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

/** A value being proved: the values it may be written as, and how many of them are proved. */
interface Proving {
  readonly value: FunctionValue;
  readonly next: readonly FunctionValue[];
  proved: number;
}

/**
 * Whether every possible written value of `start` is a source-written function. Each value is
 * proved once, however many ways reach it, so aliases that converge cost no more than a chain; a
 * value reached while it is being proved is a cycle, and gives no proof.
 */
function sourceFunctionValues(start: FunctionValue): boolean {
  const proving = new Set<FunctionValue>();
  const proved = new Set<FunctionValue>();
  const stack: Proving[] = [];
  const enter = (value: FunctionValue): boolean => {
    if (proved.has(value)) return true;
    if (proving.has(value)) return false;
    const next = sourceFunctions(value);
    if (next === undefined) return false;
    proving.add(value);
    stack.push({ value, next, proved: 0 });
    return true;
  };
  if (!enter(start)) return false;
  for (let each = stack.at(-1); each !== undefined; each = stack.at(-1)) {
    const value = each.next[each.proved];
    if (value === undefined) {
      stack.pop();
      proving.delete(each.value);
      proved.add(each.value);
    } else {
      each.proved += 1;
      if (!enter(value)) return false;
    }
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

/**
 * Whether `property`, a name or text and not a computed one, is `__proto__: value`, which sets the
 * object's prototype and defines no member of it: the scan goes past it, to an own member of that
 * name an entry before it defines.
 */
function setsPrototype(property: PropertyAssignment): boolean {
  return (
    property.name.kind !== SyntaxKind.ComputedPropertyName &&
    writtenArrayKey(property.name) === '__proto__'
  );
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
    if (!isPropertyAssignment(property)) return undefined;
    if (setsPrototype(property)) continue;
    return property.initializer;
  }
  return undefined;
}

/**
 * Only const declarations retain a function alias, or an array, without assuming subsequent
 * assignments away.
 */
export function constantInitializer(binding: FrameBinding): Expression | undefined {
  if (!isVariableDeclaration(binding) || !isVariableDeclarationList(binding.parent))
    return undefined;
  return isVariableStatement(binding.parent.parent) &&
    /^const\s/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding.initializer
    : undefined;
}

/**
 * A mutable holder is not trusted after an earlier read or application effect could change it, nor,
 * where a loop reads it again, after the rest of the loop could (`deferredArrayChange`).
 */
function firstReference(
  reference: Identifier,
  binding: FrameBinding | FunctionDeclaration,
): boolean {
  const pending: Node[] = [binding.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node) || runsAfter(node, reference)) continue;
    if (deferredBefore(node, reference, pending)) continue;
    const rest = quietCallRest(node, reference);
    if (rest !== undefined) {
      pending.push(...rest);
      continue;
    }
    if (priorEffect(node, reference)) return false;
    if (priorBindingRead(node, reference, binding)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return !deferredArrayChange(reference, binding, {
    member: quietMember,
    quiet: quietWrittenCall,
  });
}

/**
 * Whether `node` has run where `reference` is read: it is written before it, or lies in what a
 * pattern around the reference destructures, which runs first, before the pattern's defaults and
 * computed keys, though it is written after them.
 */
function completed(node: Node, reference: Identifier): boolean {
  return (
    node.end <= reference.pos ||
    destructuredFirst(node, reference) ||
    ownerKeyFirst(node, reference)
  );
}

/** Whether `node` is written after `reference` and runs after it too. */
function runsAfter(node: Node, reference: Identifier): boolean {
  return (
    node.pos >= reference.pos &&
    !destructuredFirst(node, reference) &&
    !ownerKeyFirst(node, reference)
  );
}

/**
 * What a completed quiet call leaves to read: its invoked body is quiet, but a callee that selects
 * the method from an object literal written in place evaluates that literal's other members first.
 * `undefined` where the call is not a quiet one.
 */
function quietCallRest(node: Node, reference: Identifier): readonly Node[] | undefined {
  if (!completed(node, reference) || !isCallExpression(node) || !quietWrittenCall(node))
    return undefined;
  let root = unwrapped(node.expression);
  while (isPropertyAccessExpression(root) || isElementAccessExpression(root))
    root = unwrapped(root.expression);
  return isObjectLiteralExpression(root) ? [root] : [];
}

/**
 * A member read of the holder that hands nothing of it away: a function, or a value that is no
 * object the holder's literal holds. Such an object read as a value, passed on or kept under a
 * name, is the holder's own, and what receives it can replace the method it holds; a pattern that
 * takes it apart only reads its members (`bindsNoHolder`).
 */
function quietMember(value: Expression): boolean {
  const selected = methodValue(value, false);
  if (selected === undefined) return false;
  if (isFunctionDeclaration(selected) || isMethodDeclaration(selected)) return true;
  const member = unwrapped(selected);
  return !isObjectLiteralExpression(member) || takenApart(value, member);
}

/** Whether `value` is what an object pattern of a declaration takes apart, keeping no `holder`. */
function takenApart(value: Expression, holder: ObjectLiteralExpression): boolean {
  const { at, parent } = useOf(value);
  return (
    isExpression(at) &&
    isVariableDeclaration(parent) &&
    parent.initializer === at &&
    isObjectBindingPattern(parent.name) &&
    bindsNoHolder(parent.name, holder)
  );
}

/**
 * Whether each element of `pattern` binds a member of `holder` that is no object literal, or one
 * that a pattern takes apart in turn: a name for the object itself, a rest, a key that is not
 * written or a member that is no literal one keeps it, or may.
 */
function bindsNoHolder(pattern: ObjectBindingPattern, holder: ObjectLiteralExpression): boolean {
  return pattern.elements.every((element) => {
    const key = element.dotDotDotToken === undefined ? frameMemberName(element) : undefined;
    const selected = key === undefined ? undefined : literalFunctionMember(holder, key);
    if (selected === undefined) return false;
    if (isFunctionDeclaration(selected) || isMethodDeclaration(selected)) return true;
    const member = unwrapped(selected);
    if (!isObjectLiteralExpression(member)) return true;
    return (
      element.name !== undefined &&
      isObjectBindingPattern(element.name) &&
      bindsNoHolder(element.name, member)
    );
  });
}

/**
 * Other function bodies, a setter's too, are deferred, but their computed names are evaluated now:
 * the name itself is walked, for a key that is no written constant converts an object where the
 * class is defined.
 */
function deferredBefore(node: Node, reference: Identifier, pending: Node[]): boolean {
  if (!(isAnswering(node) || isSetAccessorDeclaration(node)) || !completed(node, reference))
    return false;
  if (
    (isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)) &&
    isComputedPropertyName(node.name)
  )
    pending.push(node.name);
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

/**
 * Completed earlier work can call a later-written hoisted mutator before a method is captured. So
 * does a pattern that takes a value apart, which runs the getters and the iterator it reads before
 * its defaults, and so before a reference in them — but not one whose own source holds the
 * reference, which it takes apart after, a pattern inside it too.
 */
function priorEffect(node: Node, reference: Identifier): boolean {
  if (isObjectBindingPattern(node) || isArrayBindingPattern(node))
    return !patternAfter(outermostPattern(node), reference);
  if (!completed(node, reference)) return false;
  if (isComputedPropertyName(node)) return constantValue(node.expression) === undefined;
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    const { parent } = node;
    return (
      !isBinaryExpression(parent) ||
      parent.operatorToken.kind !== SyntaxKind.EqualsToken ||
      parent.left !== node ||
      completed(parent, reference)
    );
  }
  return (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isBinaryExpression(node) ||
    implicitEffect(node)
  );
}

/** The outermost pattern `pattern` is part of: an element of a pattern holds a pattern of its own. */
function outermostPattern(pattern: Node): Node {
  let at = pattern;
  while (isBindingElement(at.parent)) at = at.parent.parent;
  return at;
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
