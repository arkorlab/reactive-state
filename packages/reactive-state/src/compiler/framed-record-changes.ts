import {
  type Expression,
  type Identifier,
  isIdentifier,
  isObjectLiteralExpression,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameBinding, frameBindingOf } from './framed-bindings.ts';
import { framedHeldFields, framedHeldValues, type Held } from './framed-held-members.ts';
import { framedRecordOrigin } from './framed-record-origins.ts';
import { framedSourceValues } from './framed-sources.ts';

/** What a saved record may hold where a native conversion reads it, after possible changes. */

/** A record's entries: each definite name's possible values, and values under unread names. */
export interface RecordFields {
  readonly named: ReadonlyMap<string, readonly Expression[]>;
  readonly unknown: readonly Expression[];
}

/** How a written record literal's own fields are read. */
type FieldsOf = (record: ObjectLiteralExpression) => RecordFields;

interface RecordReading {
  readonly name: Identifier;
  readonly fields: RecordFields;
  readonly point: Node;
  readonly fieldsOf: FieldsOf;
  readonly seen: ReadonlySet<FrameBinding>;
}

/**
 * What a possibly changed saved record may hold where `point` reads it: each field its literal wrote,
 * unless a definite earlier change replaced it, and what code wrote into its fields or assigned to
 * its variable since (`framedHeldValues`) — so a write of another field keeps the rest. A field only
 * a write names, and every field once the variable may hold another object, may be there or not.
 */
export function framedChangedRecord(
  expression: Expression,
  fields: RecordFields,
  point: Node,
  fieldsOf: FieldsOf,
): RecordFields {
  const name = unwrapped(expression);
  if (!isIdentifier(name)) return fields;
  return changedRecord(name, fields, point, { fieldsOf: cachedFields(fieldsOf), seen: new Set() });
}

/** Resolves a variable's reachable fields while guarding cyclic record-alias assignments. */
function changedRecord(
  name: Identifier,
  fields: RecordFields,
  point: Node,
  context: { readonly fieldsOf: FieldsOf; readonly seen: ReadonlySet<FrameBinding> },
): RecordFields {
  const whole = framedHeldValues(name, [], point);
  const written = framedHeldFields(name, point);
  if (whole === undefined || written === undefined) return fields;
  const binding = frameBindingOf(name)?.binding;
  const seen = binding === undefined ? context.seen : new Set([...context.seen, binding]);
  const reading: RecordReading = { name, fields, point, fieldsOf: context.fieldsOf, seen };
  const named = new Map<string, readonly Expression[]>();
  const unknown = written.unknown.map((each) => each.value);
  if (whole.initial !== undefined) unknown.push(...fields.unknown);
  const keys = new Set(fields.named.keys());
  for (const each of written.names) keys.add(each);
  addWholeReplacements(whole.held, reading, keys, unknown);
  const keepsNamed = whole.initial !== undefined && whole.held.length === 0;
  for (const key of keys) {
    const values = keyFieldValues(key, reading);
    if (values === undefined) continue;
    if (keepsNamed && fields.named.has(key)) named.set(key, values);
    else unknown.push(...values);
  }
  return { named, unknown };
}

/** Memoizes literal field readings across whole-record and per-key lookups. */
function cachedFields(fieldsOf: FieldsOf): FieldsOf {
  const known = new Map<ObjectLiteralExpression, RecordFields>();
  return (record) => {
    const existing = known.get(record);
    if (existing !== undefined) return existing;
    const read = fieldsOf(record);
    known.set(record, read);
    return read;
  };
}

/** Includes named keys and unread-key values from reachable whole-record replacements. */
function addWholeReplacements(
  replacements: readonly Held[],
  reading: RecordReading,
  keys: Set<string>,
  unknown: Expression[],
): void {
  for (const each of replacements) {
    if (each.keys.length > 0) continue;
    for (const record of replacementRecords(each.value, reading)) {
      for (const key of record.named.keys()) keys.add(key);
      unknown.push(...record.unknown);
    }
  }
}

/** Collects the initial and written values a single named field may hold at `point`. */
function keyFieldValues(key: string, reading: RecordReading): readonly Expression[] | undefined {
  const held = framedHeldValues(reading.name, [key], reading.point);
  if (held === undefined) return undefined;
  const values = held.initial === undefined ? [] : [...(reading.fields.named.get(key) ?? [])];
  for (const each of held.held) values.push(...heldFieldValues(each, reading));
  return values;
}

/** What a held value puts in the field: itself, or what an assigned record holds under its name. */
function heldFieldValues(held: Held, reading: RecordReading): readonly Expression[] {
  if (held.keys.length === 0) return [held.value];
  const [key, ...rest] = held.keys;
  if (key === undefined || rest.length > 0) return [];
  const values: Expression[] = [];
  for (const record of replacementRecords(held.value, reading)) {
    values.push(...(record.named.get(key) ?? []));
  }
  return values;
}

/** Reads each source-written literal or record alias reachable from an assigned expression. */
function replacementRecords(
  expression: Expression,
  reading: RecordReading,
): readonly RecordFields[] {
  const pending: Expression[] = [expression];
  const records: RecordFields[] = [];
  const visited = new Set<Node>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const value = unwrapped(current);
    if (visited.has(value)) continue;
    visited.add(value);
    const branched = framedSourceValues(value);
    if (branched !== undefined) pending.push(...branched);
    else if (isObjectLiteralExpression(value)) records.push(reading.fieldsOf(value));
    else records.push(...aliasRecords(value, reading));
  }
  return records;
}

/** Resolves a source-known record alias at its assignment site and at the consumer read. */
function aliasRecords(value: Expression, reading: RecordReading): readonly RecordFields[] {
  const origin = framedRecordOrigin(value, reading.point, true);
  if (origin === undefined) return [];
  const base = reading.fieldsOf(origin.record);
  if (origin.unchanged) return [base];
  if (!isIdentifier(value)) return [];
  const binding = frameBindingOf(value)?.binding;
  if (binding === undefined || reading.seen.has(binding)) return [];
  const nested = { fieldsOf: reading.fieldsOf, seen: reading.seen };
  return [
    changedRecord(value, base, value, nested),
    changedRecord(value, base, reading.point, nested),
  ];
}
