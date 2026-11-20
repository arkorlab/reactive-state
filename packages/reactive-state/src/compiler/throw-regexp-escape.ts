import {
  type CallExpression,
  isArrayLiteralExpression,
  isArrowFunction,
  isFunctionExpression,
  isObjectLiteralExpression,
  isRegularExpressionLiteral,
} from 'typescript/ast';

import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { globalCalleePath } from './throw-callees.ts';
import { quietNativeCall } from './throw-construct-only.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** RegExp.escape requires an actual string; quiet written non-string inputs throw without coercion. */
export function regexpEscapeThrows(call: CallExpression, outer: Resolve | undefined): boolean {
  const resolve: Resolve = (name) => {
    const held = outer?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, call) ? undefined : held;
  };
  const path = globalCalleePath(call.expression, resolve)?.join('.');
  if (path !== 'RegExp.escape' || !quietNativeCall(call, path, resolve)) {
    return false;
  }
  const first = call.arguments[0];
  if (first === undefined) {
    return true;
  }
  const value = writtenOf(first, resolve);
  const kind = primitiveOf(value, resolve);
  return (
    kind === 'nothing' ||
    kind === 'other' ||
    isBigIntWritten(value, resolve) ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isRegularExpressionLiteral(value)
  );
}
