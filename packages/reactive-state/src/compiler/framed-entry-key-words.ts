import { type CallExpression, type Expression, isSpreadElement } from 'typescript/ast';

import { selectedError } from './framed-array-selections.ts';
import { arrayError } from './framed-arrays.ts';
import { framedAppliedArguments } from './framed-keys.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';

/** Native fromEntries converts only each source-known array entry's first property-key value. */

interface KeyWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Direct and borrowed calls consume one iterable; receiver, entry values and later arguments stay data. */
export function framedEntryKeys(
  call: CallExpression,
  given: readonly Expression[] | undefined,
  words: KeyWords,
  applied?: Expression,
): boolean {
  const iterable = (value: Expression, keys: readonly string[] = []) =>
    iterableKeys(value, keys, call, words);
  if (given === undefined)
    return (
      applied !== undefined &&
      selectedError(applied, 0, { error: iterable, typed: () => false }, call)
    );
  return framedConsumedArguments(call, given, 1).some((value) => {
    return isSpreadElement(value)
      ? selectedError(value.expression, 0, { error: iterable, typed: () => false }, call)
      : iterable(value);
  });
}

/** Written native array entries retain literal spreads, aliases and source-visible element writes. */
function iterableKeys(
  value: Expression,
  keys: readonly string[],
  call: CallExpression,
  words: KeyWords,
): boolean {
  if (keys.length > 0) return words.error(value, [...keys, '0']);
  return selectedError(
    value,
    undefined,
    {
      error: (entry, selected = []) => entryKey(entry, selected, call, words),
      typed: () => false,
    },
    call,
  );
}

/** A stable tuple's first runtime slot is its key; opaque entry paths retain only that field. */
function entryKey(
  value: Expression,
  keys: readonly string[],
  call: CallExpression,
  words: KeyWords,
): boolean {
  if (keys.length > 0) return words.error(value, [...keys, '0']);
  const tuple = framedAppliedArguments(call, value);
  const converted = (key: Expression, selected: readonly string[] = []) =>
    words.error(key, selected) || (selected.length === 0 && arrayError(key, words, call));
  if (tuple === undefined)
    return selectedError(
      value,
      0,
      {
        error: converted,
        typed: (entry) => words.error(entry, ['0']),
      },
      call,
    );
  return framedConsumedArguments(call, tuple, 1).some((key) =>
    isSpreadElement(key) ? arrayError(key.expression, words, call) : converted(key),
  );
}
