import {
  type ArrowFunction,
  type Expression,
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isParameterDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { concatQuietArguments } from './framed-concat-properties.ts';
import { quietErrorConstruction } from './framed-copy-guards.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { localTypePrimitiveIdentityKeys } from './local-type-reading.ts';

/** Native filter supplies a present value, its numeric index and the source to simple parameters. */

/** Quiet or definitely skipped defaults preserve the original source and its carried bindings. */
export function filterParameterDefaults(
  predicate: ArrowFunction,
  present: readonly Expression[],
  stable: (receiver: Expression) => boolean,
): readonly Expression[] | undefined {
  const defaults: Expression[] = [];
  const parameters = predicate.parameters.entries();
  for (const [index, parameter] of parameters) {
    if (!isIdentifier(parameter.name)) return undefined;
    const value = parameter.initializer;
    if (value === undefined) continue;
    const skipped =
      index === 1 || index === 2 || (index === 0 && present.every((each) => definedInput(each)));
    if (!skipped && !concatQuietArguments([value], stable)) return undefined;
    defaults.push(value);
  }
  return defaults;
}

/** Written values and closed primitive alternatives exclude undefined without inferring a call. */
function definedInput(expression: Expression): boolean {
  let value = unwrapped(expression);
  const seen = new Set<FrameBinding>();
  for (;;) {
    if (constructedInput(value)) return true;
    const key = framedMapKey(value);
    if (key !== undefined) return key !== 'undefined';
    const binding = inputBinding(value, seen);
    if (binding === undefined) return false;
    seen.add(binding);
    if (isParameterDeclaration(binding) && binding.questionToken !== undefined) return false;
    if (binding.type !== undefined)
      return localTypePrimitiveIdentityKeys(binding.type).every(
        (identity) => identity !== '*' && identity !== 'primitive:undefined',
      );
    if (binding.initializer === undefined) return false;
    value = unwrapped(binding.initializer);
  }
}

/** A fresh data construction cannot supply undefined to the first native callback parameter. */
function constructedInput(value: Expression): boolean {
  return (
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    quietErrorConstruction(value)
  );
}

/** Only a whole lexical input binding, visited once, provides an initializer or annotation. */
function inputBinding(
  value: Expression,
  seen: ReadonlySet<FrameBinding>,
): FrameBinding | undefined {
  const selected = isIdentifier(value) ? frameBindingOf(value) : undefined;
  if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
    return undefined;
  return selected.binding;
}
