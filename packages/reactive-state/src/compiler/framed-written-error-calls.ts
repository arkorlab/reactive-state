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
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isTypeAssertion,
  isTypeOfExpression,
  isVoidExpression,
  type NewExpression,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PrefixUnaryExpression,
  SyntaxKind,
  type VariableDeclaration,
  type VariableStatement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { framedQuietData, framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { constantStatement } from './framed-written-error-parameters.ts';
import { nonInterceptingWrappedTarget } from './framed-written-error-wrappers.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/**
 * Side-effect guards for declarations and control-flow prefixes inside local `Error` factories so
 * sibling statements cannot mutate local message holders unobserved by parameter reachability.
 */

const ERRORS: ReadonlySet<string> = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);

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
export function sideEffectFreeExpression(root: Expression): boolean {
  const pending: Expression[] = [root];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const expr = unwrapped(current);
    if (isPureLeafExpression(expr)) continue;
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
    if (prop.objectAssignmentInitializer !== undefined) return false;
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
    pending.push(wrapped);
    return true;
  }
  if (!isIdentifier(callee) || !framedNativeConstructor(callee, ERRORS)) return false;
  const args = expr.arguments ?? [];
  return args.every((arg) => !isSpreadElement(arg) && framedQuietData(arg));
}
