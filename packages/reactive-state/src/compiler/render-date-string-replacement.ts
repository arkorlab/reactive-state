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
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
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
}

/** Every original input evaluates before native receiver, known native search and replacement coercion. */
export function nativeStringReplacement(call: CallExpression, words: ReplacementWords): boolean {
  const selected = replacementOperands(call);
  if (selected === undefined) return false;
  const inputs = [selected.receiver, ...call.arguments];
  if (
    !words.coowned(call.expression) ||
    inputs.some((value) => !words.coowned(value)) ||
    !words.inputs(inputs) ||
    !framedQuietTextPrefix(call, STRING_REPLACEMENT_FIELDS)
  )
    return false;
  const given = words.arguments(selected.given);
  if (given === undefined) return false;
  const [search, replacement] = given;
  if (search === undefined) return false;
  const dateSearch = words.date(search);
  if (!dateSearch && !framedQuietPrimitive(search)) return false;
  if (words.date(selected.receiver)) return true;
  return (
    words.quiet(selected.receiver) &&
    (dateSearch ||
      (replacement !== undefined &&
        replacementMayMatch(selected.receiver, search) &&
        words.date(replacement)))
  );
}

/** Written primitive text selects a direct native member; existing borrowing retains original operands. */
function replacementOperands(
  call: CallExpression,
): { readonly receiver: Expression; readonly given: readonly Expression[] } | undefined {
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
  return given === undefined ? undefined : { receiver: borrowed.receiver, given };
}

/** A written missing primitive search leaves the rendered result fixed despite replacement coercion. */
function replacementMayMatch(receiver: Expression, search: Expression): boolean {
  const source = framedQuietSource(receiver);
  const selected = framedQuietSource(search);
  const text = source === undefined ? undefined : constantValue(source);
  const sought = selected === undefined ? undefined : constantValue(selected);
  return typeof text !== 'string' || typeof sought !== 'string' || text.includes(sought);
}
