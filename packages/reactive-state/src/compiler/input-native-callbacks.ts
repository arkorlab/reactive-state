import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAwaitExpression,
  isBlock,
  isExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isReturnStatement,
  isSpreadElement,
  isThrowStatement,
  isVoidExpression,
  type Node,
  type NewExpression,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { declarationOf, parameterOf } from './framed.ts';
import { metadataParameters } from './input-bindings.ts';
import { metadataCallee, metadataInitializer } from './input-callees.ts';
import { targetsOf } from './kept.ts';
import { constantValue } from './numbers.ts';
import { interveningEvaluation } from './written-evaluation.ts';
import { writtenBy } from './written.ts';

/** The immediate work of Promise executors, JSON revivers and reflected constructions. */

const JSON_PARSE = 'JSON.parse';
const PROMISE = 'Promise';
const PRIMITIVES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.TrueKeyword,
]);

/** The callback roots that execute synchronously, without resuming a generator or an async suffix. */
export function nativeCallbackRoots(
  fn: Answering,
  path: string | undefined,
  first: Expression | undefined,
): Node[] | undefined {
  if (path !== PROMISE && path !== JSON_PARSE) {
    return fn.body === undefined ? [] : [...metadataParameters(fn), fn.body];
  }
  const present = path === PROMISE || primitiveParsed(first) ? 2 : 1;
  const roots: Node[] = metadataParameters(fn).map((parameter, index) =>
    index < present ? parameter.name : parameter,
  );
  if (fn.body === undefined || generatorFunction(fn)) {
    return roots;
  }
  const body = immediateBody(fn.body);
  return body === undefined ? undefined : [...roots, ...body];
}

/** A primitive JSON root invokes its reviver once, with a defined value that selects no default. */
function primitiveParsed(node: Expression | undefined): boolean {
  const input = node === undefined ? undefined : constantValue(node, metadataInitializer);
  if (input === undefined) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(String(input));
    return parsed === null || typeof parsed !== 'object';
  } catch {
    return false;
  }
}

/** A generator call binds its parameters but does not enter its body. */
function generatorFunction(node: Node): boolean {
  return (
    (isFunctionDeclaration(node) || isFunctionExpression(node) || isMethodDeclaration(node)) &&
    node.asteriskToken !== undefined
  );
}

/** Straight-line callback work stops at a return, throw, or first standalone await. */
function immediateBody(body: Node): Node[] | undefined {
  if (!isBlock(body)) {
    return beforeAwait(body);
  }
  const roots: Node[] = [];
  for (const statement of body.statements) {
    const prefix = beforeAwait(statement);
    if (prefix === undefined) {
      return undefined;
    }
    roots.push(...prefix);
    if (hasAwait(statement) || isReturnStatement(statement) || isThrowStatement(statement)) {
      break;
    }
  }
  return roots;
}

/** A standalone await evaluates its operand before suspending; compound awaits remain unproven. */
function beforeAwait(node: Node): Node[] | undefined {
  if (!hasAwait(node)) {
    return [node];
  }
  const expression =
    isExpressionStatement(node) || isReturnStatement(node) ? node.expression : node;
  return expression !== undefined && isAwaitExpression(expression)
    ? [expression.expression]
    : undefined;
}

/** Await in another function's code does not suspend the callback being inspected. */
function hasAwait(root: Node): boolean {
  const visit = (node: Node): boolean => {
    if (isAwaitExpression(node)) {
      return true;
    }
    return (
      !isAnswering(node) && node.forEachChild((child) => (visit(child) ? true : undefined)) === true
    );
  };
  return visit(root);
}

/** Calling an unchanged executor's native reject, or resolve of a primitive, has no synchronous effects. */
export function settlesPromise(call: CallExpression, executor: Answering | undefined): boolean {
  const callee = unwrapped(call.expression);
  if (executor === undefined || !isIdentifier(callee) || declarationOf(callee) !== undefined) {
    return false;
  }
  const parameter = parameterOf(callee);
  if (parameter === undefined || parameter.dotDotDotToken !== undefined) {
    return false;
  }
  const index = metadataParameters(executor).indexOf(parameter);
  if (index === -1 || index > 1 || parameterWritten(parameter, executor)) {
    return false;
  }
  const value = call.arguments[0];
  return (
    index === 1 ||
    value === undefined ||
    isVoidExpression(unwrapped(value)) ||
    PRIMITIVES.has(unwrapped(value).kind) ||
    constantValue(value, metadataInitializer) !== undefined
  );
}

/** A rebound executor parameter no longer identifies the native settlement function. */
function parameterWritten(parameter: ParameterDeclaration, executor: Answering): boolean {
  const visit = (node: Node): boolean => {
    const written = writtenBy(node);
    if (
      written !== undefined &&
      writtenTargets(written).some(
        (target) => declarationOf(target) === undefined && parameterOf(target) === parameter,
      )
    ) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return visit(executor);
}

/** Identifier leaves targeted by a direct, parenthesized or destructuring write. */
function writtenTargets(node: Node): readonly Identifier[] {
  const current = isExpression(node) ? unwrapped(node) : node;
  if (isIdentifier(current)) {
    return [current];
  }
  const children = targetsOf(current);
  if (children.length === 1 && children[0] === current) {
    return [];
  }
  return children.flatMap((child) => writtenTargets(child));
}

/** A known malformed JSON input throws before a reviver can execute. */
export function skipsReviver(value: Expression | undefined): boolean {
  const input = value === undefined ? undefined : constantValue(value, metadataInitializer);
  if (input === undefined) {
    return false;
  }
  try {
    JSON.parse(String(input));
    return false;
  } catch {
    return true;
  }
}

/** Reflect.construct's target and literal argument list, without invoking its newTarget's body. */
export function reflectedInvocation(
  call: CallExpression | NewExpression,
  given: readonly Expression[],
): { readonly callee: Node; readonly given: readonly Expression[] } | undefined {
  const alternate = given[2] === undefined ? undefined : metadataCallee(given[2]);
  if (alternate !== undefined && nonConstructor(alternate)) {
    return { callee: alternate, given: [] };
  }
  const target = given[0] === undefined ? undefined : metadataCallee(given[0]);
  const list = given[1] === undefined ? undefined : metadataCallee(given[1]);
  if (
    target === undefined ||
    list === undefined ||
    !isArrayLiteralExpression(list) ||
    interveningEvaluation(list, call) ||
    list.elements.some(
      (entry) => isSpreadElement(entry) || entry.kind === SyntaxKind.OmittedExpression,
    )
  ) {
    return undefined;
  }
  return { callee: target, given: list.elements };
}

/** Arrows, methods, async and generator functions have no [[Construct]] body to execute. */
export function nonConstructor(node: Node): boolean {
  return (
    isArrowFunction(node) ||
    isMethodDeclaration(node) ||
    (isAnswering(node) &&
      (generatorFunction(node) ||
        node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true))
  );
}
