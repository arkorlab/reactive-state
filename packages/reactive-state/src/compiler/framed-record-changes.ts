import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameBinding, frameBindingOf } from './framed-bindings.ts';
import { framedHeldFields, framedHeldValues, type Held } from './framed-held-members.ts';
import {
  type CapturedRecord,
  type RecordFields,
  toRecordFields,
  withCapturedWrites,
} from './framed-record-captured-writes.ts';
import { framedRecordForm, type RecordForm } from './framed-record-forms.ts';
import { framedRecordOrigin } from './framed-record-origins.ts';
import { framedSourceValues } from './framed-sources.ts';

/** What a saved record may hold where a native conversion reads it, after possible changes. */

export type { RecordFields } from './framed-record-captured-writes.ts';

const NO_BLOCKED: ReadonlySet<FrameBinding> = new Set();

/** How a written record literal's own fields are read. */
type FieldsOf = (record: ObjectLiteralExpression) => RecordFields;

interface OriginEntry {
  readonly found: ReturnType<typeof framedRecordOrigin>;
}

interface AliasResolution {
  readonly records: readonly RecordFields[];
  readonly blocked: ReadonlySet<FrameBinding>;
}

interface RecordContext {
  readonly consumer: Node;
  readonly fieldsOf: FieldsOf;
  readonly aliases: Map<Identifier, readonly RecordFields[]>;
  readonly origins: Map<Identifier, OriginEntry>;
  readonly forms: Map<FrameBinding, readonly RecordFields[]>;
  readonly seen: ReadonlySet<FrameBinding>;
}

interface ReplacementReading extends RecordContext {
  readonly replacements: Map<Expression, AliasResolution>;
}

interface RecordReading extends ReplacementReading {
  readonly name: Identifier;
  readonly fields: RecordFields;
  readonly point: Node;
}

const NO_FIELDS: RecordFields = { named: new Map(), unknown: [] };

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
  return toRecordFields(
    changedRecord(name, fields, point, {
      consumer: point,
      fieldsOf: cachedFields(fieldsOf),
      aliases: new Map(),
      origins: new Map(),
      forms: new Map(),
      seen: new Set(),
    }).captured,
  );
}

/**
 * What a record the compile follows to no literal may hold where `point` reads it: one a native
 * call builds or copies, a conditional or a nullish default chooses, or a variable holds of one —
 * what any value it is made of may hold, and what is written into the variable and assigned to it.
 * The fields keep no definite name: the form decides what it copies at run time. Nothing for a value
 * that is no such form, whose answer is not followed.
 */
export function framedFormRecord(
  expression: Expression,
  point: Node,
  fieldsOf: FieldsOf,
): RecordFields | undefined {
  const value = unwrapped(expression);
  if (!isIdentifier(value) && !isForm(value)) return undefined;
  const reading: ReplacementReading = {
    consumer: point,
    fieldsOf: cachedFields(fieldsOf),
    aliases: new Map(),
    origins: new Map(),
    forms: new Map(),
    seen: new Set(),
    replacements: new Map(),
  };
  const records: RecordFields[] = [];
  if (isIdentifier(value))
    appendNamedRecords(value, reading, { records, blocked: new Set() }, false);
  else records.push(...replacementRecords(value, reading).records);
  const merged = unionFields(records);
  const unknown = new Set<Expression>(merged.unknown);
  for (const values of merged.named.values()) addExpressions(unknown, values);
  return { named: new Map(), unknown: [...unknown] };
}

/** Resolves a variable's reachable fields while guarding cyclic record-alias assignments. */
function changedRecord(
  name: Identifier,
  fields: RecordFields,
  point: Node,
  context: RecordContext,
): { readonly captured: CapturedRecord; readonly blocked: ReadonlySet<FrameBinding> } {
  const whole = framedHeldValues(name, [], point);
  const written = framedHeldFields(name, point);
  if (whole === undefined || written === undefined) {
    return {
      captured: { named: fields.named, optional: new Map(), unknown: fields.unknown },
      blocked: NO_BLOCKED,
    };
  }
  const binding = frameBindingOf(name)?.binding;
  const seen = binding === undefined ? context.seen : new Set([...context.seen, binding]);
  const reading: RecordReading = {
    ...context,
    name,
    fields,
    point,
    replacements: new Map(),
    seen,
  };
  const unknown = new Set<Expression>(written.unknown.map((each) => each.value));
  if (whole.initial !== undefined) addExpressions(unknown, fields.unknown);
  const keys = new Set(fields.named.keys());
  for (const each of written.names) keys.add(each);
  const blocked = new Set<FrameBinding>();
  addWholeReplacements(whole.held, reading, { keys, unknown, blocked });
  const keepsNamed = whole.initial !== undefined && whole.held.length === 0;
  return {
    captured: collectKeyFields(keys, keepsNamed, reading, { unknown, blocked }),
    blocked,
  };
}

/** Collects deduplicated values per candidate key, separating definite and optional names. */
function collectKeyFields(
  keys: ReadonlySet<string>,
  keepsNamed: boolean,
  reading: RecordReading,
  state: { readonly unknown: Set<Expression>; readonly blocked: Set<FrameBinding> },
): CapturedRecord {
  const named = new Map<string, readonly Expression[]>();
  const optional = new Map<string, readonly Expression[]>();
  for (const key of keys) {
    const values = keyFieldValues(key, reading, state.blocked);
    if (values === undefined) continue;
    if (keepsNamed && reading.fields.named.has(key)) named.set(key, values);
    else optional.set(key, values);
  }
  return { named, optional, unknown: [...state.unknown] };
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

/** Memoizes record-origin lookups per alias identifier for the fixed consumer point. */
function cachedOrigin(
  value: Identifier,
  reading: ReplacementReading,
): ReturnType<typeof framedRecordOrigin> {
  const existing = reading.origins.get(value);
  if (existing !== undefined) return existing.found;
  const found = framedRecordOrigin(value, reading.consumer, true);
  reading.origins.set(value, { found });
  return found;
}

/** Includes named keys and unread-key values from reachable whole-record replacements. */
function addWholeReplacements(
  replacements: readonly Held[],
  reading: RecordReading,
  state: {
    readonly keys: Set<string>;
    readonly unknown: Set<Expression>;
    readonly blocked: Set<FrameBinding>;
  },
): void {
  for (const each of replacements) {
    if (each.keys.length > 0) continue;
    const resolved = replacementRecords(each.value, reading);
    addBindings(state.blocked, resolved.blocked);
    for (const record of resolved.records) {
      for (const key of record.named.keys()) state.keys.add(key);
      addExpressions(state.unknown, record.unknown);
    }
  }
}

/** Collects the initial and written values a single named field may hold at `point`. */
function keyFieldValues(
  key: string,
  reading: RecordReading,
  blocked: Set<FrameBinding>,
): readonly Expression[] | undefined {
  const held = framedHeldValues(reading.name, [key], reading.point);
  if (held === undefined) return undefined;
  const values = new Set<Expression>(
    held.initial === undefined ? [] : (reading.fields.named.get(key) ?? []),
  );
  for (const each of held.held) addExpressions(values, heldFieldValues(each, reading, blocked));
  return [...values];
}

/** What a held value puts in the field: itself, or what an assigned record holds under its name. */
function heldFieldValues(
  held: Held,
  reading: RecordReading,
  blocked: Set<FrameBinding>,
): readonly Expression[] {
  if (held.keys.length === 0) return [held.value];
  const [key, ...rest] = held.keys;
  if (key === undefined || rest.length > 0) return [];
  const resolved = replacementRecords(held.value, reading);
  addBindings(blocked, resolved.blocked);
  const values = new Set<Expression>();
  for (const record of resolved.records) addExpressions(values, record.named.get(key) ?? []);
  return [...values];
}

/**
 * Reads and caches source-written literals and record aliases reachable from an expression. An
 * `operand` is read as what a native form copies: where it is no record, a list's elements and any
 * other value are what it may hold.
 */
function replacementRecords(
  expression: Expression,
  reading: ReplacementReading,
  operand = false,
): AliasResolution {
  const existing = reading.replacements.get(expression);
  if (existing !== undefined) return existing;
  const pending: Expression[] = [expression];
  const records: RecordFields[] = [];
  const blocked = new Set<FrameBinding>();
  const visited = new Set<Node>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const value = unwrapped(current);
    if (visited.has(value)) continue;
    visited.add(value);
    appendReplacement(value, reading, { pending, records, blocked }, operand);
  }
  const resolved: AliasResolution = { records, blocked };
  reading.replacements.set(expression, resolved);
  return resolved;
}

/** Whether a value is a branch or a native form: what it answers is what its operands hold. */
function isForm(value: Expression): boolean {
  return framedSourceValues(value) !== undefined || framedRecordForm(value) !== undefined;
}

/** What one reachable value adds: the fields of a literal, an alias, a form's operands or itself. */
function appendReplacement(
  value: Expression,
  reading: ReplacementReading,
  into: {
    readonly pending: Expression[];
    readonly records: RecordFields[];
    readonly blocked: Set<FrameBinding>;
  },
  operand: boolean,
): void {
  const branched = framedSourceValues(value);
  const form = framedRecordForm(value);
  if (branched !== undefined) into.pending.push(...branched);
  else if (isObjectLiteralExpression(value)) into.records.push(reading.fieldsOf(value));
  else if (form !== undefined) appendFormRecords(form, reading, into.records, into.blocked);
  else if (isIdentifier(value)) appendNamedRecords(value, reading, into, operand);
  else if (operand) appendOperandValues(value, into.pending, into.records);
}

/** The records a native form's operands are, in the order it copies them or as alternatives. */
function appendFormRecords(
  form: RecordForm,
  reading: ReplacementReading,
  records: RecordFields[],
  blocked: Set<FrameBinding>,
): void {
  const parts = form.operands.map((each) => replacementRecords(each, reading, true));
  for (const part of parts) addBindings(blocked, part.blocked);
  if (!form.ordered) {
    for (const part of parts) records.push(...part.records);
    return;
  }
  records.push(copiedInOrder(parts));
}

/**
 * The record `Object.assign` makes of what it is given, a later definite field replacing an earlier
 * one as in a spread; an operand that may be one of several records replaces nothing for sure.
 */
function copiedInOrder(parts: readonly AliasResolution[]): RecordFields {
  const named = new Map<string, readonly Expression[]>();
  const unknown = new Set<Expression>();
  for (const part of parts) {
    const [only, ...more] = part.records;
    if (only !== undefined && more.length === 0) {
      for (const [key, values] of only.named) named.set(key, values);
      addExpressions(unknown, only.unknown);
      continue;
    }
    for (const record of part.records) {
      for (const values of record.named.values()) addExpressions(unknown, values);
      addExpressions(unknown, record.unknown);
    }
  }
  return { named, unknown: [...unknown] };
}

/** A list's elements are read in turn, a spread's source for its own; any other value is itself. */
function appendOperandValues(
  value: Expression,
  pending: Expression[],
  records: RecordFields[],
): void {
  if (!isArrayLiteralExpression(value)) {
    records.push({ named: new Map(), unknown: [value] });
    return;
  }
  for (const element of value.elements) {
    if (isOmittedExpression(element)) continue;
    pending.push(isSpreadElement(element) ? element.expression : element);
  }
}

/** A name is a record alias where its initializer is a literal, and a native form's where it is not. */
function appendNamedRecords(
  value: Identifier,
  reading: ReplacementReading,
  into: { readonly records: RecordFields[]; readonly blocked: Set<FrameBinding> },
  operand: boolean,
): void {
  if (cachedOrigin(value, reading) !== undefined) {
    appendAliasRecords(value, reading, into.records, into.blocked);
    return;
  }
  const binding = frameBindingOf(value)?.binding;
  if (binding === undefined) {
    if (operand) into.records.push({ named: new Map(), unknown: [value] });
    return;
  }
  const cached = operand ? reading.forms.get(binding) : undefined;
  if (cached !== undefined) {
    into.records.push(...cached);
    return;
  }
  if (reading.seen.has(binding)) {
    into.blocked.add(binding);
    return;
  }
  const inner: ReplacementReading = {
    ...reading,
    seen: new Set([...reading.seen, binding]),
    replacements: new Map(),
  };
  const end = formInitializer(value);
  const made = end === undefined ? undefined : replacementRecords(end, inner, operand);
  const base = made === undefined ? NO_FIELDS : unionFields(made.records);
  // Read where the whole record is read, so that one reading of the name serves every use of it.
  const changed = changedRecord(value, base, reading.consumer, inner);
  const records = [toRecordFields(changed.captured)];
  if (operand && made === undefined) records.push({ named: new Map(), unknown: [value] });
  const open = new Set(changed.blocked);
  addBindings(open, made?.blocked ?? NO_BLOCKED);
  open.delete(binding);
  addBindings(into.blocked, open);
  if (operand && open.size === 0) reading.forms.set(binding, records);
  into.records.push(...records);
}

/** What a name's constant initializer chain ends at, where it ends at a native form or a list. */
function formInitializer(name: Identifier): Expression | undefined {
  const seen = new Set<FrameBinding>();
  let value: Expression = name;
  while (isIdentifier(value)) {
    const reading = frameBindingOf(value);
    if (reading === undefined || reading.keys.length > 0 || seen.has(reading.binding))
      return undefined;
    seen.add(reading.binding);
    const initializer = reading.binding.initializer;
    if (initializer === undefined) return undefined;
    value = unwrapped(initializer);
  }
  return framedSourceValues(value) !== undefined ||
    framedRecordForm(value) !== undefined ||
    isArrayLiteralExpression(value)
    ? value
    : undefined;
}

/** The fields every record may hold: the name of any, with the values of each. */
function unionFields(records: readonly RecordFields[]): RecordFields {
  const named = new Map<string, readonly Expression[]>();
  const unknown = new Set<Expression>();
  for (const record of records) {
    for (const [key, values] of record.named) {
      const merged = new Set<Expression>(named.get(key));
      addExpressions(merged, values);
      named.set(key, [...merged]);
    }
    addExpressions(unknown, record.unknown);
  }
  return { named, unknown: [...unknown] };
}

/** Appends resolved alias records and any ancestor bindings that truncated cyclic walks. */
function appendAliasRecords(
  value: Expression,
  reading: ReplacementReading,
  records: RecordFields[],
  blocked: Set<FrameBinding>,
): void {
  const resolved = aliasRecords(value, reading);
  records.push(...resolved.records);
  addBindings(blocked, resolved.blocked);
}

/** Resolves a source-known record alias once unless an active ancestor binding truncates a cycle. */
function aliasRecords(value: Expression, reading: ReplacementReading): AliasResolution {
  if (!isIdentifier(value)) return { records: [], blocked: NO_BLOCKED };
  const cached = reading.aliases.get(value);
  if (cached !== undefined) return { records: cached, blocked: NO_BLOCKED };
  const origin = cachedOrigin(value, reading);
  if (origin === undefined) {
    reading.aliases.set(value, []);
    return { records: [], blocked: NO_BLOCKED };
  }
  const base = reading.fieldsOf(origin.record);
  if (origin.unchanged) {
    const unchanged = [base];
    reading.aliases.set(value, unchanged);
    return { records: unchanged, blocked: NO_BLOCKED };
  }
  const binding = frameBindingOf(value)?.binding;
  if (binding === undefined) return { records: [], blocked: NO_BLOCKED };
  if (reading.seen.has(binding)) return { records: [], blocked: new Set([binding]) };
  const resolved = changedRecord(value, base, value, {
    consumer: reading.consumer,
    fieldsOf: reading.fieldsOf,
    aliases: reading.aliases,
    origins: reading.origins,
    forms: reading.forms,
    seen: reading.seen,
  });
  const records = [
    withCapturedWrites(resolved.captured, {
      capture: value,
      binding,
      origin: origin.record,
      consumer: reading.consumer,
    }),
  ];
  const blocked = withoutBinding(resolved.blocked, binding);
  if (blocked.size === 0) reading.aliases.set(value, records);
  return { records, blocked };
}

/** Adds candidate expressions without duplicating AST nodes across shared replacement paths. */
function addExpressions(target: Set<Expression>, values: readonly Expression[]): void {
  for (const each of values) target.add(each);
}

/** Unions blocking ancestor bindings discovered during nested alias walks. */
function addBindings(target: Set<FrameBinding>, values: ReadonlySet<FrameBinding>): void {
  for (const each of values) target.add(each);
}

/** Drops `binding` itself once its own frame closes, leaving only strict ancestor dependencies. */
function withoutBinding(
  blocked: ReadonlySet<FrameBinding>,
  binding: FrameBinding,
): ReadonlySet<FrameBinding> {
  if (!blocked.has(binding)) return blocked;
  const remaining = new Set(blocked);
  remaining.delete(binding);
  return remaining;
}
