import {
  type CallExpression,
  type Expression,
  isElementAccessExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isSpreadElement,
  isStringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments } from './framed-keys.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { constantValue } from './numbers.ts';

/** Native string replacement retains Date search and noncallable replacement text after quiet evaluation. */

const REPLACEMENT_PATHS: ReadonlySet<string> = new Set([
  'String.prototype.replace',
  'String.prototype.replaceAll',
]);
export const STRING_REPLACEMENT_FIELDS: ReadonlySet<string> = new Set([
  'Date',
  'Reflect',
  'Reflect.apply',
  'String',
  'String.prototype',
  ...REPLACEMENT_PATHS,
  'String.prototype.replace.apply',
  'String.prototype.replace.call',
  'String.prototype.replaceAll.apply',
  'String.prototype.replaceAll.call',
]);

interface ReplacementWords {
  readonly coowned: (value: Expression) => boolean;
  readonly inputs: (values: readonly Expression[]) => boolean;
  readonly arguments: (values: readonly Expression[]) => readonly Expression[] | undefined;
  readonly date: (value: Expression) => boolean;
  readonly quiet: (value: Expression) => boolean;
  /** Whether a value is one of unknown provenance, which may be any value. */
  readonly unread: (value: Expression) => boolean;
}

/** A native replacement call's receiver and what it is given, where the code shows a list of it. */
interface ReplacementOperands {
  readonly receiver: Expression;
  readonly given: readonly Expression[] | undefined;
}

/**
 * Every original input evaluates before native receiver, known native search and replacement
 * coercion. A search of unknown provenance may match; a spread or a list the compile cannot read,
 * or one carried across an execution owner, hides where the arguments fall, and takes no Date text
 * away (`unreadReplacement`).
 */
export function nativeStringReplacement(call: CallExpression, words: ReplacementWords): boolean {
  const selected = replacementOperands(call);
  if (selected === undefined) return false;
  const inputs = [selected.receiver, ...call.arguments];
  const written = inputs.filter((value) => !isSpreadElement(value));
  if (
    !words.coowned(call.expression) ||
    written.some((value) => !words.coowned(value)) ||
    !framedQuietTextPrefix(call, STRING_REPLACEMENT_FIELDS)
  )
    return false;
  const exposed = call.arguments.some((value) => isSpreadElement(value) && !words.coowned(value));
  const given =
    exposed || selected.given === undefined ? undefined : words.arguments(selected.given);
  if (given === undefined) return words.inputs(written) && unreadReplacement(call, selected, words);
  if (!words.inputs(inputs)) return false;
  const [search, replacement] = given;
  if (search === undefined) return false;
  const dateSearch = words.date(search);
  if (!dateSearch && !framedQuietPrimitive(search) && !words.unread(search)) return false;
  if (words.date(selected.receiver)) return true;
  return (
    words.quiet(selected.receiver) &&
    (dateSearch ||
      (replacement !== undefined &&
        replacementMayMatch(selected.receiver, search) &&
        words.date(replacement)))
  );
}

/**
 * What replacement renders where the compile cannot read where its arguments fall: the receiver's
 * Date text, and a Date that may be the search or the replacement (`framedConsumedArguments`),
 * which a search the compile cannot read may match.
 */
function unreadReplacement(
  call: CallExpression,
  selected: ReplacementOperands,
  words: ReplacementWords,
): boolean {
  if (words.date(selected.receiver)) return true;
  if (!words.quiet(selected.receiver) || selected.given === undefined) return false;
  return framedConsumedArguments(call, selected.given, 2).some(
    (value) => !isSpreadElement(value) && words.date(value),
  );
}

/** Written primitive text selects a direct native member; existing borrowing retains original operands. */
function replacementOperands(call: CallExpression): ReplacementOperands | undefined {
  const member = unwrapped(call.expression);
  if (
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    REPLACEMENT_PATHS.has(`String.prototype.${frameMemberName(member) ?? ''}`)
  ) {
    const value = framedQuietSource(member.expression);
    if (value !== undefined && (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)))
      return { receiver: member.expression, given: call.arguments };
  }
  const borrowed = borrowedTextCall(call);
  if (borrowed === undefined || !REPLACEMENT_PATHS.has(borrowed.path.join('.'))) return undefined;
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

/** A written missing primitive search leaves the rendered result fixed despite replacement coercion. */
function replacementMayMatch(receiver: Expression, search: Expression): boolean {
  const source = framedQuietSource(receiver);
  const selected = framedQuietSource(search);
  const text = source === undefined ? undefined : constantValue(source);
  const sought = selected === undefined ? undefined : constantValue(selected);
  return typeof text !== 'string' || typeof sought !== 'string' || text.includes(sought);
}
