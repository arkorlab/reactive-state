import {
  type ArrayLiteralExpression,
  type ElementAccessExpression,
  type Expression,
  isElementAccessExpression,
  type SpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { selectedError } from './framed-array-selections.ts';
import { frameTypeOf } from './framed-bindings.ts';
import { framedKeyNames } from './framed-keys.ts';
import { mapSpreadViews } from './framed-map-spreads.ts';
import { setSpreadViews } from './framed-set-spreads.ts';
import { namesLocalMemberArrayType } from './local-type-reading.ts';

/** An array index retains selected possible elements without converting nested arrays to text. */
export function framedDynamicArrayResult(
  node: Expression,
  made: boolean,
  names: ReadonlySet<string>,
  error: (value: Expression, local: boolean, keys?: readonly string[]) => boolean,
): boolean | undefined {
  const value = unwrapped(node);
  if (!isElementAccessExpression(value)) return undefined;
  const indexes = possibleIndexes(value);
  const typed = (each: Expression, index: number | undefined) => {
    const type = frameTypeOf(each);
    return type !== undefined && namesLocalMemberArrayType(type.type, type.keys, names, { index });
  };
  const selected = indexes.some((index) => {
    return selectedError(
      value.expression,
      index,
      { error: (each, keys) => error(each, made, keys), typed, spread: collectionSpreadViews },
      value,
    );
  });
  return selected ? true : undefined;
}

/** A native Set spread yields its values, and a native Map spread its entries' slots. */
function collectionSpreadViews(
  spread: SpreadElement,
  array: ArrayLiteralExpression,
  position: number,
  keys: readonly string[],
): readonly ArrayElementView[] | undefined {
  return (
    setSpreadViews(spread, array, position, keys) ?? mapSpreadViews(spread, array, position, keys)
  );
}

/** Finite nonnegative index alternatives stay selected; arbitrary numeric positions keep all elements. */
function possibleIndexes(value: ElementAccessExpression): readonly (number | undefined)[] {
  const keys = framedKeyNames(value.argumentExpression);
  return keys === undefined
    ? [undefined]
    : keys.flatMap((key) => (/^(?:0|[1-9]\d*)$/u.test(key) ? [Number(key)] : []));
}
