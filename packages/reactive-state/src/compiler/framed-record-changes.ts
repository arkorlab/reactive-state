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
import {
  addExpressions,
  alternativesOf,
  copiedInOrder,
  formInitializer,
  isForm,
  NO_FIELDS,
  unionFields,
} from './framed-record-merges.ts';
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
  readonly forms: Map<FrameBinding, Map<Node, readonly RecordFields[]>>;
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
  if (isIdentifier(value)) appendNamedRecords(value, reading, { records, blocked: new Set() });
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
 * expression `copiedAt` a native form's call is read as what the form copies: where it is no
 * record, a list's elements and any other value are what it may hold.
 */
function replacementRecords(
  expression: Expression,
  reading: ReplacementReading,
  copiedAt?: Node,
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
    appendReplacement(value, reading, { pending, records, blocked }, copiedAt);
  }
  const resolved: AliasResolution = { records, blocked };
  reading.replacements.set(expression, resolved);
  return resolved;
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
  copiedAt: Node | undefined,
): void {
  const branched = framedSourceValues(value);
  const form = framedRecordForm(value);
  if (branched !== undefined && copiedAt !== undefined && alternativesOf(value, branched) > 1)
    appendAlternatives(value, branched, reading, { ...into, copiedAt });
  else if (branched !== undefined) into.pending.push(...branched);
  else if (isObjectLiteralExpression(value)) into.records.push(reading.fieldsOf(value));
  else if (form !== undefined) appendFormRecords(form, reading, into.records, into.blocked);
  else if (isIdentifier(value)) appendNamedRecords(value, reading, into, copiedAt);
  else if (copiedAt !== undefined) appendOperandValues(value, into.pending, into.records);
}

/**
 * The record an operand makes where it is chosen among alternatives: a field is definite only where
 * every alternative defines it, and holds what any does; an alternative that does not define it, or
 * makes no record, leaves it possible.
 */
function appendAlternatives(
  value: Expression,
  branches: readonly Expression[],
  reading: ReplacementReading,
  into: {
    readonly records: RecordFields[];
    readonly blocked: Set<FrameBinding>;
    readonly copiedAt: Node;
  },
): void {
  const parts = branches.map((each) => replacementRecords(each, reading, into.copiedAt));
  for (const part of parts) addBindings(into.blocked, part.blocked);
  const made = parts.map((part) => unionFields(part.records));
  if (alternativesOf(value, branches) > branches.length) made.push(NO_FIELDS);
  into.records.push(unionFields(made));
}

/** The records a native form's operands are, in the order it copies them or as alternatives. */
function appendFormRecords(
  form: RecordForm,
  reading: ReplacementReading,
  records: RecordFields[],
  blocked: Set<FrameBinding>,
): void {
  const parts = form.operands.map((each) => replacementRecords(each, reading, form.node));
  for (const part of parts) addBindings(blocked, part.blocked);
  if (!form.ordered) {
    for (const part of parts) records.push(...part.records);
    return;
  }
  records.push(copiedInOrder(parts));
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

/**
 * A name is a record alias where its initializer is a literal, and a native form's where it is not.
 * Read `copiedAt` a form's call, it is copied: what it held there is in the copy, and what it holds
 * where the whole record is read adds to it, so that a write to it after the copy removes nothing.
 */
function appendNamedRecords(
  value: Identifier,
  reading: ReplacementReading,
  into: { readonly records: RecordFields[]; readonly blocked: Set<FrameBinding> },
  copiedAt?: Node,
): void {
  if (copiedAt === undefined) {
    readNamedRecords(value, reading, into);
    return;
  }
  const records: RecordFields[] = [];
  readNamedRecords(value, reading, { records, blocked: into.blocked }, copiedAt);
  into.records.push(unionFields(records));
}

/** The records a name holds, read where the whole record is and, where copied, where it was. */
function readNamedRecords(
  value: Identifier,
  reading: ReplacementReading,
  into: { readonly records: RecordFields[]; readonly blocked: Set<FrameBinding> },
  copiedAt?: Node,
): void {
  if (cachedOrigin(value, reading) !== undefined) {
    appendAliasRecords(value, reading, into.records, into.blocked);
    if (copiedAt !== undefined) appendCopiedRecord(value, copiedAt, reading, into);
    return;
  }
  const selected = frameBindingOf(value);
  if (selected === undefined) {
    if (copiedAt !== undefined) into.records.push({ named: new Map(), unknown: [value] });
    return;
  }
  const { binding } = selected;
  // A name a pattern takes apart shares its declaration with the others: only a whole one is cached.
  const cache =
    copiedAt !== undefined && selected.keys.length === 0
      ? cachedForms(reading, binding)
      : undefined;
  const cached = copiedAt === undefined ? undefined : cache?.get(copiedAt);
  if (cached !== undefined) into.records.push(...cached);
  else if (reading.seen.has(binding)) into.blocked.add(binding);
  else {
    const read = formRecords(value, binding, reading, copiedAt);
    addBindings(into.blocked, read.open);
    if (copiedAt !== undefined && read.open.size === 0) cache?.set(copiedAt, read.records);
    into.records.push(...read.records);
  }
}

/** What a name's form and the changes made to it hold, with the ancestors that cut the reading short. */
function formRecords(
  value: Identifier,
  binding: FrameBinding,
  reading: ReplacementReading,
  copiedAt?: Node,
): { readonly records: RecordFields[]; readonly open: Set<FrameBinding> } {
  const inner: ReplacementReading = {
    ...reading,
    seen: new Set([...reading.seen, binding]),
    replacements: new Map(),
  };
  const end = formInitializer(value);
  const made = end === undefined ? undefined : replacementRecords(end, inner, copiedAt);
  const base = made === undefined ? NO_FIELDS : unionFields(made.records);
  const open = new Set<FrameBinding>(made?.blocked);
  const points = copiedAt === undefined ? [reading.consumer] : [reading.consumer, copiedAt];
  const records: RecordFields[] = [];
  for (const point of points) {
    const changed = changedRecord(value, base, point, inner);
    records.push(toRecordFields(changed.captured));
    addBindings(open, changed.blocked);
  }
  if (copiedAt !== undefined && made === undefined)
    records.push({ named: new Map(), unknown: [value] });
  open.delete(binding);
  return { records, open };
}

/** The readings of a name made for each copy of it: those of one call are alike. */
function cachedForms(
  reading: ReplacementReading,
  binding: FrameBinding,
): Map<Node, readonly RecordFields[]> {
  const existing = reading.forms.get(binding);
  if (existing !== undefined) return existing;
  const made = new Map<Node, readonly RecordFields[]>();
  reading.forms.set(binding, made);
  return made;
}

/** What a literal-held record held where a form copied it: later writes to it are not in the copy. */
function appendCopiedRecord(
  value: Identifier,
  copiedAt: Node,
  reading: ReplacementReading,
  into: { readonly records: RecordFields[]; readonly blocked: Set<FrameBinding> },
): void {
  const origin = framedRecordOrigin(value, copiedAt, true);
  const selected = frameBindingOf(value);
  if (origin === undefined || selected === undefined) return;
  const base = reading.fieldsOf(origin.record);
  if (origin.unchanged) {
    into.records.push(base);
    return;
  }
  const { binding } = selected;
  const cache = selected.keys.length === 0 ? cachedForms(reading, binding) : undefined;
  const cached = cache?.get(copiedAt);
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
  const changed = changedRecord(value, base, copiedAt, inner);
  const record = toRecordFields(changed.captured);
  const open = withoutBinding(changed.blocked, binding);
  addBindings(into.blocked, open);
  if (open.size === 0) cache?.set(copiedAt, [record]);
  into.records.push(record);
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
