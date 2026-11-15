import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import {
  framedQuietData,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { borrowedIntlRead } from './render-intl-borrowed.ts';
import { freshIntlReceiver, wholeIntlConstant } from './render-intl-receivers.ts';

/** Borrowed native date formatting consumes the supplied receiver and its optional first date. */

const CLOCK_METHODS = new Map([['Intl.DateTimeFormat', new Set(['formatToParts'])]]);
const REFLECT_APPLY = new Set(['Reflect.apply']);
const FIELDS = new Set([
  'Intl.DateTimeFormat',
  'Intl.DateTimeFormat.prototype',
  'Intl.DateTimeFormat.prototype.formatToParts',
  'JSON.stringify',
  'Reflect.apply',
]);
const WRAPPER = { applied: 2 } as const;

type NativeDateFormat = (callee: Expression, member: string) => boolean;

/** Only unchanged native method identity and quiet original operands add a borrowed clock read. */
export function borrowedDateFormatClock(node: Node, native: NativeDateFormat): boolean {
  if (!isCallExpression(node)) return false;
  const borrowed = borrowedIntlRead(node, CLOCK_METHODS);
  if (borrowed === undefined) return false;
  const bound = borrowed.bound;
  const receiver = freshIntlReceiver(borrowed.expression, bound?.call ?? node);
  if (
    receiver === undefined ||
    !native(receiver.expression, 'formatToParts') ||
    (receiver.arguments ?? []).some((argument) => !framedQuietData(argument))
  )
    return false;
  if (
    !framedQuietTextPrefix(
      node,
      FIELDS,
      (call) => {
        return (
          call === bound?.call ||
          (native(call.expression, 'formatToParts') &&
            call.arguments.every((argument) => framedQuietData(argument)))
        );
      },
      nativeFieldsInOwner(borrowed.fields, node),
    ) ||
    !quietCallee(bound?.call.expression ?? node.expression) ||
    !quietOperands(node, borrowed.expression, borrowed.target, bound?.call)
  )
    return false;
  const given = borrowedDates(node, bound?.args);
  return given !== undefined && missingDate(given[0]);
}

/** Only literal native fields already followed by this method proof retain a quiet same-owner read. */
function nativeFieldsInOwner(
  fields: ReadonlySet<Expression>,
  read: Expression,
): ReadonlySet<Expression> {
  const selected = new Set<Expression>();
  for (const field of fields) if (framedPrefixSameOwner(field, read)) selected.add(field);
  return selected;
}

/** Computed callee keys and immutable native aliases retain their original evaluation boundary. */
function quietCallee(expression: Expression): boolean {
  const seen = new Set<Expression>();
  let value = unwrapped(expression);
  while (!seen.has(value)) {
    seen.add(value);
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
        return false;
      value = unwrapped(value.expression);
      continue;
    }
    if (!isIdentifier(value)) return false;
    const global = globalPathOf(value)?.join('.');
    if (global === 'Intl' || global === 'Reflect') return true;
    const source = wholeIntlConstant(value)?.initializer;
    if (source === undefined) return false;
    value = unwrapped(source);
  }
  return false;
}

/** Native wrappers keep all original evaluated operands, including tails they later ignore. */
function quietOperands(
  call: CallExpression,
  receiver: Expression,
  target: Expression,
  bound: CallExpression | undefined,
): boolean {
  const pending = [...call.arguments, ...(bound?.arguments ?? [])];
  if (
    bound !== undefined &&
    (!framedOriginCoowned(call.expression, call) ||
      !framedOriginCoowned(target, call) ||
      !framedOriginCoowned(receiver, call) ||
      pending.some((input) => !framedOriginCoowned(input, call)))
  )
    return false;
  for (let expression = pending.pop(); expression !== undefined; expression = pending.pop()) {
    if (expression === receiver || expression === target) continue;
    const value = unwrapped(expression);
    const source = framedQuietSource(expression);
    if (source !== undefined && isVoidExpression(source)) pending.push(source.expression);
    else if (isArrayLiteralExpression(value)) pending.push(...value.elements);
    else if (isSpreadElement(value)) {
      const spread = framedQuietSource(value.expression);
      if (spread === undefined || !isArrayLiteralExpression(spread)) return false;
      pending.push(...spread.elements);
    } else if (!framedQuietInputs([expression], FIELDS)) return false;
  }
  return true;
}

/** A known complete wrapper prefix fixes the native date slot without shifting unknown spreads. */
function borrowedDates(
  call: CallExpression,
  bound: readonly Expression[] | undefined,
): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, bound ?? call.arguments, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  const values = prefix.values;
  if (bound !== undefined) return values;
  if (framedNativeConstructor(call.expression, REFLECT_APPLY)) {
    const list = values[WRAPPER.applied];
    return list === undefined ? undefined : appliedDates(call, list, false);
  }
  const callee = unwrapped(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const method = frameMemberName(callee);
  if (method === 'call') return values.slice(1);
  return appliedDates(call, values[1], true);
}

/** Function.apply alone treats an omitted or nullish argument list as an empty native list. */
function appliedDates(
  call: CallExpression,
  expression: Expression | undefined,
  nullish: boolean,
): readonly Expression[] | undefined {
  if (nullish && (expression === undefined || nullishList(expression))) return [];
  if (expression === undefined) return undefined;
  const applied = framedAppliedArguments(call, expression);
  if (applied === undefined) return undefined;
  const prefix = framedArgumentPrefix(call, applied, Infinity);
  return prefix.unknown || prefix.alternatives !== undefined ? undefined : prefix.values;
}

/** A native nullish apply list differs from Reflect.apply's required array-like operand. */
function nullishList(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  return value !== undefined && (value.kind === SyntaxKind.NullKeyword || missingDate(value));
}

/** Only literal omitted values and whole immutable aliases establish a default current date. */
function missingDate(expression: Expression | undefined): boolean {
  if (expression === undefined) return true;
  const seen = new Set<Expression>();
  let value = unwrapped(expression);
  while (!seen.has(value)) {
    seen.add(value);
    if (
      isVoidExpression(value) ||
      isOmittedExpression(value) ||
      globalPathOf(value)?.join('.') === 'undefined'
    )
      return true;
    if (!isIdentifier(value)) return false;
    const initial = wholeIntlConstant(value)?.initializer;
    if (initial === undefined) return false;
    value = unwrapped(initial);
  }
  return false;
}
