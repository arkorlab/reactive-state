import {
  type ArrayLiteralExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type NewExpression,
  type SpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { executionOwner } from './framed-array-mutations.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { immediateSelection } from './framed-copy-guards.ts';
import { finiteSetSelection } from './framed-finite-set-results.ts';
import { iteratorQuietValues } from './framed-iterator-guards.ts';
import { setCarriedUnexposed } from './framed-set-carried.ts';

/** A native Set spread into an array literal yields its finite source values in insertion order. */

/**
 * The values a fresh native Set spread supplies at a known result position of an immediately
 * selected array literal whose other elements are quiet; none before the spread's offset.
 */
export function setSpreadViews(
  spread: SpreadElement,
  array: ArrayLiteralExpression,
  position: number,
  keys: readonly string[],
): readonly ArrayElementView[] | undefined {
  const offset = array.elements.indexOf(spread);
  const others = array.elements.filter((each) => each !== spread && !isOmittedExpression(each));
  if (
    offset === -1 ||
    others.some((each) => isSpreadElement(each)) ||
    !iteratorQuietValues(others) ||
    !immediateSelection(array)
  )
    return undefined;
  if (position < offset) return [];
  const construction = setConstruction(spread.expression);
  if (construction === undefined || executionOwner(construction) !== executionOwner(array))
    return undefined;
  const selected = finiteSetSelection(spread.expression, {
    capture: construction,
    consumer: array,
    index: position - offset,
  });
  return selected !== undefined &&
    setCarriedUnexposed(
      selected.roots,
      selected.values.map((value) => ({ value })),
      array,
    )
    ? selected.values.map((value) => ({ value, index: undefined, element: true, keys }))
    : undefined;
}

/** The construction a whole const alias or a direct add chain holds; the full proof checks each step. */
function setConstruction(expression: Expression): NewExpression | undefined {
  let value = unwrapped(expression);
  const seen = new Set<Expression>();
  while (!seen.has(value)) {
    seen.add(value);
    if (isNewExpression(value)) return value;
    if (isIdentifier(value)) {
      const initializer = frameBindingOf(value)?.binding.initializer;
      if (initializer === undefined) return undefined;
      value = unwrapped(initializer);
      continue;
    }
    if (!isCallExpression(value)) return undefined;
    const callee = unwrapped(value.expression);
    if (
      (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) ||
      frameMemberName(callee) !== 'add'
    )
      return undefined;
    value = unwrapped(callee.expression);
  }
  return undefined;
}
