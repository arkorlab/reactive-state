import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isElementAccessExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { isWholeArgumentsReference, type WrapperBindings } from './render-raw-wrapper-bindings.ts';

/** Unpacks direct, `.call`, `.apply`, and `Reflect.apply` invocations to the method, receiver and arguments they run. */

export type CallArgumentList =
  | { readonly kind: 'elements'; readonly elements: readonly Expression[] }
  | { readonly kind: 'whole-arguments' }
  | { readonly kind: 'spread-list'; readonly list: Expression };

export interface UnwrappedCall {
  readonly target: Expression;
  readonly receiver: Expression | undefined;
  readonly args: CallArgumentList;
}

export const KIND_ELEMENTS = 'elements' as const;
export const KIND_SPREAD = 'spread-list' as const;
export const KIND_WHOLE_ARGS = 'whole-arguments' as const;

export function unpackCallExpression(
  call: CallExpression,
  bindings: WrapperBindings,
): UnwrappedCall | undefined {
  const callee = unwrapped(call.expression);
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    return unpackReflectApplyCall(call, bindings);
  }
  if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) {
    return unpackMemberCall(call, callee, bindings);
  }
  return {
    args: { elements: call.arguments, kind: KIND_ELEMENTS },
    receiver: undefined,
    target: callee,
  };
}

function unpackReflectApplyCall(
  call: CallExpression,
  bindings: WrapperBindings,
): UnwrappedCall | undefined {
  const [target, recv, list] = call.arguments;
  if (target === undefined || isSpreadElement(target)) return undefined;
  const args = unpackAppliedList(list, bindings);
  if (args === undefined) return undefined;
  return { args, receiver: optionalReceiver(recv), target };
}

function unpackMemberCall(
  call: CallExpression,
  callee: Expression & { readonly expression: Expression },
  bindings: WrapperBindings,
): UnwrappedCall | undefined {
  const member = frameMemberName(callee);
  if (member === 'apply') {
    const [recv, list] = call.arguments;
    const args = unpackAppliedList(list, bindings);
    return args === undefined
      ? undefined
      : { args, receiver: optionalReceiver(recv), target: callee.expression };
  }
  if (member === 'call') {
    const [recv, ...rest] = call.arguments;
    return {
      args: { elements: rest, kind: KIND_ELEMENTS },
      receiver: optionalReceiver(recv),
      target: callee.expression,
    };
  }
  return {
    args: { elements: call.arguments, kind: KIND_ELEMENTS },
    receiver: callee.expression,
    target: callee,
  };
}

function optionalReceiver(recv: Expression | undefined): Expression | undefined {
  return recv === undefined || isSpreadElement(recv) ? undefined : recv;
}

function unpackAppliedList(
  list: Expression | undefined,
  bindings: WrapperBindings,
): CallArgumentList | undefined {
  if (list === undefined) return { elements: [], kind: KIND_ELEMENTS };
  if (isSpreadElement(list)) return undefined;
  const actual = unwrapped(list);
  if (isArrayLiteralExpression(actual)) {
    return {
      elements: actual.elements.filter((el) => !isOmittedExpression(el)),
      kind: KIND_ELEMENTS,
    };
  }
  if (isWholeArgumentsReference(actual, bindings)) return { kind: KIND_WHOLE_ARGS };
  return { kind: KIND_SPREAD, list: actual };
}
