import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isElementAccessExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';

/** Native array callbacks receive original item and array identities, but scalar indexes are copies. */
const ARRAY_CALLBACKS = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'toSorted',
]);
const REDUCED_ARRAY = 3;

interface Handoff {
  readonly receiver: Expression;
  readonly callback: Expression | undefined;
  readonly unknown: boolean;
  readonly slots: readonly number[];
  readonly arraySlot: number;
  readonly primitiveItems: boolean;
}

/** Only the first callback of a known native member adds implicit parameter inputs. */
export function middlewareCallbackHandoff(
  call: CallExpression,
  selected: (value: Expression) => Expression | undefined,
): Handoff | undefined {
  const method = unwrapped(call.expression);
  if (!isPropertyAccessExpression(method) && !isElementAccessExpression(method)) return undefined;
  const name = frameMemberName(method);
  if (name === undefined || !ARRAY_CALLBACKS.has(name)) return undefined;
  const receiver = selected(method.expression);
  if (receiver !== undefined && !isArrayLiteralExpression(receiver)) return undefined;
  const given = framedArgumentPrefix(call, call.arguments, 2);
  const unknown = given.unknown || given.alternatives !== undefined;
  const reduced = name === 'reduce' || name === 'reduceRight';
  const initial = unknown || given.values.length >= 2;
  if (receiver !== undefined && noCallback(receiver, name, initial)) return undefined;
  return {
    receiver: method.expression,
    callback: given.values[0],
    unknown,
    slots: callbackSlots(name, reduced, initial),
    arraySlot: reduced ? REDUCED_ARRAY : 2,
    primitiveItems:
      receiver?.elements.every(
        (element) => isOmittedExpression(element) || framedQuietPrimitive(element),
      ) ?? false,
  };
}

/** Reduction supplies accumulator and item separately; an explicit initial value is not a receiver item. */
function callbackSlots(name: string, reduced: boolean, initial: boolean): readonly number[] {
  if (name === 'toSorted') return [0, 1];
  if (reduced) return [1, REDUCED_ARRAY, ...(initial ? [] : [0])];
  return [0, 2];
}

/** A literal with no visited positions, or too few comparator/reducer inputs, never invokes its callback. */
function noCallback(receiver: ArrayLiteralExpression, method: string, initial: boolean): boolean {
  if (receiver.elements.length === 0) return true;
  if (receiver.elements.some((element) => isSpreadElement(element))) return false;
  if (method.startsWith('find')) return false;
  const elements = receiver.elements.filter((element) => !isOmittedExpression(element));
  if (method === 'toSorted')
    return (
      elements.filter((element) => {
        return (
          unwrapped(element).kind !== SyntaxKind.VoidExpression &&
          globalPathOf(unwrapped(element))?.join('.') !== 'undefined'
        );
      }).length < 2
    );
  if (!initial && (method === 'reduce' || method === 'reduceRight')) return elements.length < 2;
  return elements.length === 0;
}
