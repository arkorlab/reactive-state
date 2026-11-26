import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isPropertyAccessExpression,
  isElementAccessExpression,
  isIdentifier,
  isOmittedExpression,
  isSpreadElement,
  isVoidExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import {
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Native abort replaces a quiet source-known undefined input with its default DOMException. */

const NATIVES = new Set([
  ...STANDARD_ERRORS,
  'AbortController.prototype.abort',
  'AggregateError',
  'DOMException',
]);

/** Additional default origins cannot hide application work in void or ignored wrapper operands. */
export function framedAbortUndefinedReason(value: Expression, call: CallExpression): boolean {
  const source = framedQuietSource(value, false);
  if (source === undefined) return false;
  const native = globalPathOf(source)?.join('.') === 'undefined';
  const empty = isVoidExpression(source) && quietEvaluation([source.expression]);
  return (native || empty) && quietEvaluation(call.arguments);
}

/** Void discards a value without conversion; literal lists retain every evaluated operand. */
function quietEvaluation(expressions: readonly Expression[]): boolean {
  const pending = [...expressions];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const value = unwrapped(node);
    if (isIdentifier(value)) continue;
    if (isVoidExpression(value)) pending.push(value.expression);
    else if (isArrayLiteralExpression(value)) pending.push(...value.elements);
    else if (isSpreadElement(value)) {
      const source = framedQuietSource(value.expression, false);
      if (source === undefined || !isArrayLiteralExpression(source)) return false;
      pending.push(source);
    } else if (isOmittedExpression(value) || !framedQuietInputs([value], NATIVES)) return false;
  }
  return true;
}

/** Additional default origins stop at saved views, effects or application-evaluating member keys. */
export function framedAbortDefaultRead(
  reason: { readonly inferredDefault?: boolean; readonly quiet?: boolean },
  read: Expression,
): boolean {
  if (reason.inferredDefault !== true) return true;
  if (reason.quiet === false) return false;
  const { at, parent } = useOf(read);
  if (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) return false;
  return (
    parent.expression === at &&
    frameMemberName(parent) !== undefined &&
    (!isElementAccessExpression(parent) || framedQuietPrimitive(parent.argumentExpression))
  );
}
