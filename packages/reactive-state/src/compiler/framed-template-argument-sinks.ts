import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isElementAccessExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
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
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering, overloadsOf, parametersOf } from './answers.ts';
import { globalOf, literalName } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import {
  constantDeclaration,
  isAssignmentOperator,
  queueBranchExpressions,
  type SpreadUnfold,
  unfoldApplyOperand,
  unfoldSpreadExpression,
} from './framed-template-argument-spreads.ts';
import { peeled } from './framed-written-targets.ts';

export { constantDeclaration } from './framed-template-argument-spreads.ts';

/**
 * Value and container-mutation sink extraction for `arguments` taint analysis, resolving local
 * holder bindings inside literal and branched receiver roots and flagging unresolvable sinks.
 */

const PRIMITIVE_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.TrueKeyword,
]);

const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'add',
  'copyWithin',
  'fill',
  'push',
  'reverse',
  'set',
  'sort',
  'splice',
  'unshift',
]);

const OBJECT_MUTATORS: ReadonlySet<string> = new Set([
  'assign',
  'defineProperties',
  'defineProperty',
]);

const REFLECT_MUTATORS: ReadonlySet<string> = new Set(['defineProperty', 'set']);

export interface NodeSinks {
  readonly mutated: readonly FrameDeclaration[];
  readonly unresolvable: boolean;
  readonly value: readonly FrameDeclaration[];
}

const NO_SINKS: NodeSinks = { mutated: [], unresolvable: false, value: [] };

/** `const` bindings initialized to a primitive literal cannot hold mutable container properties. */
export function immutablePrimitiveConst(decl: FrameDeclaration): boolean {
  if (
    !isVariableDeclaration(decl) ||
    !constantDeclaration(decl) ||
    decl.initializer === undefined
  ) {
    return false;
  }
  return isPrimitiveExpression(peeled(decl.initializer));
}

/** Parameters of any inline callable reachable as the value of a variable initializer. */
export function callableParametersInInitializer(expr: Expression): readonly FrameDeclaration[] {
  const found: FrameDeclaration[] = [];
  const pending: Expression[] = [expr];
  const visited = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = peeled(next);
    if (visited.has(current)) continue;
    visited.add(current);
    if (isAnswering(current)) {
      found.push(...parametersOf(current));
      continue;
    }
    queueBranchExpressions(current, pending);
  }
  return found;
}

/** Extracts value and container-mutation sinks introduced at `node` within `owner`. */
export function sinksForNode(node: Node, owner: Node): NodeSinks {
  if (isVariableDeclaration(node) || isParameterDeclaration(node)) {
    return { mutated: [], unresolvable: false, value: [node] };
  }
  if (node !== owner && (isFunctionDeclaration(node) || isClassDeclaration(node))) {
    return { mutated: [], unresolvable: false, value: [node] };
  }
  if (isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return assignmentTargetSinks(node.left);
  }
  if (isForOfStatement(node) || isForInStatement(node)) {
    return loopTargetSinks(node.initializer);
  }
  if (isCallExpression(node) || isNewExpression(node)) {
    return callTargetSinks(node, owner);
  }
  return NO_SINKS;
}

function loopTargetSinks(initializer: Node): NodeSinks {
  if (isVariableDeclarationList(initializer)) {
    return { mutated: [], unresolvable: false, value: initializer.declarations };
  }
  return assignmentTargetSinks(initializer);
}

function assignmentTargetSinks(lhs: Node): NodeSinks {
  const mutated: FrameDeclaration[] = [];
  const value: FrameDeclaration[] = [];
  let unresolvable = false;
  const pending: Node[] = [lhs];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const target = isExpression(current) ? peeled(current) : current;
    if (isIdentifier(target)) {
      const decl = frameDeclarationOf(target);
      if (decl === undefined) unresolvable = true;
      else value.push(decl);
      continue;
    }
    if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      if (!collectReceiverHolders(target.expression, mutated)) unresolvable = true;
      continue;
    }
    queueAssignmentPatternChildren(target, pending);
  }
  return { mutated, unresolvable, value };
}

function queueAssignmentPatternChildren(target: Node, pending: Node[]): void {
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
    pending.push(target.left);
    return;
  }
  if (isSpreadElement(target) || isSpreadAssignment(target)) {
    pending.push(target.expression);
    return;
  }
  if (isPropertyAssignment(target)) {
    pending.push(target.initializer);
    return;
  }
  if (isShorthandPropertyAssignment(target)) {
    pending.push(target.name);
    return;
  }
  if (isArrayLiteralExpression(target)) {
    for (const element of target.elements) pending.push(element);
    return;
  }
  if (isObjectLiteralExpression(target)) {
    for (const prop of target.properties) pending.push(prop);
  }
}

function callTargetSinks(call: CallExpression | NewExpression, owner: Node): NodeSinks {
  const mutated: FrameDeclaration[] = [];
  const value: FrameDeclaration[] = [];
  const callee = peeled(call.expression);
  const argsUnfold = unfoldCallArguments(call.arguments, owner);
  let unresolvable = collectCalleeSinks(callee, mutated, value) || !argsUnfold.resolved;
  const applyOperand = applyArgumentsOperand(call, callee, argsUnfold.elements);
  if (applyOperand !== undefined) {
    const applied = unfoldApplyOperand(applyOperand, owner);
    if (!applied.resolved) unresolvable = true;
    collectArgumentListSinks(applied.elements, mutated, value);
  }
  collectArgumentListSinks(argsUnfold.elements, mutated, value);
  const mutatedTarget = knownMutatedTargetArgument(call, callee, argsUnfold.elements);
  if (mutatedTarget !== undefined && !collectReceiverHolders(mutatedTarget, mutated)) {
    unresolvable = true;
  }
  return { mutated, unresolvable, value };
}

function unfoldCallArguments(args: readonly Expression[] | undefined, owner: Node): SpreadUnfold {
  if (args === undefined) return { elements: [], resolved: true };
  const elements: Expression[] = [];
  let resolved = true;
  for (const arg of args) {
    if (!isSpreadElement(arg)) {
      elements.push(arg);
      continue;
    }
    const spread = unfoldSpreadExpression(arg.expression, owner);
    if (!spread.resolved) resolved = false;
    elements.push(...spread.elements);
  }
  return { elements, resolved };
}

function collectArgumentListSinks(
  items: readonly Expression[],
  mutated: FrameDeclaration[],
  value: FrameDeclaration[],
): void {
  for (const item of items) collectArgumentExpressionSinks(item, mutated, value);
}

function collectCalleeSinks(
  callee: Expression,
  mutated: FrameDeclaration[],
  value: FrameDeclaration[],
): boolean {
  let unresolvable = false;
  if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) {
    const exhaustive = collectReceiverHolders(callee.expression, mutated);
    if (!exhaustive && isDirectMutatingMethod(callee)) unresolvable = true;
  }
  collectCalleeParameters(callee, value);
  return unresolvable;
}

function collectCalleeParameters(callee: Expression, value: FrameDeclaration[]): void {
  const pending: Expression[] = [callee];
  const visited = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = peeled(next);
    if (visited.has(current)) continue;
    visited.add(current);
    if (isAnswering(current)) {
      value.push(...parametersOf(current));
      continue;
    }
    if (isIdentifier(current)) {
      pushLocalCallableParameters(current, value);
      continue;
    }
    if (queueBranchExpressions(current, pending)) continue;
    queueCalleeContainerTarget(current, pending);
  }
}

function queueCalleeContainerTarget(current: Expression, pending: Expression[]): void {
  if (!isPropertyAccessExpression(current) && !isElementAccessExpression(current)) return;
  const method = memberNameOf(current);
  const target = peeled(current.expression);
  if (
    method === 'apply' ||
    method === 'bind' ||
    method === 'call' ||
    isArrayLiteralExpression(target) ||
    isObjectLiteralExpression(target)
  ) {
    pending.push(target);
  }
}

function collectArgumentExpressionSinks(
  expr: Expression,
  mutated: FrameDeclaration[],
  value: FrameDeclaration[],
): void {
  const pending: Expression[] = [expr];
  const visited = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = peeled(next);
    if (visited.has(current)) continue;
    visited.add(current);
    if (isAnswering(current)) {
      value.push(...parametersOf(current));
      continue;
    }
    if (isIdentifier(current)) {
      pushLocalCallableParameters(current, value);
      pushMutableIdentifier(current, mutated);
      continue;
    }
    if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
      pending.push(current.expression);
      continue;
    }
    if (queueBranchExpressions(current, pending)) continue;
    queueLiteralContainerValues(current, pending);
  }
}

function queueLiteralContainerValues(current: Expression, pending: Expression[]): void {
  if (isArrayLiteralExpression(current)) {
    queueArrayElements(current.elements, pending);
    return;
  }
  if (!isObjectLiteralExpression(current)) return;
  for (const prop of current.properties) queueObjectPropertyValue(prop, pending);
}

function queueArrayElements(elements: readonly Expression[], pending: Expression[]): void {
  for (const el of elements) {
    if (!isOmittedExpression(el)) pending.push(isSpreadElement(el) ? el.expression : el);
  }
}

function queueObjectPropertyValue(prop: ObjectLiteralElementLike, pending: Expression[]): void {
  if (isPropertyAssignment(prop)) pending.push(prop.initializer);
  else if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) pending.push(prop.name);
  else if (isSpreadAssignment(prop)) pending.push(prop.expression);
}

function collectReceiverHolders(expr: Expression, mutated: FrameDeclaration[]): boolean {
  const pending: Expression[] = [expr];
  const visited = new Set<Expression>();
  let exhaustive = true;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = peeled(next);
    if (visited.has(current)) continue;
    visited.add(current);
    if (!stepReceiverHolder(current, pending, mutated)) exhaustive = false;
  }
  return exhaustive;
}

function stepReceiverHolder(
  current: Expression,
  pending: Expression[],
  mutated: FrameDeclaration[],
): boolean {
  if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    pending.push(current.expression);
    return true;
  }
  if (isPrimitiveExpression(current)) return true;
  if (isIdentifier(current)) return recordReceiverIdentifier(current, mutated);
  if (queueBranchExpressions(current, pending)) return true;
  if (isArrayLiteralExpression(current)) {
    queueArrayElements(current.elements, pending);
    return true;
  }
  if (isObjectLiteralExpression(current)) {
    return queueObjectReceiverProperties(current.properties, pending);
  }
  return false;
}

function recordReceiverIdentifier(id: Identifier, mutated: FrameDeclaration[]): boolean {
  const decl = frameDeclarationOf(id);
  if (decl === undefined) return false;
  if (!immutablePrimitiveConst(decl)) mutated.push(decl);
  return true;
}

function queueObjectReceiverProperties(
  properties: readonly ObjectLiteralElementLike[],
  pending: Expression[],
): boolean {
  let plain = true;
  for (const prop of properties) {
    if (isPropertyAssignment(prop)) {
      pending.push(prop.initializer);
    } else if (isShorthandPropertyAssignment(prop)) {
      if (isIdentifier(prop.name)) pending.push(prop.name);
      if (prop.objectAssignmentInitializer !== undefined) {
        pending.push(prop.objectAssignmentInitializer);
      }
    } else if (isSpreadAssignment(prop)) {
      pending.push(prop.expression);
    } else {
      plain = false;
    }
  }
  return plain;
}

function applyArgumentsOperand(
  call: CallExpression | NewExpression,
  callee: Expression,
  unfoldedArgs: readonly Expression[],
): Expression | undefined {
  if (
    !isCallExpression(call) ||
    (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee))
  ) {
    return undefined;
  }
  const method = memberNameOf(callee);
  const receiverGlobal = globalOf(peeled(callee.expression));
  if (receiverGlobal === 'Reflect') {
    if (method === 'apply') return unfoldedArgs[2];
    if (method === 'construct') return unfoldedArgs[1];
    return undefined;
  }
  return method === 'apply' ? unfoldedArgs[1] : undefined;
}

function knownMutatedTargetArgument(
  call: CallExpression | NewExpression,
  callee: Expression,
  unfoldedArgs: readonly Expression[],
): Expression | undefined {
  if (
    !isCallExpression(call) ||
    (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee))
  ) {
    return undefined;
  }
  const method = memberNameOf(callee);
  if (method === undefined) return undefined;
  const receiver = peeled(callee.expression);
  if (isStaticMutator(receiver, method)) return unfoldedArgs[0];
  if (method !== 'call' && method !== 'apply') return undefined;
  if (!isPropertyAccessExpression(receiver) && !isElementAccessExpression(receiver)) {
    return undefined;
  }
  const innerMethod = memberNameOf(receiver);
  if (innerMethod === undefined) return undefined;
  if (method === 'call' && isStaticMutator(peeled(receiver.expression), innerMethod)) {
    return unfoldedArgs[1];
  }
  return MUTATING_METHODS.has(innerMethod) ? unfoldedArgs[0] : undefined;
}

function isDirectMutatingMethod(callee: Expression): boolean {
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
  const method = memberNameOf(callee);
  return (
    method !== undefined &&
    MUTATING_METHODS.has(method) &&
    globalOf(peeled(callee.expression)) === undefined
  );
}

function isStaticMutator(receiver: Expression, method: string): boolean {
  const globalName = globalOf(receiver);
  return (
    (globalName === 'Object' && OBJECT_MUTATORS.has(method)) ||
    (globalName === 'Reflect' && REFLECT_MUTATORS.has(method))
  );
}

function memberNameOf(expr: Expression): string | undefined {
  if (isPropertyAccessExpression(expr)) return expr.name.text;
  if (isElementAccessExpression(expr)) return literalName(expr);
  return undefined;
}

function pushMutableIdentifier(id: Identifier, found: FrameDeclaration[]): void {
  const decl = frameDeclarationOf(id);
  if (decl !== undefined && !immutablePrimitiveConst(decl)) found.push(decl);
}

function pushLocalCallableParameters(callee: Identifier, found: FrameDeclaration[]): void {
  const decl = frameDeclarationOf(callee);
  if (decl === undefined) return;
  if (isFunctionDeclaration(decl)) {
    for (const each of overloadsOf(decl)) {
      if (each.body !== undefined) found.push(...parametersOf(each));
    }
    return;
  }
  if (
    !isVariableDeclaration(decl) ||
    !constantDeclaration(decl) ||
    decl.initializer === undefined
  ) {
    return;
  }
  found.push(...callableParametersInInitializer(decl.initializer));
}

function isPrimitiveExpression(expr: Expression): boolean {
  return (
    isStringLiteral(expr) ||
    isNumericLiteral(expr) ||
    isBigIntLiteral(expr) ||
    isNoSubstitutionTemplateLiteral(expr) ||
    PRIMITIVE_KEYWORDS.has(expr.kind) ||
    (isIdentifier(expr) && expr.text === 'undefined' && frameDeclarationOf(expr) === undefined)
  );
}
