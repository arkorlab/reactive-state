import {
  type CallExpression,
  type Expression,
  isElementAccessExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments } from './framed-keys.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';

/** Source-known native string concatenation converts original operands only after quiet evaluation. */

const CONCAT_PATH = 'String.prototype.concat';
export const STRING_CONCAT_FIELDS: ReadonlySet<string> = new Set([
  CONCAT_PATH,
  'Date',
  'Reflect',
  'Reflect.apply',
  'String',
  'String.prototype',
  'String.prototype.concat.apply',
  'String.prototype.concat.call',
]);

interface ConcatWords {
  readonly coowned: (value: Expression) => boolean;
  readonly inputs: (values: readonly Expression[]) => boolean;
  readonly arguments: (values: readonly Expression[]) => readonly Expression[] | undefined;
  readonly date: (value: Expression) => boolean;
  readonly quiet: (value: Expression) => boolean;
}

/** Native direct or borrowed concat retains its converted receiver and every consumed argument. */
export function nativeStringConcat(call: CallExpression, words: ConcatWords): boolean {
  const selected = concatOperands(call);
  if (selected === undefined) return false;
  const inputs = [selected.receiver, ...call.arguments];
  if (
    !words.coowned(call.expression) ||
    inputs.some((value) => !words.coowned(value)) ||
    !words.inputs(inputs) ||
    !framedQuietTextPrefix(call, STRING_CONCAT_FIELDS)
  )
    return false;
  const given = words.arguments(selected.given);
  if (given === undefined) return false;
  for (const value of [selected.receiver, ...given]) {
    if (words.date(value)) return true;
    if (!words.quiet(value)) return false;
  }
  return false;
}

/** Direct literal text and unchanged whole constant aliases select the native member. */
function concatOperands(
  call: CallExpression,
): { readonly receiver: Expression; readonly given: readonly Expression[] } | undefined {
  const member = unwrapped(call.expression);
  if (
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === 'concat'
  ) {
    const value = framedQuietSource(member.expression);
    if (value !== undefined && (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)))
      return { receiver: member.expression, given: call.arguments };
  }
  const borrowed = borrowedTextCall(call);
  if (borrowed?.path.join('.') !== CONCAT_PATH) return undefined;
  const applied = borrowed.applied;
  if (applied === undefined) return { receiver: borrowed.receiver, given: borrowed.given };
  const source = framedQuietSource(applied);
  const nullish =
    source?.kind === SyntaxKind.NullKeyword ||
    globalPathOf(source ?? applied)?.join('.') === 'undefined';
  if (nullish && globalPathOf(member)?.join('.') === 'Reflect.apply') return undefined;
  const given = nullish ? [] : framedAppliedArguments(call, applied);
  return given === undefined ? undefined : { receiver: borrowed.receiver, given };
}
