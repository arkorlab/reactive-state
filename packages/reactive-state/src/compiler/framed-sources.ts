/** Possible source-written receivers and immutable native constructor identities. */

import {
  type Expression,
  type BinaryExpression,
  type Identifier,
  isAwaitExpression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isElementAccessExpression,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { constantValue } from './numbers.ts';

/** Native target-returning methods do not copy or replace the original target. */
const OBJECT_TARGET_METHODS: ReadonlySet<string> = new Set([
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Object.setPrototypeOf',
]);

/** A directly constructed native error is non-thenable; annotated or augmented values are unproven. */
const AWAITED_ERRORS: ReadonlySet<string> = new Set([
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

/** A constant branch condition, with only lexical whole const aliases followed. */
export function framedCondition(node: Expression): boolean | undefined {
  const condition = conditionOperand(node);
  if (condition === undefined) return undefined;
  const { value, negated } = condition;
  if (value.kind === SyntaxKind.TrueKeyword) return !negated;
  if (value.kind === SyntaxKind.FalseKeyword || value.kind === SyntaxKind.NullKeyword)
    return negated;
  const constant = constantValue(value, constantInitializer);
  return constant === undefined ? undefined : Boolean(constant) !== negated;
}

/** Const alias chains and logical negations preserve directly written branch operands. */
function conditionOperand(
  node: Expression,
): { readonly value: Expression; readonly negated: boolean } | undefined {
  const seen = new Set<Node>();
  let value = unwrapped(node);
  let negated = false;
  while (!seen.has(value)) {
    seen.add(value);
    if (isPrefixUnaryExpression(value) && value.operator === SyntaxKind.ExclamationToken) {
      negated = !negated;
      value = unwrapped(value.operand);
      continue;
    }
    const initializer = isIdentifier(value) ? constantInitializer(value) : undefined;
    if (initializer === undefined) return { value, negated };
    value = unwrapped(initializer);
  }
  return undefined;
}

/** Conditional, comma and assignment results retain their possible native receivers. */
export function framedSourceValues(node: Expression): readonly Expression[] | undefined {
  const value = unwrapped(node);
  if (isConditionalExpression(value)) {
    const condition = framedCondition(value.condition);
    if (condition === undefined) return [value.whenTrue, value.whenFalse];
    return [condition ? value.whenTrue : value.whenFalse];
  }
  if (isBinaryExpression(value)) return binaryResults(value);
  if (isAwaitExpression(value)) return nonThenableError(value.expression);
  if (!nativeObjectIdentity(value) && !nativeClone(value)) return undefined;
  const first = value.arguments?.[0];
  if (first === undefined || isSpreadElement(first)) return undefined;
  const prototype = value.arguments?.[1];
  if (prototype === undefined || isSpreadElement(prototype) || !isCallExpression(value))
    return [first];
  return globalPathOf(unwrapped(value.expression))?.join('.') === 'Object.setPrototypeOf'
    ? [first, prototype]
    : [first];
}

/** Assignment and ordinary logical results keep their original source operands. */
function binaryResults(value: BinaryExpression): readonly Expression[] | undefined {
  const logical = logicalResults(value);
  if (logical !== undefined) return logical;
  const operator = value.operatorToken.kind;
  // A skipped `&&=` left operand is falsy, so it cannot itself be a native error.
  if (
    [
      SyntaxKind.AmpersandAmpersandEqualsToken,
      SyntaxKind.CommaToken,
      SyntaxKind.EqualsToken,
    ].includes(operator)
  )
    return [value.right];
  if (
    operator === SyntaxKind.QuestionQuestionEqualsToken ||
    operator === SyntaxKind.BarBarEqualsToken
  )
    return [value.left, value.right];
  return undefined;
}

/** Ordinary logical results retain only the source-proven reachable operands. */
function logicalResults(node: BinaryExpression): readonly Expression[] | undefined {
  const { left, right } = node;
  if (node.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken)
    return [framedCondition(left) === false ? left : right];
  if (node.operatorToken.kind === SyntaxKind.BarBarToken) {
    const condition = framedCondition(left);
    if (condition === undefined) return [left, right];
    return [condition ? left : right];
  }
  return node.operatorToken.kind === SyntaxKind.QuestionQuestionToken
    ? nullishResults(left, right)
    : undefined;
}

/** A written nullish operand selects the fallback; known nonnullish values retain the left side. */
function nullishResults(left: Expression, right: Expression): readonly Expression[] {
  const operand = conditionOperand(left);
  if (operand?.negated === true) return [left];
  const value = operand?.value;
  if (value === undefined) return [left, right];
  if (
    value.kind === SyntaxKind.NullKeyword ||
    isVoidExpression(value) ||
    globalPathOf(value)?.join('.') === 'undefined'
  )
    return [right];
  if (
    constantValue(value, constantInitializer) !== undefined ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    isNewExpression(value)
  )
    return [left];
  return [left, right];
}

/** An unshadowed native clone preserves error identity and source-written error words. */
function nativeClone(node: Expression): node is Expression & {
  readonly arguments: readonly Expression[];
} {
  return (
    isCallExpression(node) &&
    globalPathOf(unwrapped(node.expression))?.join('.') === 'structuredClone'
  );
}

/** Native resolve calls preserve only a source-proven non-thenable Error fulfillment. */
function nonThenableError(node: Expression): readonly Expression[] | undefined {
  const seen = new Set<Node>();
  const promises: ReadonlySet<string> = new Set(['Promise']);
  let value = unwrapped(node);
  while (!seen.has(value)) {
    seen.add(value);
    if (
      (isNewExpression(value) || isCallExpression(value)) &&
      framedNativeConstructor(value.expression, AWAITED_ERRORS)
    )
      return [value];
    if (!isCallExpression(value)) return undefined;
    const method = unwrapped(value.expression);
    if (
      (!isPropertyAccessExpression(method) && !isElementAccessExpression(method)) ||
      frameMemberName(method) !== 'resolve' ||
      !framedNativeConstructor(method.expression, promises)
    )
      return undefined;
    const argument = value.arguments[0];
    if (argument === undefined || isSpreadElement(argument)) return undefined;
    value = unwrapped(argument);
  }
  return undefined;
}

/** Native target identity remains unchanged when every assign source is provably empty and quiet. */
function nativeObjectIdentity(node: Expression): node is Expression & {
  readonly arguments?: readonly Expression[];
} {
  if (!isCallExpression(node) && !isNewExpression(node)) return false;
  const path = globalPathOf(unwrapped(node.expression))?.join('.');
  if (path === 'Object') return true;
  return (
    isCallExpression(node) &&
    (OBJECT_TARGET_METHODS.has(path ?? '') ||
      (path === 'Object.assign' &&
        node.arguments.slice(1).every((source) => emptyAssignSource(source))))
  );
}

/** Fresh empty sources enumerate no entries, invoke no getters and perform no target writes. */
function emptyAssignSource(node: Expression): boolean {
  const value = unwrapped(node);
  if (
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.BigIntLiteral ||
    globalPathOf(value)?.join('.') === 'undefined'
  )
    return true;
  if (isObjectLiteralExpression(value)) return value.properties.length === 0;
  if (isArrayLiteralExpression(value)) return value.elements.length === 0;
  return (
    isNumericLiteral(value) ||
    ((isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) && value.text === '')
  );
}

/**
 * A native error constructor keeps its identity through immutable lexical value aliases, and
 * through a comma, whose value is its last operand's: `(0, Reflect.get)` is `Reflect.get`.
 */
export function framedNativeConstructor(node: Expression, names: ReadonlySet<string>): boolean {
  const seen = new Set<Node>();
  let value = unwrapped(node);
  while (!seen.has(value)) {
    seen.add(value);
    if (names.has(globalPathOf(value)?.join('.') ?? '')) return true;
    if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken) {
      value = unwrapped(value.right);
      continue;
    }
    if (!isIdentifier(value)) return false;
    const initializer = constantInitializer(value);
    if (initializer === undefined) return false;
    value = unwrapped(initializer);
  }
  return false;
}

/** Only a whole const declaration proves a stable primitive or constructor alias. */
function constantInitializer(name: Identifier): Expression | undefined {
  const declared = frameDeclarationOf(name);
  if (declared === undefined || !isVariableDeclaration(declared) || !isIdentifier(declared.name))
    return undefined;
  const statement = declared.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? declared.initializer
    : undefined;
}
