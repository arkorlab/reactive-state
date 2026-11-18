import {
  type CallExpression,
  isArrowFunction,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import {
  type ResolvedValue,
  returnedTargetsOf,
  type TargetContext,
} from './statement-call-classes.ts';
import {
  type Binding,
  isCallableNode,
  resolveLexicalBinding,
  unwrapExpression,
} from './statement-call-scopes.ts';
import { staticExpressionKey } from './statement-call-writes.ts';

interface BorrowedCall {
  readonly fn: Node;
  readonly self: Node | undefined;
}

interface Resolving {
  readonly seenBindings?: Set<Binding> | undefined;
  readonly seenNodes: ReadonlySet<Node>;
}

function argumentAt(call: CallExpression, index: number): Node | undefined {
  const argument = call.arguments[index];
  return argument === undefined || isSpreadElement(argument) ? undefined : argument;
}

/**
 * The function a call runs, and the `this` it gives it, where the call is written
 * `fn.call(self, …)`, `fn.apply(self, …)` or `Reflect.apply(fn, self, …)`.
 */
function borrowedCall(
  call: CallExpression,
  ctx: TargetContext,
  seenBindings: Set<Binding> | undefined,
): BorrowedCall | undefined {
  const callee = unwrapExpression(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return undefined;
  }
  const key = isPropertyAccessExpression(callee)
    ? callee.name.text
    : staticExpressionKey(callee.argumentExpression, ctx.scopes, seenBindings);
  if (key !== 'call' && key !== 'apply') {
    return undefined;
  }
  const holder = unwrapExpression(callee.expression);
  const isReflect =
    key === 'apply' &&
    isIdentifier(holder) &&
    holder.text === 'Reflect' &&
    resolveLexicalBinding(holder, ctx.scopes) === undefined;
  const fn = isReflect ? argumentAt(call, 0) : callee.expression;
  return fn === undefined ? undefined : { fn, self: argumentAt(call, isReflect ? 1 : 0) };
}

/**
 * What a call written with `call`, `apply` or `Reflect.apply` returns: what the function it runs
 * returns, with the `this` it is given (a function that already has a receiver keeps it).
 */
export function borrowedReturnTargets(
  call: CallExpression,
  ctx: TargetContext,
  resolving: Resolving,
): readonly ResolvedValue[] {
  const borrowed = borrowedCall(call, ctx, resolving.seenBindings);
  if (borrowed === undefined) {
    return [];
  }
  const resolve = (expr: Node): readonly ResolvedValue[] =>
    ctx.resolve(expr, resolving.seenNodes, resolving.seenBindings);
  const selves = borrowed.self === undefined ? [] : resolve(borrowed.self);
  const results: ResolvedValue[] = [];
  for (const target of resolve(borrowed.fn)) {
    if (target.kind !== 'node' || !isCallableNode(target.node)) {
      continue;
    }
    const keepsReceiver =
      isArrowFunction(target.node) || target.receiver !== undefined || selves.length === 0;
    const receivers = keepsReceiver ? [target.receiver] : selves;
    for (const receiver of receivers) {
      results.push(...returnedTargetsOf(target.node, ctx, { ...resolving, receiver }));
    }
  }
  return results;
}
