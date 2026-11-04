import {
  type CallExpression,
  type Expression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
} from 'typescript/ast';

import { arrayError } from './framed-arrays.ts';
import { concatKey, concatLength } from './framed-concat-properties.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Native raw reads own numeric fields in order, without iterating its segment container. */

const NATIVES = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException', 'String.raw']);

interface RawArguments {
  readonly values: readonly Expression[];
  readonly unknown: boolean;
}

export interface RawArraylike {
  readonly count: number;
  readonly entries: ReadonlyMap<string, Expression>;
}

/** A finite written own length and unchanged local data fields retain their raw segment slots. */
export function framedRawArraylike(
  raw: Expression,
  call: CallExpression,
): RawArraylike | undefined {
  const source = framedQuietSource(raw);
  if (
    source === undefined ||
    !isObjectLiteralExpression(source) ||
    !framedPrefixSameOwner(source, call) ||
    !framedQuietTextPrefix(call, NATIVES) ||
    !framedQuietInputs(call.arguments, NATIVES)
  )
    return undefined;
  const entries = new Map<string, Expression>();
  for (const property of source.properties) {
    let value: Expression;
    if (isPropertyAssignment(property)) value = property.initializer;
    else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
      value = property.name;
    else return undefined;
    const key = concatKey(property.name, stable);
    if (key === undefined || key === '__proto__') return undefined;
    entries.set(key, value);
  }
  const count = concatLength(entries.get('length'), stable);
  return count === undefined ? undefined : { count, entries };
}

/** Unknown or inherited preceding reads and application conversions stop the added positive proof. */
export function rawArraylikeWords(
  source: RawArraylike,
  prefix: RawArguments,
  call: CallExpression,
  words: {
    readonly error: (value: Expression) => boolean;
    readonly typed: (value: Expression) => boolean;
  },
): boolean {
  // At most the written fields can be read before a missing own slot loses the proof.
  for (let index = 0; index < source.count && index < source.entries.size; index += 1) {
    if (!quietEarlierSubstitution(index, prefix, call)) return false;
    const value = source.entries.get(String(index));
    if (value === undefined) return false;
    if (framedNativeErrorInput(value, call) && words.error(value)) return true;
    if (arrayError(value, words, call) && framedQuietArrayWords(value, words.error, call))
      return true;
    if (!framedQuietPrimitive(value)) return false;
  }
  return false;
}

/** Existing literal metadata readers retain only source expressions whose aliases stayed unchanged. */
function stable(value: Expression): boolean {
  return framedQuietSource(value) !== undefined;
}

/** Only earlier consumed substitutions can change a later raw slot before its own conversion. */
function quietSubstitution(value: Expression, call: CallExpression): boolean {
  return framedQuietPrimitive(value) || framedQuietArrayWords(value, () => false, call);
}

/** A missing substitution is empty only when the complete argument prefix proves it absent. */
function quietEarlierSubstitution(
  index: number,
  prefix: RawArguments,
  call: CallExpression,
): boolean {
  if (index === 0) return true;
  const value = prefix.values[index];
  return value === undefined ? !prefix.unknown : quietSubstitution(value, call);
}
