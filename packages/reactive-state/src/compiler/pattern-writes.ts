import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isRegularExpressionLiteral,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { initializerOf } from './framed.ts';
import { constantValue } from './numbers.ts';

/** What matching a retained regular expression changes of its lastIndex. */

/** The symbol methods that, without g, execute a sticky pattern against its current index. */
const INDEXING_SYMBOLS: ReadonlySet<string> = new Set(['Symbol.match', 'Symbol.replace']);

/** The global symbol a method key names, through aliases; none of another key or a shadowed Symbol. */
export function patternSymbolName(key: Expression): string | undefined {
  const path = globalPathOf(patternValue(key))?.join('.');
  return path !== undefined && INDEXING_SYMBOLS.has(path) ? path : undefined;
}

/**
 * Whether a symbol method advances a retained pattern. Search restores its previous index; split
 * and matchAll work on a clone. Global match and replace reset their index at both ends.
 */
export function symbolPatternChanges(method: string, receiver: Expression): boolean {
  return INDEXING_SYMBOLS.has(method) && isStickyPattern(receiver);
}

/** Whether a pattern is sticky without g, which match and replace advance between calls. */
export function isStickyPattern(node: Expression): boolean {
  const flags = flagsOf(node);
  return flags === null || (flags !== undefined && flags.includes('y') && !flags.includes('g'));
}

/** Whether exec and test keep a pattern's index between calls, through constants and copies. */
export function keepsPatternIndex(node: Expression): boolean {
  const flags = flagsOf(node);
  return flags === null || (flags !== undefined && (flags.includes('g') || flags.includes('y')));
}

/**
 * The flags of a pattern the code writes, copied too, following its constants; null of flags the
 * compile cannot read, which may keep an index, and none of what shows no pattern.
 */
function flagsOf(pattern: Expression): string | null | undefined {
  let value = unwrapped(pattern);
  const seen = new Set<Expression>();
  while (!seen.has(value)) {
    seen.add(value);
    value = patternValue(value);
    if (isRegularExpressionLiteral(value)) {
      return value.text.slice(value.text.lastIndexOf('/') + 1);
    }
    const given = patternArguments(value);
    if (given === undefined) {
      return seen.size > 1 && constantValue(value, initializerOf) === undefined ? null : undefined;
    }
    const [source, flags] = given;
    if (flags !== undefined && globalPathOf(unwrapped(flags))?.join('.') !== 'undefined') {
      return writtenFlags(flags);
    }
    if (source === undefined) {
      return '';
    }
    value = unwrapped(source);
  }
  return null;
}

/** The flags written as text through constants, or null where they may keep an index. */
function writtenFlags(flags: Expression): string | null {
  const written = constantValue(flags, initializerOf);
  return typeof written === 'string' ? written : null;
}

/** What a pattern or symbol key's name is declared of, without following an alias twice. */
function patternValue(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = initializerOf(value);
    if (declared === undefined) {
      break;
    }
    value = unwrapped(declared);
  }
  return value;
}

/** What a construction or call of RegExp is given; none of another expression. */
function patternArguments(value: Expression): readonly Expression[] | undefined {
  return (isNewExpression(value) || isCallExpression(value)) &&
    globalPathOf(unwrapped(value.expression))?.join('.') === 'RegExp'
    ? (value.arguments ?? [])
    : undefined;
}
