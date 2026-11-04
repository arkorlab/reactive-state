import {
  type Expression,
  isIdentifier,
  isObjectLiteralExpression,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedHeldFields, framedHeldValues, type Held } from './framed-held-members.ts';

/** What a saved record may hold where a native conversion reads it, after possible changes. */

/** A record's entries: each definite name's possible values, and values under unread names. */
export interface RecordFields {
  readonly named: ReadonlyMap<string, readonly Expression[]>;
  readonly unknown: readonly Expression[];
}

/** How a written record literal's own fields are read. */
type FieldsOf = (record: ObjectLiteralExpression) => RecordFields;

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
  const whole = framedHeldValues(name, [], point);
  const written = framedHeldFields(name, point);
  if (whole === undefined || written === undefined) return fields;
  const named = new Map<string, readonly Expression[]>();
  const unknown = written.unknown.map((each) => each.value);
  if (whole.initial !== undefined) unknown.push(...fields.unknown);
  const keys = new Set(fields.named.keys());
  for (const each of written.names) keys.add(each);
  for (const key of keys) {
    const held = framedHeldValues(name, [key], point);
    if (held === undefined) continue;
    const values = held.initial === undefined ? [] : [...(fields.named.get(key) ?? [])];
    for (const each of held.held) values.push(...heldFieldValues(each, fieldsOf));
    if (whole.initial !== undefined && fields.named.has(key)) named.set(key, values);
    else unknown.push(...values);
  }
  return { named, unknown };
}

/** What a held value puts in the field: itself, or what an assigned literal holds under its name. */
function heldFieldValues(held: Held, fieldsOf: FieldsOf): readonly Expression[] {
  if (held.keys.length === 0) return [held.value];
  const [key, ...rest] = held.keys;
  const value = unwrapped(held.value);
  if (key === undefined || rest.length > 0 || !isObjectLiteralExpression(value)) return [];
  const fields = fieldsOf(value);
  return [...(fields.named.get(key) ?? []), ...fields.unknown];
}
