import {
  type Expression,
  isElementAccessExpression,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { flattenedArrayViews } from './framed-array-flatten.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { quietCopy, type QuietCopyCall } from './framed-copy-guards.ts';
import { flatArgumentDepths } from './framed-flat-depth-arguments.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';

/** Expanded flat depths add original element views only across quiet native evaluation. */

/** A complete known list keeps the depth slot; unknown primitive depths retain written layers. */
export function expandedFlatViews(
  copy: QuietCopyCall,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
): readonly ArrayElementView[] | undefined {
  if (copy.unknownArguments === true || !quietCallee(copy.call.expression, copy.receiver))
    return undefined;
  if (!framedOriginPrefix(copy.call) || !framedOriginCoowned(copy.receiver, copy.call))
    return undefined;
  const args = framedArgumentPrefix(copy.call, copy.given, Infinity);
  if (args.unknown || args.alternatives !== undefined) return undefined;
  const depths = flatArgumentDepths(args.values[0]);
  const quiet = quietCopy(copy, args.values, stable);
  if (depths === undefined || quiet === undefined) return undefined;
  if (globalPathOf(unwrapped(copy.call.expression))?.join('.') === 'Reflect.apply') {
    const target = copy.call.arguments[0];
    if (target === undefined || !quietCallee(target, copy.receiver)) return undefined;
  }
  const values = (depths.values ?? [undefined]).flatMap((depth) =>
    flattenedArrayViews(copy.receiver, index, depth, { stable, capture: copy.call }),
  );
  return iteratorCarriedUnexposed(quiet.roots, values, copy.call) ? values : undefined;
}

/** Native callee chains keep literal computed keys; the source receiver is checked by quietCopy. */
function quietCallee(expression: Expression, receiver: Expression): boolean {
  let value = unwrapped(expression);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (isElementAccessExpression(value) && framedMapKey(value.argumentExpression) === undefined)
      return false;
    value = unwrapped(value.expression);
  }
  return (
    value === unwrapped(receiver) ||
    globalPathOf(value)?.join('.') === 'Array' ||
    globalPathOf(value)?.join('.') === 'Reflect'
  );
}
