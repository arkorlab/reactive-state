import {
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isDeleteExpression,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isSourceFile,
  isThrowStatement,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { literalKey } from './exported-values.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { proxyOwnKeysResultThrows } from './throw-proxy-results.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { includesApplication, interveningEvaluation } from './written-evaluation.ts';

const ARGUMENTS = { set: 3 } as const;
const OPERATIONS: ReadonlyMap<string, { readonly trap: string; readonly count: number }> = new Map([
  ['Object.entries', { trap: 'ownKeys', count: 1 }],
  ['Object.keys', { trap: 'ownKeys', count: 1 }],
  ['Object.values', { trap: 'ownKeys', count: 1 }],
  ['Reflect.deleteProperty', { trap: 'deleteProperty', count: 2 }],
  ['Reflect.has', { trap: 'has', count: 2 }],
  ['Reflect.ownKeys', { trap: 'ownKeys', count: 1 }],
  ['Reflect.set', { trap: 'set', count: ARGUMENTS.set }],
]);

/** The first handler trap that a quiet source-written Proxy operation necessarily consumes. */
export function proxyOperationFunction(
  node: Node,
  resolve: Resolve | undefined,
): Answering | undefined {
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const operation = operationOf(node, follow);
  if (operation === undefined || earlierExpressionEffect(node) || earlierStatementEffect(node)) {
    return undefined;
  }
  const fn = proxyTrapFunction(operation.source, operation.at, follow, {
    trap: operation.trap,
    quiet: true,
  });
  // An initial explicit throw does not rely on intrinsics that earlier trap work could repair.
  const first = fn?.body !== undefined && isBlock(fn.body) ? fn.body.statements[0] : undefined;
  return first !== undefined && isThrowStatement(first) ? fn : undefined;
}

/** An ownKeys result whose mandatory object or distinct-key shape the source disproves. */
export function proxyOperationResultThrows(node: Node, resolve: Resolve | undefined): boolean {
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const operation = operationOf(node, follow);
  if (
    operation?.trap !== 'ownKeys' ||
    !quietResultSource(operation.source, follow) ||
    earlierExpressionEffect(node) ||
    earlierStatementEffect(node, true)
  ) {
    return false;
  }
  const fn = proxyTrapFunction(operation.source, operation.at, follow, {
    trap: operation.trap,
    quiet: true,
  });
  return fn !== undefined && proxyOwnKeysResultThrows(fn);
}

/** Target creation runs before the trap; it cannot establish a stale intrinsic result proof. */
function quietResultSource(source: Expression, resolve: Resolve): boolean {
  const proxy = writtenOf(source, resolve);
  const target = isNewExpression(proxy) ? proxy.arguments?.[0] : undefined;
  return (
    target !== undefined &&
    isNewExpression(proxy) &&
    proxy.arguments?.some((each) => isSpreadElement(each)) === false &&
    !callbackCreationEffect(writtenOf(target, resolve))
  );
}

/** A native consumer with no earlier argument work capable of changing its selected trap. */
function operationOf(
  node: Node,
  resolve: Resolve,
): { readonly source: Expression; readonly at: Expression; readonly trap: string } | undefined {
  if (isCallExpression(node)) {
    return calledOperation(node, resolve);
  }
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.InKeyword) {
    return safeKey(node.left, resolve) ? { source: node.right, at: node, trap: 'has' } : undefined;
  }
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
    const target = unwrapped(node.left);
    return !callbackCreationEffect(node.right) && quietMember(target, resolve)
      ? { source: target.expression, at: node, trap: 'set' }
      : undefined;
  }
  if (isDeleteExpression(node)) {
    const target = unwrapped(node.expression);
    return quietMember(target, resolve)
      ? { source: target.expression, at: node, trap: 'deleteProperty' }
      : undefined;
  }
  return undefined;
}

/** A literal key read does not invoke application coercion before the handler is consulted. */
function quietMember(
  node: Expression,
  resolve: Resolve,
): node is Expression & { readonly expression: Expression } {
  return (
    isPropertyAccessExpression(node) ||
    (isElementAccessExpression(node) && safeKey(node.argumentExpression, resolve))
  );
}

/** The supported intrinsic's exact arguments, excluding ignored arguments with observable work. */
function calledOperation(
  node: CallExpression,
  resolve: Resolve,
): { readonly source: Expression; readonly at: Expression; readonly trap: string } | undefined {
  const operation = OPERATIONS.get(globalCalleePath(node.expression, resolve)?.join('.') ?? '');
  if (operation === undefined) {
    return undefined;
  }
  const [source, key, value] = node.arguments;
  if (
    source === undefined ||
    node.arguments.length !== operation.count ||
    (key !== undefined && !safeKey(key, resolve)) ||
    (value !== undefined && callbackCreationEffect(value))
  ) {
    return undefined;
  }
  return { source, at: node, trap: operation.trap };
}

/** Earlier statements can replace a consumer, handler or retained Proxy before this operation. */
function earlierStatementEffect(node: Node, throughFunctions = false): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return true;
    }
    if (!throughFunctions && (isAnswering(parent) || isConstructorDeclaration(parent))) {
      break;
    }
  }
  return false;
}

/** The own Proxy get trap or trap getter a property read necessarily invokes, where written. */
export function proxyReadFunction(node: Node, resolve: Resolve | undefined): Answering | undefined {
  if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) {
    return undefined;
  }
  if (isElementAccessExpression(node) && !safeKey(node.argumentExpression, resolve)) {
    return undefined;
  }
  return proxyTrapFunction(node.expression, node, resolve, { trap: 'get', quiet: false });
}

/** A fresh or unchanged literal handler's surviving own trap. */
function proxyTrapFunction(
  source: Expression,
  at: Expression,
  resolve: Resolve | undefined,
  operation: { readonly trap: string; readonly quiet: boolean },
): Answering | undefined {
  const proxy = writtenOf(source, resolve);
  if (
    !isNewExpression(proxy) ||
    globalCalleePath(proxy.expression, resolve)?.join('.') !== 'Proxy' ||
    proxy.arguments?.length !== 2 ||
    interveningEvaluation(proxy, at)
  ) {
    return undefined;
  }
  const [target, supplied] = proxy.arguments;
  if (target === undefined || supplied === undefined) {
    return undefined;
  }
  const handler = writtenOf(supplied, resolve);
  if (
    !isObjectLiteralExpression(handler) ||
    interveningEvaluation(handler, at) ||
    (operation.quiet && callbackCreationEffect(handler)) ||
    (handler !== supplied && includesApplication(target))
  ) {
    return undefined;
  }
  return ownTrap(handler, operation.trap, resolve);
}

/** A key whose evaluation and coercion cannot replace a retained handler's trap. */
function safeKey(node: Expression, resolve: Resolve | undefined): boolean {
  return (
    !includesApplication(node) &&
    (primitiveOf(writtenOf(node, resolve), resolve) !== undefined || isSymbolWritten(node, resolve))
  );
}

/** The last own trap member, with a setter preserving an earlier getter and unknown shapes deferred. */
function ownTrap(
  handler: ObjectLiteralExpression,
  name: string,
  resolve: Resolve | undefined,
): Answering | undefined {
  let accessor = false;
  let trap: Answering | undefined;
  for (const property of handler.properties) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const key = isIdentifier(property.name) ? property.name.text : literalKey(property.name);
    if (key === undefined || key === '__proto__') {
      return undefined;
    }
    if (key !== name) {
      continue;
    }
    if (isSetAccessorDeclaration(property)) {
      trap = accessor ? trap : undefined;
      accessor = true;
      continue;
    }
    accessor = isGetAccessorDeclaration(property);
    trap = trapFunction(property, resolve);
  }
  return trap;
}

/** A handler's accessor or method, or the callable its data member holds. */
function trapFunction(property: Node, resolve: Resolve | undefined): Answering | undefined {
  if (isGetAccessorDeclaration(property) || isMethodDeclaration(property)) {
    return property;
  }
  let value: Expression | undefined;
  if (isPropertyAssignment(property)) {
    value = property.initializer;
  } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    value = property.name;
  }
  const fn = value === undefined ? undefined : writtenOf(value, resolve);
  return fn !== undefined && isAnswering(fn) ? fn : undefined;
}
