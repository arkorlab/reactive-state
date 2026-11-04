import {
  type Expression,
  type CallExpression,
  type NewExpression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { selectedError } from './framed-array-selections.ts';
import { frameMemberName, frameTypeOf } from './framed-bindings.ts';
import { finiteSetSelection } from './framed-finite-set-results.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { setCarriedUnexposed } from './framed-set-carried.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { namesLocalMemberArrayType } from './local-type-reading.ts';

const AGGREGATE = new Set(['AggregateError']);

/** A selected native AggregateError errors entry retains the original iterable element identity. */
export function framedAggregateError(
  node: Expression,
  selection: { readonly made: boolean; readonly keys: readonly string[] },
  names: ReadonlySet<string>,
  error: (value: Expression, local: boolean, keys: readonly string[]) => boolean,
): boolean | undefined {
  let value = unwrapped(node);
  let path = selection.keys;
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    path = [key, ...path];
    value = unwrapped(value.expression);
  }
  const index = path[1];
  if (
    index === undefined ||
    path[0] !== 'errors' ||
    !/^(?:0|[1-9]\d*)$/u.test(index) ||
    (!isCallExpression(value) && !isNewExpression(value))
  )
    return undefined;
  const native = framedNativeArguments(value, AGGREGATE);
  if (native?.args === undefined) return undefined;
  const prefix = framedArgumentPrefix(value, native.args, 1);
  const iterable = prefix.values[0];
  if (iterable === undefined || prefix.unknown || prefix.alternatives !== undefined)
    return undefined;
  const tail = path.slice(2);
  const args = framedNativeConstructor(value.expression, AGGREGATE)
    ? quietAggregateArguments(value, native.args)
    : undefined;
  if (args !== undefined) {
    const selected = finiteSetSelection(iterable, {
      capture: value,
      consumer: node,
      index: Number(index),
    });
    if (
      selected !== undefined &&
      setCarriedUnexposed(
        [...selected.roots, ...args.slice(1)],
        selected.values.map((each) => ({ value: each })),
        value,
      ) &&
      selected.values.some((each) => error(each, selection.made, tail))
    )
      return true;
  }
  return selectedError(
    iterable,
    Number(index),
    {
      error: (each, keys) => error(each, selection.made, [...(keys ?? []), ...tail]),
      typed: (each, selected) => {
        const written = frameTypeOf(each);
        return (
          tail.length === 0 &&
          written !== undefined &&
          namesLocalMemberArrayType(written.type, written.keys, names, { index: selected })
        );
      },
    },
    value,
  )
    ? true
    : undefined;
}

/** A native aggregate message converts only source-proven primitive data; options remain opaque. */
function quietAggregateArguments(
  call: CallExpression | NewExpression,
  args: readonly Expression[],
): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, args, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  const { values } = prefix;
  if (values.length === 1) return values;
  return values.length === 2 && framedMapKey(values[1]) !== undefined ? values : undefined;
}
