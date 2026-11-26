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
import { framedQuietSource, framedWrittenSource } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Direct calls and constructions of a source-known native bound Error retain its original target. */

/**
 * A finite native bind prefix precedes the invocation's own consumed message arguments. A reader whose
 * proof an exposure drops passes `reached` false, to count only a loop body's uses.
 */
export function framedBoundErrorArguments(
  node: CallExpression | NewExpression,
  names: ReadonlySet<string>,
  reached = true,
):
  | {
      readonly target: Expression;
      readonly bound: CallExpression;
      readonly args: readonly Expression[];
      readonly applied: undefined;
      readonly constructed: boolean;
    }
  | undefined {
  const bound = framedQuietSource(node.expression, reached ? 'loops' : false);
  if (bound === undefined || !isCallExpression(bound)) return undefined;
  const member = unwrapped(bound.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'bind' ||
    !framedNativeConstructor(member.expression, names) ||
    !unchangedNativeBind(member.expression, bound, names, reached)
  )
    return undefined;
  const prefix = framedArgumentPrefix(bound, bound.arguments, Infinity, false);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  return {
    target: member.expression,
    bound,
    args: [...prefix.values.slice(1), ...(node.arguments ?? [])],
    applied: undefined,
    constructed: isNewExpression(node),
  };
}

/**
 * A call of a whole alias written as a native Error's bind, whose proof an exposure dropped, may still
 * construct that Error: what has used the alias may not have replaced its bind.
 */
export function framedPossibleBoundError(
  node: CallExpression | NewExpression,
  names: ReadonlySet<string>,
): boolean {
  const written = framedWrittenSource(node.expression);
  if (written === undefined || !isCallExpression(written)) return false;
  const member = unwrapped(written.expression);
  return (
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === 'bind' &&
    framedNativeConstructor(member.expression, names)
  );
}
