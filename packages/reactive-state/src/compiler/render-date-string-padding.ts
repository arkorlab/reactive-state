import {
  type CallExpression,
  type Expression,
  isElementAccessExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isSpreadElement,
  isStringLiteral,
  isVoidExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedCondition } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { constantValue } from './numbers.ts';

/** Native string padding converts its receiver and a consumed fill, independently of numeric width. */

const PADDING_PATHS: ReadonlySet<string> = new Set([
  'String.prototype.padEnd',
  'String.prototype.padStart',
]);
export const STRING_PADDING_FIELDS: ReadonlySet<string> = new Set([
  'Date',
  'Reflect',
  'Reflect.apply',
  'String',
  'String.prototype',
  ...PADDING_PATHS,
  'String.prototype.padEnd.apply',
  'String.prototype.padEnd.call',
  'String.prototype.padStart.apply',
  'String.prototype.padStart.call',
]);

interface PaddingWords {
  readonly coowned: (value: Expression) => boolean;
  readonly inputs: (values: readonly Expression[]) => boolean;
  readonly arguments: (values: readonly Expression[]) => readonly Expression[] | undefined;
  readonly date: (value: Expression) => boolean;
  readonly quiet: (value: Expression) => boolean;
  /** Whether a value is one of unknown provenance, which may be any value. */
  readonly unread: (value: Expression) => boolean;
}

/** A native padding call's receiver and what it is given, where the code shows a list of it. */
interface PaddingOperands {
  readonly receiver: Expression;
  readonly given: readonly Expression[] | undefined;
}

/**
 * Every original input evaluates before native receiver, numeric length and optional fill coercion.
 * A width of unknown provenance may require the fill; a spread or a list the compile cannot read,
 * or one carried across an execution owner, hides where the arguments fall, and takes no Date text
 * away (`unreadPadding`).
 */
export function nativeStringPadding(call: CallExpression, words: PaddingWords): boolean {
  const selected = paddingOperands(call);
  if (selected === undefined) return false;
  const inputs = [selected.receiver, ...call.arguments];
  const written = inputs.filter((value) => !isSpreadElement(value));
  if (
    !words.coowned(call.expression) ||
    written.some((value) => !words.coowned(value)) ||
    !framedQuietTextPrefix(call, STRING_PADDING_FIELDS)
  )
    return false;
  const exposed = call.arguments.some((value) => isSpreadElement(value) && !words.coowned(value));
  const given =
    exposed || selected.given === undefined ? undefined : words.arguments(selected.given);
  if (given === undefined) return words.inputs(written) && unreadPadding(call, selected, words);
  if (!words.inputs(inputs)) return false;
  if (words.date(selected.receiver)) return true;
  if (!words.quiet(selected.receiver)) return false;
  const [size, fill] = given;
  return (
    size !== undefined &&
    (framedQuietPrimitive(size) || words.unread(size)) &&
    paddingRequired(selected.receiver, size) &&
    fill !== undefined &&
    words.date(fill)
  );
}

/**
 * What padding renders where the compile cannot read where its arguments fall: the receiver's Date
 * text, and a Date that may be the fill — one after a written width that may require it, or any
 * after a spread the compile cannot read (`framedConsumedArguments`).
 */
function unreadPadding(
  call: CallExpression,
  selected: PaddingOperands,
  words: PaddingWords,
): boolean {
  if (words.date(selected.receiver)) return true;
  if (!words.quiet(selected.receiver) || selected.given === undefined) return false;
  const head = framedArgumentPrefix(call, selected.given, 1);
  const width = head.unknown || head.alternatives !== undefined ? undefined : head.values[0];
  if (
    width !== undefined &&
    framedQuietPrimitive(width) &&
    !paddingRequired(selected.receiver, width)
  )
    return false;
  const consumed = framedConsumedArguments(call, selected.given, 2);
  const fills = width === undefined ? consumed : consumed.slice(1);
  return fills.some((value) => !isSpreadElement(value) && words.date(value));
}

/** Written primitive text selects a direct native member; existing borrowing retains original operands. */
function paddingOperands(call: CallExpression): PaddingOperands | undefined {
  const member = unwrapped(call.expression);
  if (
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    PADDING_PATHS.has(`String.prototype.${frameMemberName(member) ?? ''}`)
  ) {
    const value = framedQuietSource(member.expression);
    if (value !== undefined && (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)))
      return { receiver: member.expression, given: call.arguments };
  }
  const borrowed = borrowedTextCall(call);
  if (borrowed === undefined || !PADDING_PATHS.has(borrowed.path.join('.'))) return undefined;
  const applied = borrowed.applied;
  if (applied === undefined) return { receiver: borrowed.receiver, given: borrowed.given };
  const source = framedQuietSource(applied);
  const nullish =
    source?.kind === SyntaxKind.NullKeyword ||
    globalPathOf(source ?? applied)?.join('.') === 'undefined';
  if (nullish && globalPathOf(member)?.join('.') === 'Reflect.apply') return undefined;
  const given = nullish ? [] : framedAppliedArguments(call, applied);
  return { receiver: borrowed.receiver, given };
}

/** A known nonpositive width or sufficiently long written receiver does not consume the fill. */
function paddingRequired(receiver: Expression, size: Expression): boolean {
  const source = framedQuietSource(size);
  if (
    framedCondition(size) === false ||
    (source !== undefined &&
      (isVoidExpression(source) || globalPathOf(source)?.join('.') === 'undefined'))
  )
    return false;
  const width = source === undefined ? undefined : constantValue(source);
  if (width === undefined) return true;
  const length = Math.trunc(Number(width)) || 0;
  if (length <= 0) return false;
  const value = framedQuietSource(receiver);
  const text = value === undefined ? undefined : constantValue(value);
  return typeof text !== 'string' || length > text.length;
}
