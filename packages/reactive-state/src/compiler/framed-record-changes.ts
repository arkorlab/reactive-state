import {
  type Expression,
  type Identifier,
  isIdentifier,
  isObjectLiteralExpression,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { type FrameBinding, frameBindingOf } from './framed-bindings.ts';
import { framedHeldFields, framedHeldValues, type Held } from './framed-held-members.ts';
import {
  framedHeldVariable,
  framedMemberWrites,
  type MemberWrite,
} from './framed-member-writes.ts';
import { framedRecordOrigin } from './framed-record-origins.ts';
import { framedSourceValues } from './framed-sources.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';

/** What a saved record may hold where a native conversion reads it, after possible changes. */

const NO_BLOCKED: ReadonlySet<FrameBinding> = new Set();

/** A record's entries: each definite name's possible values, and values under unread names. */
export interface RecordFields {
  readonly named: ReadonlyMap<string, readonly Expression[]>;
  readonly unknown: readonly Expression[];
}

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
  readonly seen: ReadonlySet<FrameBinding>;
}

interface RecordReading extends RecordContext {
  readonly name: Identifier;
  readonly fields: RecordFields;
  readonly point: Node;
  readonly replacements: Map<Expression, AliasResolution>;
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
  return changedRecord(name, fields, point, {
    consumer: point,
    fieldsOf: cachedFields(fieldsOf),
    aliases: new Map(),
    origins: new Map(),
    seen: new Set(),
  }).fields;
}

/** Resolves a variable's reachable fields while guarding cyclic record-alias assignments. */
function changedRecord(
  name: Identifier,
  fields: RecordFields,
  point: Node,
  context: RecordContext,
): { readonly fields: RecordFields; readonly blocked: ReadonlySet<FrameBinding> } {
  const whole = framedHeldValues(name, [], point);
  const written = framedHeldFields(name, point);
  if (whole === undefined || written === undefined) return { fields, blocked: NO_BLOCKED };
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
    fields: collectKeyFields(keys, keepsNamed, reading, { unknown, blocked }),
    blocked,
  };
}

/** Collects deduplicated values per candidate key, keeping only still-definite names in `named`. */
function collectKeyFields(
  keys: ReadonlySet<string>,
  keepsNamed: boolean,
  reading: RecordReading,
  state: { readonly unknown: Set<Expression>; readonly blocked: Set<FrameBinding> },
): RecordFields {
  const named = new Map<string, readonly Expression[]>();
  for (const key of keys) {
    const values = keyFieldValues(key, reading, state.blocked);
    if (values === undefined) continue;
    if (keepsNamed && reading.fields.named.has(key)) named.set(key, values);
    else addExpressions(state.unknown, values);
  }
  return { named, unknown: [...state.unknown] };
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
  reading: RecordReading,
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

/** Reads and caches source-written literals and record aliases reachable from an expression. */
function replacementRecords(expression: Expression, reading: RecordReading): AliasResolution {
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
    const branched = framedSourceValues(value);
    if (branched !== undefined) pending.push(...branched);
    else if (isObjectLiteralExpression(value)) records.push(reading.fieldsOf(value));
    else appendAliasRecords(value, reading, records, blocked);
  }
  const resolved: AliasResolution = { records, blocked };
  reading.replacements.set(expression, resolved);
  return resolved;
}

/** Appends resolved alias records and any ancestor bindings that truncated cyclic walks. */
function appendAliasRecords(
  value: Expression,
  reading: RecordReading,
  records: RecordFields[],
  blocked: Set<FrameBinding>,
): void {
  const resolved = aliasRecords(value, reading);
  records.push(...resolved.records);
  addBindings(blocked, resolved.blocked);
}

/** Resolves a source-known record alias once unless an active ancestor binding truncates a cycle. */
function aliasRecords(value: Expression, reading: RecordReading): AliasResolution {
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
  const captured = changedRecord(value, base, value, {
    consumer: reading.consumer,
    fieldsOf: reading.fieldsOf,
    aliases: reading.aliases,
    origins: reading.origins,
    seen: reading.seen,
  });
  const records = [withCapturedWrites(captured.fields, value, binding, reading.consumer)];
  const blocked = withoutBinding(captured.blocked, binding);
  if (blocked.size === 0) reading.aliases.set(value, records);
  return { records, blocked };
}

/** Retains member writes on a captured alias that may run after assignment and before `consumer`. */
function withCapturedWrites(
  captured: RecordFields,
  capture: Identifier,
  binding: FrameBinding,
  consumer: Node,
): RecordFields {
  const holders = aliasHolders(binding);
  if (holders.size === 0) return captured;
  const writes = postCaptureWrites(capture, holders, consumer);
  if (writes.length === 0) return captured;
  const named = new Map<string, Set<Expression>>();
  for (const [key, values] of captured.named) named.set(key, new Set(values));
  const unknown = new Set<Expression>(captured.unknown);
  for (const write of writes) {
    const [first] = write.path;
    if (first === undefined) unknown.add(write.value);
    else addCapturedFieldWrite(first, write.value, named, unknown);
  }
  const settled = new Map<string, readonly Expression[]>();
  for (const [key, values] of named) settled.set(key, [...values]);
  return { named: settled, unknown: [...unknown] };
}

/** Appends a post-capture write to each named field still kept, or to `unknown` otherwise. */
function addCapturedFieldWrite(
  names: readonly string[],
  value: Expression,
  named: Map<string, Set<Expression>>,
  unknown: Set<Expression>,
): void {
  for (const key of names) {
    const existing = named.get(key);
    if (existing === undefined) unknown.add(value);
    else existing.add(value);
  }
}

/** Variable declarations along an alias's initializer chain whose object reference may be shared. */
function aliasHolders(binding: FrameBinding): ReadonlySet<VariableDeclaration> {
  const holders = new Set<VariableDeclaration>();
  let current: FrameBinding | undefined = binding;
  while (current !== undefined && isVariableDeclaration(current) && !holders.has(current)) {
    holders.add(framedHeldVariable(current));
    holders.add(current);
    current = nextInitializerBinding(current);
  }
  return holders;
}

/** Follows an identifier initializer to the declaration it aliases, if any. */
function nextInitializerBinding(declaration: VariableDeclaration): FrameBinding | undefined {
  if (declaration.initializer === undefined) return undefined;
  const initial = unwrapped(declaration.initializer);
  return isIdentifier(initial) ? frameBindingOf(initial)?.binding : undefined;
}

/** Member writes on `holders` that may execute after `capture` and still reach `consumer`. */
function postCaptureWrites(
  capture: Identifier,
  holders: ReadonlySet<VariableDeclaration>,
  consumer: Node,
): readonly MemberWrite[] {
  return framedMemberWrites(capture.getSourceFile()).filter((write) => {
    return (
      holders.has(write.holder) &&
      write.path.length === 1 &&
      reachesConsumer(write.node, write.holder, consumer) &&
      runsAfterCapture(write.node, capture, write.holder)
    );
  });
}

/** Whether a member write can run before `consumer` evaluates. */
function reachesConsumer(write: Node, holder: VariableDeclaration, consumer: Node): boolean {
  if (!framedPossibleBranch(write)) return false;
  const owner = executionOwner(consumer);
  return (
    executionOwner(write) !== owner ||
    write.pos < consumer.end ||
    destructuredFirst(write, consumer) ||
    repeatedFrameRead(write, consumer, holder, owner)
  );
}

/** Whether a member write is not confined strictly before the alias capture evaluates. */
function runsAfterCapture(write: Node, capture: Identifier, holder: VariableDeclaration): boolean {
  const owner = executionOwner(capture);
  return (
    executionOwner(write) !== owner ||
    write.end > capture.end ||
    destructuredFirst(capture, write) ||
    repeatedFrameRead(write, capture, holder, owner)
  );
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
