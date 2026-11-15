import { type Expression, isArrayLiteralExpression, type NewExpression } from 'typescript/ast';

import { framedArrayString } from './framed-arrays.ts';
import {
  framedNativeErrorInput,
  type FramedNativeErrorReads,
} from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedTextOptions } from './framed-text-options.ts';

/** Native init dictionaries consume only closed, source-known text fields without preceding opaque conversion. */

export interface InitTextWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Untouched Error values and finite quiet array text retain their original engine-selected words. */
export function framedInitTextValue(
  value: Expression,
  call: NewExpression,
  words: InitTextWords,
  reads?: FramedNativeErrorReads,
): boolean {
  const error = (each: Expression, keys?: readonly string[]) =>
    framedOriginCoowned(each, call) && words.error(each, keys);
  return (
    (framedNativeErrorInput(value, call, reads) && error(value)) ||
    (framedQuietArrayWords(value, error, call) &&
      framedArrayString(value, { error, typed: words.typed }, call))
  );
}

/** Unselected option conversions stay primitive rather than invoking an unknown application's conversion. */
export function primitiveOtherOptions(
  fields: ReadonlyMap<string, Expression>,
  selected: string,
): boolean {
  return [...fields].every(([key, value]) => key === selected || framedQuietPrimitive(value));
}

/** Header record values and finite literal entry values convert in order with only quiet preceding words. */
export function framedInitHeaderWords(
  value: Expression,
  call: NewExpression,
  words: InitTextWords,
  natives: ReadonlySet<string>,
): boolean {
  const record = framedTextOptions(value, natives);
  if (record !== undefined) return headerValues([...record.values()], call, words);
  const source = framedQuietSource(value);
  if (source === undefined || !isArrayLiteralExpression(source)) return false;
  const values: Expression[] = [];
  for (const each of source.elements) {
    const entry = framedQuietSource(each);
    if (entry === undefined || !isArrayLiteralExpression(entry) || entry.elements.length !== 2)
      return false;
    const key = entry.elements[0];
    const item = entry.elements[1];
    if (key === undefined || item === undefined || !framedQuietPrimitive(key)) return false;
    values.push(item);
  }
  return headerValues(values, call, words);
}

/** Every earlier header value must convert without running an unknown hook before the selected Error. */
function headerValues(
  values: readonly Expression[],
  call: NewExpression,
  words: InitTextWords,
): boolean {
  let found = false;
  for (const value of values) {
    if (framedQuietPrimitive(value)) continue;
    if (!framedInitTextValue(value, call, words)) return false;
    found = true;
  }
  return found;
}
