import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  type NewExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { quietBoundErrorEvaluation } from './framed-bound-error-evaluation.ts';
import { boundErrorWordSlots } from './framed-bound-error-words.ts';
import { framedBoundErrorArguments } from './framed-bound-errors.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Bound message/name inputs retain native conversion order without changing direct native Error paths. */

const AGGREGATE = new Set(['AggregateError']);
const DOM = new Set(['DOMException']);

/** Only an unchanged selected Error input at a quiet actual invocation adds a new word origin. */
export function framedBoundErrorMessage(
  node: CallExpression | NewExpression,
  names: ReadonlySet<string>,
  error: (value: Expression) => boolean,
): boolean | undefined {
  const selected = framedBoundErrorArguments(node, names, false);
  if (selected === undefined) return undefined;
  if (!quietBoundErrorEvaluation(node, selected.bound)) return false;
  if (!selected.constructed && framedNativeConstructor(selected.target, DOM)) return false;
  const prefix = framedArgumentPrefix(node, selected.args, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return false;
  return boundErrorWordSlots(selected.target).some((index) => {
    const value = prefix.values[index];
    return (
      value !== undefined &&
      quietEarlierConversion(selected.target, prefix.values, index) &&
      framedNativeErrorInput(value, node, undefined, false) &&
      error(value)
    );
  });
}

/** AggregateError stays on direct literal iterables; DOMException converts its first text before its name. */
function quietEarlierConversion(
  target: Expression,
  args: readonly Expression[],
  index: number,
): boolean {
  if (index === 0) return true;
  const first = args[0];
  if (first === undefined) return false;
  return framedNativeConstructor(target, AGGREGATE)
    ? isArrayLiteralExpression(unwrapped(first))
    : framedQuietPrimitive(first);
}
