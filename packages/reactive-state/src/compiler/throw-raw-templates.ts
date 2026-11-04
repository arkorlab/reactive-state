import {
  type CallExpression,
  isComputedPropertyName,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
} from 'typescript/ast';

import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { quietNativeCall } from './throw-construct-only.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** String.raw converts its template and raw member to objects before reading any raw length. */
export function rawTemplateThrows(
  call: CallExpression,
  path: string,
  outer: Resolve | undefined,
): boolean {
  if (path !== 'String.raw') {
    return false;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  if (!quietNativeCall(call, path, resolve)) {
    return false;
  }
  const template = call.arguments[0];
  if (template === undefined || primitiveOf(writtenOf(template, resolve), resolve) === 'nothing') {
    return true;
  }
  const value = writtenOf(template, resolve);
  if (!isObjectLiteralExpression(value) || calleeUncertain(value, call)) {
    return false;
  }
  let missing = true;
  for (const property of value.properties) {
    if (
      (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property)) ||
      isComputedPropertyName(property.name)
    ) {
      return false;
    }
    const name = property.name;
    if (!(isIdentifier(name) || isStringLiteral(name)) || name.text === '__proto__') {
      return false;
    }
    if (name.text === 'raw') {
      const raw = isPropertyAssignment(property) ? property.initializer : name;
      missing = primitiveOf(writtenOf(raw, resolve), resolve) === 'nothing';
    }
  }
  return missing;
}
