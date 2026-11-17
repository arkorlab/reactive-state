import {
  type ArrayLiteralExpression,
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConditionalExpression,
  isConstructorDeclaration,
  isDecorator,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isRegularExpressionLiteral,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isTypeAssertion,
  isTypeOfExpression,
  isVoidExpression,
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PrefixUnaryExpression,
  SyntaxKind,
  type VariableDeclaration,
  type VariableStatement,
} from 'typescript/ast';

import { type Answering, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedFactoryCall } from './framed-factory-calls.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietData, framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { constantStatement, suppliedQuietParameter } from './framed-written-error-parameters.ts';
import { nonInterceptingWrappedTarget } from './framed-written-error-wrappers.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { isTypeOnly } from './scope.ts';

/**
 * Borrowed factory call normalization, `this`-receiver inspection, and side-effect guards for
 * written `Error` factory proofs.
 */

const ERRORS: ReadonlySet<string> = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);

const CALL_SLOTS = {
  applyArguments: 2,
  reflectArguments: 3,
} as const;

const FACTORY_THIS = new WeakMap<Answering, boolean>();

const LITERAL_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.TrueKeyword,
]);

const NON_COERCING_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.QuestionQuestionToken,
]);

export interface WrittenFactoryInvocation {
  readonly extra: readonly Expression[];
  readonly fn: Answering;
  readonly given: readonly Expression[];
  readonly receiver: Expression | undefined;
}

/** Resolves a local factory call while retaining its receiver and complete argument list. */
export function framedWrittenFactoryCall(
  call: CallExpression,
  factory: (callee: Expression) => Answering | undefined,
): WrittenFactoryInvocation | undefined {
  const base = framedFactoryCall(call, factory, frameDeclarationOf);
  if (base === undefined || base.given === null) return undefined;
  const callee = unwrapped(call.expression);
  if (isCallExpression(callee)) return fullBoundInvocation(call, callee, base.fn);
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    return fullReflectInvocation(call, base.fn, base.given);
  }
  if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) {
    const method = frameMemberName(callee);
    if ((method === 'call' || method === 'apply') && factory(callee.expression) !== undefined) {
      return fullMethodInvocation(call, method, base.fn, base.given);
    }
  }
  return { extra: [], fn: base.fn, given: call.arguments, receiver: undefined };
}

function fullBoundInvocation(
  call: CallExpression,
  bound: CallExpression,
  fn: Answering,
): WrittenFactoryInvocation | undefined {
  const prefix = framedArgumentPrefix(bound, bound.arguments, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  return {
    extra: [],
    fn,
    given: [...prefix.values.slice(1), ...call.arguments],
    receiver: prefix.values[0],
  };
}

function fullReflectInvocation(
  call: CallExpression,
  fn: Answering,
  given: readonly Expression[],
): WrittenFactoryInvocation | undefined {
  if (!sideEffectFreeExpression(call.expression)) return undefined;
  const prefix = framedArgumentPrefix(call, call.arguments, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  return {
    extra: prefix.values.slice(CALL_SLOTS.reflectArguments),
    fn,
    given,
    receiver: prefix.values[1],
  };
}

function fullMethodInvocation(
  call: CallExpression,
  method: 'apply' | 'call',
  fn: Answering,
  given: readonly Expression[],
): WrittenFactoryInvocation | undefined {
  const prefix = framedArgumentPrefix(call, call.arguments, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  if (method === 'call') {
    return { extra: [], fn, given: prefix.values.slice(1), receiver: prefix.values[0] };
  }
  return {
    extra: prefix.values.slice(CALL_SLOTS.applyArguments),
    fn,
    given,
    receiver: prefix.values[0],
  };
}

/** Whether `fn` reads `this` or `super` in its own or an enclosing lexical receiver scope. */
export function factoryMentionsThis(fn: Answering): boolean {
  const cached = FACTORY_THIS.get(fn);
  if (cached !== undefined) return cached;
  const result = computeFactoryMentionsThis(fn);
  FACTORY_THIS.set(fn, result);
  return result;
}

function computeFactoryMentionsThis(fn: Answering): boolean {
  if (fn.body === undefined) return false;
  const pending: Node[] = [...parametersOf(fn), fn.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (node !== fn && bindsOwnThis(node)) {
      pushOuterThisHeader(node, pending);
      continue;
    }
    if (node.kind === SyntaxKind.ThisKeyword || node.kind === SyntaxKind.SuperKeyword) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

function bindsOwnThis(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isClassStaticBlockDeclaration(node)
  );
}

function pushOuterThisHeader(node: Node, pending: Node[]): void {
  if (
    (isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node) ||
      isPropertyDeclaration(node)) &&
    isComputedPropertyName(node.name)
  ) {
    pending.push(node.name.expression);
  }
  if (
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node)
  ) {
    pushDecorators(node.modifiers, pending);
    for (const parameter of node.parameters) pushDecorators(parameter.modifiers, pending);
    return;
  }
  if (isPropertyDeclaration(node)) {
    pushDecorators(node.modifiers, pending);
  }
}

function pushDecorators(modifiers: readonly Node[] | undefined, pending: Node[]): void {
  if (modifiers === undefined) return;
  for (const modifier of modifiers) {
    if (isDecorator(modifier)) pending.push(modifier.expression);
  }
}

/** Rejects factory parameter patterns or active defaults that could run side effects. */
export function sideEffectFreeFactoryParameters(
  fn: Answering,
  given: readonly Expression[],
): boolean {
  return parametersOf(fn).every((param, index) => {
    if (suppliedQuietParameter(param, given, index)) return true;
    return (
      isIdentifier(param.name) &&
      (param.initializer === undefined || sideEffectFreeExpression(param.initializer))
    );
  });
}

/** Requires a `const` statement to bind plain identifiers to side-effect-free initializers. */
export function sideEffectFreeVariableStatement(statement: VariableStatement): boolean {
  if (!constantStatement(statement)) return false;
  return statement.declarationList.declarations.every((decl) => sideEffectFreeDeclaration(decl));
}

function sideEffectFreeDeclaration(declaration: VariableDeclaration): boolean {
  return (
    isIdentifier(declaration.name) &&
    declaration.initializer !== undefined &&
    sideEffectFreeExpression(declaration.initializer)
  );
}

/** Rejects calls, assignments, destructuring hooks, spreads, and coercing operators. */
export function sideEffectFreeExpression(root: Expression, exempt?: Expression): boolean {
  const target = exempt === undefined ? undefined : unwrapped(exempt);
  const visited = new Set<Expression>();
  const pending: Expression[] = [root];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const expr = unwrapped(current);
    if (Object.is(expr, target) || visited.has(expr) || isPureLeafExpression(expr)) continue;
    visited.add(expr);
    if (!queueCompositeOperands(expr, pending)) return false;
  }
  return true;
}

function isPureLeafExpression(expr: Expression): boolean {
  return (
    isIdentifier(expr) ||
    isStringLiteral(expr) ||
    isNumericLiteral(expr) ||
    isBigIntLiteral(expr) ||
    isNoSubstitutionTemplateLiteral(expr) ||
    isRegularExpressionLiteral(expr) ||
    LITERAL_KEYWORDS.has(expr.kind) ||
    isArrowFunction(expr) ||
    isFunctionExpression(expr)
  );
}

function queueCompositeOperands(expr: Expression, pending: Expression[]): boolean {
  if (isTypeAssertion(expr) || isVoidExpression(expr) || isTypeOfExpression(expr)) {
    pending.push(expr.expression);
    return true;
  }
  if (isPrefixUnaryExpression(expr)) return queuePrefixOperand(expr, pending);
  if (isBinaryExpression(expr)) return queueBinaryOperands(expr, pending);
  if (isConditionalExpression(expr)) {
    pending.push(expr.condition, expr.whenTrue, expr.whenFalse);
    return true;
  }
  if (isPropertyAccessExpression(expr)) {
    pending.push(expr.expression);
    return true;
  }
  if (isElementAccessExpression(expr)) {
    if (!framedQuietPrimitive(expr.argumentExpression)) return false;
    pending.push(expr.expression);
    return true;
  }
  if (isArrayLiteralExpression(expr)) return queueArrayElements(expr, pending);
  if (isObjectLiteralExpression(expr)) return queueObjectProperties(expr, pending);
  if (isCallExpression(expr) || isNewExpression(expr)) return queuePureInvocation(expr, pending);
  return false;
}

function queuePrefixOperand(expr: PrefixUnaryExpression, pending: Expression[]): boolean {
  if (expr.operator === SyntaxKind.ExclamationToken) {
    pending.push(expr.operand);
    return true;
  }
  if (expr.operator === SyntaxKind.PlusToken || expr.operator === SyntaxKind.MinusToken) {
    const inner = unwrapped(expr.operand);
    return isNumericLiteral(inner) || isBigIntLiteral(inner);
  }
  return false;
}

function queueBinaryOperands(expr: BinaryExpression, pending: Expression[]): boolean {
  if (!NON_COERCING_OPERATORS.has(expr.operatorToken.kind)) return false;
  pending.push(expr.left, expr.right);
  return true;
}

function queueArrayElements(expr: ArrayLiteralExpression, pending: Expression[]): boolean {
  for (const element of expr.elements) {
    if (isOmittedExpression(element)) continue;
    if (isSpreadElement(element)) return false;
    pending.push(element);
  }
  return true;
}

function queueObjectProperties(expr: ObjectLiteralExpression, pending: Expression[]): boolean {
  for (const prop of expr.properties) {
    if (!queueObjectElement(prop, pending)) return false;
  }
  return true;
}

function queueObjectElement(prop: ObjectLiteralElementLike, pending: Expression[]): boolean {
  if (isShorthandPropertyAssignment(prop)) {
    if (prop.objectAssignmentInitializer !== undefined || !isIdentifier(prop.name)) return false;
    pending.push(prop.name);
    return true;
  }
  if (!isPropertyAssignment(prop)) return false;
  if (isComputedPropertyName(prop.name) && !framedQuietPrimitive(prop.name.expression)) {
    return false;
  }
  pending.push(prop.initializer);
  return true;
}

function queuePureInvocation(expr: CallExpression | NewExpression, pending: Expression[]): boolean {
  const callee = unwrapped(expr.expression);
  if (
    isCallExpression(expr) &&
    isIdentifier(callee) &&
    globalPathOf(expr.expression)?.join('.') === 'Boolean' &&
    expr.arguments.length === 1
  ) {
    const first = expr.arguments[0];
    if (first === undefined || isSpreadElement(first)) return false;
    pending.push(first);
    return true;
  }
  const wrapped = nonInterceptingWrappedTarget(expr);
  if (wrapped !== undefined && !isBinaryExpression(callee)) {
    return queueInvocationParts(expr, wrapped, pending);
  }
  if (
    isCallExpression(expr) &&
    globalPathOf(callee)?.join('.') === 'Proxy.revocable' &&
    expr.arguments.length === 2
  ) {
    return queuePlainArguments(expr.arguments, pending);
  }
  if (!isIdentifier(callee) || !framedNativeConstructor(callee, ERRORS)) return false;
  const args = expr.arguments ?? [];
  return args.every((arg) => !isSpreadElement(arg) && framedQuietData(arg));
}

function queueInvocationParts(
  expr: CallExpression | NewExpression,
  wrapped: Expression,
  pending: Expression[],
): boolean {
  const args = expr.arguments ?? [];
  if (!queuePlainArguments(args, pending)) return false;
  pending.push(expr.expression);
  const inner = unwrapped(wrapped);
  if (args.every((arg) => !Object.is(unwrapped(arg), inner))) pending.push(wrapped);
  return true;
}

function queuePlainArguments(args: readonly Expression[], pending: Expression[]): boolean {
  for (const arg of args) {
    if (isSpreadElement(arg)) return false;
    pending.push(arg);
  }
  return true;
}
