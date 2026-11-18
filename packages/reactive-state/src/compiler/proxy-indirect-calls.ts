import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type PropertyAccessExpression,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering } from './answers.ts';
import { literalName, unwrapped } from './bounded.ts';
import { metadataCallee, metadataInvocation } from './input-callees.ts';
import { type Context, sourcePath } from './proxy-values.ts';

/** A source function a call runs, with the arguments it is given: none shown when `given` is undefined. */
export interface IndirectCall {
  readonly fn: Answering;
  readonly given: readonly Expression[] | undefined;
}

/** The methods of a function that run it with the arguments the code gives them. */
const RUNNING_METHODS: ReadonlySet<string> = new Set(['apply', 'call']);

/**
 * The source function `call` runs through `.call`, `.apply`, `Reflect.apply` or a `.bind` of it,
 * with its arguments where the code shows them (`metadataInvocation`, and the bound ones before
 * the call's own). Where it shows none (a list it cannot read, a spread), the function is still
 * the one run, and what it returns is followed without the arguments.
 */
export function indirectCall(call: CallExpression, context: Context): IndirectCall | undefined {
  const invoked = metadataInvocation(call);
  if (invoked !== undefined && isAnswering(invoked.callee)) {
    return usable({ fn: invoked.callee, given: invoked.given });
  }
  const bound = boundCall(call);
  if (bound !== undefined) {
    return usable(bound);
  }
  const fn = runMethodTarget(call, context);
  return fn === undefined ? undefined : usable({ fn, given: undefined });
}

/** The call's function unless it answers later, which this follows no further. */
function usable(found: IndirectCall): IndirectCall | undefined {
  return answersLater(found.fn) ? undefined : found;
}

/** The function a call of a `.bind` result runs, with the bound arguments before the call's own. */
function boundCall(call: CallExpression): IndirectCall | undefined {
  const callee = metadataCallee(call.expression);
  if (callee === undefined || !isCallExpression(callee)) {
    return undefined;
  }
  const method = unwrapped(callee.expression);
  if (!isPropertyAccessExpression(method) || method.name.text !== 'bind') {
    return undefined;
  }
  const fn = metadataCallee(method.expression);
  if (fn === undefined || !isAnswering(fn)) {
    return undefined;
  }
  const given = [...callee.arguments.slice(1), ...call.arguments];
  return { fn, given: given.some((each) => isSpreadElement(each)) ? undefined : given };
}

/** The source function `fn.call(…)`, `fn.apply(…)` or `Reflect.apply(fn, …)` names. */
function runMethodTarget(call: CallExpression, context: Context): Answering | undefined {
  const callee = unwrapped(call.expression);
  let target: Expression | undefined;
  if (
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
    RUNNING_METHODS.has(memberName(callee) ?? '')
  ) {
    target = callee.expression;
  } else if (sourcePath(call.expression, context) === 'Reflect.apply') {
    [target] = call.arguments;
  }
  const fn = target === undefined ? undefined : metadataCallee(target);
  return fn !== undefined && isAnswering(fn) ? fn : undefined;
}

/** The name a member is read by, where the code writes it as text. */
function memberName(
  member: PropertyAccessExpression | ElementAccessExpression,
): string | undefined {
  return isPropertyAccessExpression(member) ? member.name.text : literalName(member);
}
