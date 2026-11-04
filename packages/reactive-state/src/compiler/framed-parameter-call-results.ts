import {
  type Expression,
  isCallExpression,
  isNewExpression,
  isElementAccessExpression,
  isIdentifier,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedQuietInputs } from './framed-native-evaluation.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { namesLocalCallResult } from './local-type-reading.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Unchanged directly called parameter values retain a single source-written result annotation. */

const ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);
const NO_NATIVES = new Set<string>();

/** Written return members retain their original type arguments without inferring call overloads. */
export function framedParameterCallResult(node: Expression, keys: readonly string[]): boolean {
  let value = unwrapped(node);
  const path = [...keys];
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (
      isElementAccessExpression(value) &&
      !framedQuietInputs([value.argumentExpression], NO_NATIVES)
    )
      return false;
    const key = frameMemberName(value);
    if (key === undefined) return false;
    path.unshift(key);
    value = unwrapped(value.expression);
  }
  if (
    (!isCallExpression(value) && !isNewExpression(value)) ||
    !framedQuietInputs(value.arguments ?? [], NO_NATIVES)
  )
    return false;
  const source = parameterAnnotation(value.expression);
  return (
    source !== undefined &&
    namesLocalCallResult(
      source.type,
      source.keys,
      { keys: path, kind: isNewExpression(value) ? 'construct' : 'call' },
      ERRORS,
    )
  );
}

/** Whole const aliases preserve their capture position; defaults and replaced bindings stay opaque. */
function parameterAnnotation(
  expression: Expression,
): { readonly type: TypeNode; readonly keys: readonly string[] } | undefined {
  let value = unwrapped(expression);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    if (framedAssignedValues(value).length > 0) return undefined;
    const selected = frameBindingOf(value);
    if (selected === undefined || seen.has(selected.binding)) return undefined;
    const { binding } = selected;
    seen.add(binding);
    if (isParameterDeclaration(binding)) {
      return binding.type === undefined || binding.initializer !== undefined
        ? undefined
        : { type: binding.type, keys: selected.keys };
    }
    if (
      selected.keys.length > 0 ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    value = unwrapped(binding.initializer);
  }
  return undefined;
}
