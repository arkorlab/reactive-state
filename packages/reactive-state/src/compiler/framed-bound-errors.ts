import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isPropertyAccessExpression,
  type NewExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { unchangedNativeBind } from './framed-native-bind.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Direct calls and constructions of a source-known native bound Error retain its original target. */

/** A finite native bind prefix precedes the invocation's own consumed message arguments. */
export function framedBoundErrorArguments(
  node: CallExpression | NewExpression,
  names: ReadonlySet<string>,
):
  | {
      readonly target: Expression;
      readonly bound: CallExpression;
      readonly args: readonly Expression[];
      readonly applied: undefined;
      readonly constructed: boolean;
    }
  | undefined {
  const bound = framedQuietSource(node.expression);
  if (bound === undefined || !isCallExpression(bound)) return undefined;
  const member = unwrapped(bound.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'bind' ||
    !framedNativeConstructor(member.expression, names) ||
    !unchangedNativeBind(member.expression, bound, names)
  )
    return undefined;
  const prefix = framedArgumentPrefix(bound, bound.arguments, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  return {
    target: member.expression,
    bound,
    args: [...prefix.values.slice(1), ...(node.arguments ?? [])],
    applied: undefined,
    constructed: isNewExpression(node),
  };
}
