import {
  type Expression,
  type NewExpression,
  type ObjectLiteralExpression,
  type SpreadAssignment,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { returnedBy } from './answers.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { selectedError } from './framed-array-selections.ts';
import { arrayError } from './framed-arrays.ts';
import { frameTypeOf } from './framed-bindings.ts';
import { framedPrimitiveParameterIterable } from './framed-parameter-iterables.ts';
import {
  framedChangedRecord,
  framedFormRecord,
  type RecordFields,
} from './framed-record-changes.ts';
import { framedRecordOrigin } from './framed-record-origins.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { localArrayIterationKeys } from './local-type-reading.ts';

/** Native query parameters and headers convert each written entry key and value, or record value. */

const PARAMS = new Set(['Headers', 'URLSearchParams']);

interface RecordField {
  readonly property: ObjectLiteralExpression['properties'][number];
  readonly ancestors: ReadonlySet<Node>;
}

/** A record's entries so far: each name's possible values, its own getters, and unnamed values. */
interface RecordEntries {
  readonly fields: Map<string, readonly Expression[]>;
  readonly getters: Map<string, { readonly literal: Node; readonly values: readonly Expression[] }>;
  readonly unknown: Expression[];
}

interface ParameterWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Only the first argument of a known native constructor contributes parameter words. */
export function framedSearchParamsText(call: NewExpression, words: ParameterWords): boolean {
  if (!framedNativeConstructor(call.expression, PARAMS)) return false;
  return framedConsumedArguments(call, call.arguments ?? [], 1).some((value) => {
    return isSpreadElement(value)
      ? selectedError(
          value.expression,
          0,
          {
            error: (each) => parameterInput(each, call, words),
            typed: () => false,
          },
          call,
        )
      : parameterInput(value, call, words);
  });
}

/** A written record contributes its values; an iterable contributes both fields of each entry. */
function parameterInput(value: Expression, call: NewExpression, words: ParameterWords): boolean {
  const record = recordWords(value, call, words);
  if (record !== undefined) return record;
  return selectedError(
    value,
    undefined,
    {
      error: (entry, keys = []) => entryWords(entry, keys, call, words),
      typed: (array) => typedEntries(array, words),
    },
    call,
  );
}

/**
 * Literal record aliases retain source values without converting the whole record to text; a record
 * possibly changed since keeps what may still be in it and what was written into it.
 */
function recordWords(
  expression: Expression,
  call: NewExpression,
  words: ParameterWords,
): boolean | undefined {
  const origin = framedRecordOrigin(expression, call, true);
  if (origin === undefined) return formWords(expression, call, words);
  if (origin.unchanged && framedPrimitiveParameterIterable(expression, origin.record, call))
    return false;
  const fields = recordFields(origin.record);
  const settled = origin.unchanged
    ? fields
    : framedChangedRecord(expression, fields, call, (record) => recordFields(record));
  return fieldValues(settled).some((value) => converted(value, [], call, words));
}

/**
 * A record a native call builds or copies, or a conditional chooses, holds what any value it is made
 * of may; where none is an Error the form is read as no record, and its entries are read on.
 */
function formWords(
  expression: Expression,
  call: NewExpression,
  words: ParameterWords,
): true | undefined {
  const form = framedFormRecord(expression, call, (record) => recordFields(record));
  return form !== undefined && fieldValues(form).some((value) => converted(value, [], call, words))
    ? true
    : undefined;
}

/** Every value a record's fields may hold. */
function fieldValues(fields: RecordFields): readonly Expression[] {
  return [...[...fields.named.values()].flat(), ...fields.unknown];
}

/** Definite later string fields replace earlier record entries, including literal spreads. */
function recordFields(
  record: ObjectLiteralExpression,
  outer: ReadonlySet<Node> = new Set(),
): RecordFields {
  const pending: RecordField[] = record.properties.toReversed().map((property) => {
    const ancestors = new Set<Node>([...outer, record]);
    return { property, ancestors };
  });
  const entries: RecordEntries = { fields: new Map(), getters: new Map(), unknown: [] };
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const { property, ancestors } = at;
    if (isSpreadAssignment(property)) {
      spreadRecord(property, ancestors, { pending, entries });
      continue;
    }
    const values = recordFieldValues(property, entries);
    if (values === undefined) continue;
    const name = writtenArrayKey(property.name);
    if (name === undefined) entries.unknown.push(...values);
    else entries.fields.set(name, values);
  }
  return { named: entries.fields, unknown: entries.unknown };
}

/**
 * A saved literal spread contributes its fields at its copy position: an unchanged one as written,
 * a possibly changed one as it may be there (`framedChangedRecord`).
 */
function spreadRecord(
  property: SpreadAssignment,
  ancestors: ReadonlySet<Node>,
  record: { readonly pending: RecordField[]; readonly entries: RecordEntries },
): void {
  const source = framedRecordOrigin(property.expression, property);
  if (source === undefined) {
    const form = framedFormRecord(property.expression, property, (each) =>
      ancestors.has(each) ? { named: new Map(), unknown: [] } : recordFields(each, ancestors),
    );
    if (form !== undefined) record.entries.unknown.push(...form.unknown);
    return;
  }
  if (ancestors.has(source.record)) return;
  const next = new Set([...ancestors, source.record]);
  if (source.unchanged) {
    for (const child of source.record.properties.toReversed())
      record.pending.push({ property: child, ancestors: next });
    return;
  }
  const copied = framedChangedRecord(
    property.expression,
    recordFields(source.record, next),
    property,
    (each) => recordFields(each, next),
  );
  for (const [key, values] of copied.named) {
    record.entries.fields.set(key, values);
    record.entries.getters.delete(key);
  }
  record.entries.unknown.push(...copied.unknown);
}

/**
 * What an entry supplies the record's conversion: direct values and shorthand fields their own; a
 * getter, which the native constructor invokes, each value it returns; a setter the getter of its
 * name it pairs with in the same literal, or nothing, alone.
 */
function recordFieldValues(
  property: Exclude<ObjectLiteralExpression['properties'][number], SpreadAssignment>,
  entries: RecordEntries,
): readonly Expression[] | undefined {
  if (prototypeSetter(property)) return undefined;
  const name = writtenArrayKey(property.name);
  const paired = name === undefined ? undefined : entries.getters.get(name);
  if (name !== undefined) entries.getters.delete(name);
  if (isPropertyAssignment(property)) return [property.initializer];
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return [property.name];
  if (isGetAccessorDeclaration(property)) {
    const values = returnedBy(property);
    if (name !== undefined) entries.getters.set(name, { literal: property.parent, values });
    return values;
  }
  if (!isSetAccessorDeclaration(property)) return undefined;
  if (paired?.literal !== property.parent) return [];
  if (name !== undefined) entries.getters.set(name, paired);
  return paired.values;
}

/**
 * Whether an entry is `__proto__: value` written by name, which sets the literal's prototype and holds
 * no own entry; a computed `['__proto__']` key and a shorthand `__proto__` are own entries.
 */
function prototypeSetter(property: ObjectLiteralExpression['properties'][number]): boolean {
  return (
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name) &&
    writtenArrayKey(property.name) === '__proto__'
  );
}

/** Required tuple positions and homogeneous array entries retain their written member paths. */
function typedEntries(value: Expression, words: ParameterWords): boolean {
  const selected = frameTypeOf(value);
  if (selected === undefined) return false;
  const indices = localArrayIterationKeys(selected.type, selected.keys) ?? ['0'];
  return indices.some(
    (index) => words.error(value, [index, '0']) || words.error(value, [index, '1']),
  );
}

/** Entry fields stay selected through literal arrays, aliases and source-visible array writes. */
function entryWords(
  value: Expression,
  keys: readonly string[],
  call: NewExpression,
  words: ParameterWords,
): boolean {
  if (keys.length > 0)
    return (
      converted(value, [...keys, '0'], call, words) || converted(value, [...keys, '1'], call, words)
    );
  return [0, 1].some((index) => {
    return selectedError(
      value,
      index,
      {
        error: (field, selected = []) => converted(field, selected, call, words),
        typed: (entry) => words.error(entry, [String(index)]),
      },
      call,
    );
  });
}

/** Values converted to USVString retain supplied words and the text of any written array elements. */
function converted(
  value: Expression,
  keys: readonly string[],
  call: NewExpression,
  words: ParameterWords,
): boolean {
  return words.error(value, keys) || (keys.length === 0 && arrayError(value, words, call));
}
